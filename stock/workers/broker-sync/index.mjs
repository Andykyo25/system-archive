// broker-sync:唯讀地把富邦證券庫存快照寫進 Supabase(broker_inventory_snapshot),
// 供 v_broker_recon 與 holdings_transactions 對帳。Railway cron 每個交易日收盤後跑一次。
//
// 只呼叫 sdk.accounting.*,不下單、不碰 holdings_transactions:
//   主線(失敗 = 整次失敗):inventories、unrealizedGainsAndLoses → broker_inventory_snapshot
//   附加(失敗不阻止庫存快照寫入,但整次標 success=false、exit 1,/health 會亮):
//     querySettlement('3d')      → broker_settlement        以 (帳號, 查詢日) 為鍵,新抓到的覆蓋舊的
//     realizedGainsAndLoses      → broker_realized_snapshot 券商現況鏡像,整表取代;查詢不完整時不取代(不誤刪舊資料)
//   不查 bankRemain:官方限定交割銀行為台北富邦銀行 / LINE Bank,Andy 的帳戶不是。
//
// PROBE_MARKET=1(暫時性,預設關):同步寫入「之後」才執行,用現有 key 實際打行情 REST 端點
// (日 K / 分 K / 三大法人 / 集保 / ETF 持股,各抓近期與最早期),只回報 ok / 筆數 / 欄位名 / 日期範圍 /
// 耗時(不含數值)到 fetch_log.error。用來確認這把 key 有沒有行情權限與歷史深度;失敗或逾時(90 秒)不影響同步結果。
//
// 日誌:每次執行先寫一筆 fetch_log(success=false,「尚未完成」),結束時改成實際結果。
// 所以程序被 kill / SDK 卡死時,/health 看到的是 danger,而不是沉默。
// source='broker-sync' 會自動出現在 v_data_health,web 不用改。
//
// DRY_RUN(預設開;只有 DRY_RUN=0 才寫快照):登入 + 查詢 + 記 fetch_log,不寫 DB 快照;
// 診斷摘要(只含欄位名與筆數,不含數值)放在 fetch_log.error。

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRealizedRows,
  buildSettlementRows,
  buildSnapshotRows,
  checkSnapshot,
  listOf,
  marketProbePlan,
  objOf,
  redact,
  snapshotDate,
  summarizeMarket,
  taipeiToday,
  withBackoff,
} from './lib.mjs';

const env = process.env;
const required = ['FUBON_ID', 'FUBON_API_KEY', 'FUBON_CERT_B64', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const DRY_RUN = env.DRY_RUN !== '0';
const ALLOW_EMPTY = env.ALLOW_EMPTY === '1';
const PROBE_MARKET = env.PROBE_MARKET === '1';
const SECRETS = [env.FUBON_ID, env.FUBON_API_KEY, env.FUBON_CERT_PASSWORD, env.FUBON_CERT_B64, env.SUPABASE_SERVICE_ROLE_KEY];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REST = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
// 舊式 service_role 是 JWT(eyJ…),要同時帶 Authorization;新式 sb_secret_… 只能帶 apikey。
const HEADERS = {
  apikey: KEY,
  'Content-Type': 'application/json',
  ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}),
};

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${REST}${path}`, {
    method,
    headers: prefer ? { ...HEADERS, Prefer: prefer } : HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

let sdk = null;
let tmpDir = null;

// PROBE_MARKET:用現有 key 實際打行情端點,回報權限 / 深度 / 欄位 / 耗時。整體 90 秒逾時(Dockerfile 180 秒硬砍前)。
async function runMarketProbe() {
  const out = [];
  const work = (async () => {
    let stock;
    try {
      sdk.initRealtime();
      stock = sdk.marketdata.restClient.stock;
    } catch (e) {
      out.push({ name: 'init', ok: false, message: String(e?.message ?? e).slice(0, 120) });
      return;
    }
    for (const p of marketProbePlan(taipeiToday())) {
      const t0 = Date.now();
      try {
        const res = p.fn === 'candles' ? await stock.historical.candles(p.args) : await stock.ownership[p.fn](p.args);
        out.push({ name: p.name, ...summarizeMarket(res), ms: Date.now() - t0 });
      } catch (e) {
        out.push({ name: p.name, ok: false, message: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t0 });
      }
      await sleep(1100); // 歷史行情上限 60 次 / 分
    }
  })();
  const timeout = new Promise((resolve) =>
    setTimeout(() => {
      out.push({ name: 'timeout', ok: false, message: 'probe exceeded 90 s' });
      resolve();
    }, 90_000),
  );
  await Promise.race([work, timeout]);
  return out;
}

async function sync() {
  const open = await sb('/v_holdings_current?select=symbol');

  // 憑證只在這次執行的 tmp 目錄裡存在,結束就刪;內容來自 base64 環境變數,不進 repo。
  const cert = Buffer.from(env.FUBON_CERT_B64, 'base64');
  if (cert.length < 200) throw new Error('FUBON_CERT_B64 is empty or not the base64 of a .pfx file');
  tmpDir = mkdtempSync(join(tmpdir(), 'fubon-'));
  const certPath = join(tmpDir, 'cert.pfx');
  writeFileSync(certPath, cert, { mode: 0o600 });

  const { FubonSDK } = createRequire(import.meta.url)('fubon-neo');
  sdk = new FubonSDK();
  const login = sdk.apikeyLogin(env.FUBON_ID, env.FUBON_API_KEY, certPath, env.FUBON_CERT_PASSWORD || undefined);
  if (!login?.isSuccess || !Array.isArray(login.data)) throw new Error(`login failed: ${login?.message ?? 'no response'}`);

  const rows = [];
  const invRaw = [];
  const unrRaw = [];
  const accounts = [];
  const settleRows = [];
  const realizedRows = [];
  const fields = {};
  const warnings = []; // 附加查詢 / 寫入失敗:庫存照寫,但整次標失敗(partial)
  let realizedComplete = true; // 每個股票帳戶的 realized 都查到,才可以整表取代
  // 附加查詢的失敗(SDK 回失敗、丟例外、欄位形狀不符)只進 warnings,不影響庫存主線。
  const aux = async (name, fn) => {
    try {
      await fn();
      return true;
    } catch (e) {
      warnings.push(`${name}: ${String(e?.message ?? e).slice(0, 80)}`);
      return false;
    }
  };
  for (const acct of login.data) {
    const acctNo = `${acct.branchNo}-${acct.account}`;
    // 官方查詢上限 5 次 / 秒;每筆之間空 250 ms,被流量控管再退避。
    const inv = listOf(await withBackoff(() => sdk.accounting.inventories(acct)));
    await sleep(250);
    if (!inv.ok) {
      accounts.push({ type: acct.accountType, skipped: inv.message.slice(0, 80) });
      continue;
    }
    const unr = listOf(await withBackoff(() => sdk.accounting.unrealizedGainsAndLoses(acct)));
    await sleep(250);
    if (!unr.ok) throw new Error(`unrealizedGainsAndLoses failed: ${unr.message}`);
    accounts.push({ type: acct.accountType, ok: true });
    invRaw.push(...inv.list);
    unrRaw.push(...unr.list);
    rows.push(...buildSnapshotRows(acctNo, inv.list, unr.list));

    await aux('querySettlement', async () => {
      const r = objOf(await withBackoff(() => sdk.accounting.querySettlement(acct, '3d')));
      if (!r.ok) throw new Error(r.message);
      fields.settlement_details = Object.keys(r.data?.details?.[0] ?? {});
      settleRows.push(...buildSettlementRows(acctNo, r.data));
    });
    await sleep(250);
    const realizedOk = await aux('realizedGainsAndLoses', async () => {
      const r = listOf(await withBackoff(() => sdk.accounting.realizedGainsAndLoses(acct)));
      if (!r.ok) throw new Error(r.message);
      fields.realized = Object.keys(r.list[0] ?? {});
      realizedRows.push(...buildRealizedRows(acctNo, r.list));
    });
    if (!realizedOk) realizedComplete = false;
    await sleep(250);
  }
  if (!accounts.some((a) => a.ok)) throw new Error(`no account answered inventories: ${JSON.stringify(accounts)}`);

  const verdict = checkSnapshot({ rowCount: rows.length, systemOpenCount: open.length, allowEmpty: ALLOW_EMPTY });
  if (!verdict.ok) throw new Error(verdict.reason);

  const date = snapshotDate(invRaw);
  const counts = { inventory: rows.length, settlement: settleRows.length, realized: realizedRows.length };
  if (DRY_RUN) {
    const diag = {
      date,
      accounts,
      inventory_rows: invRaw.length,
      unrealized_rows: unrRaw.length,
      snapshot_rows: rows.length,
      order_types: [...new Set(rows.map((r) => r.order_type))],
      cost_matched: rows.filter((r) => r.cost_price !== null).length,
      system_open_positions: open.length,
      inventory_fields: Object.keys(invRaw[0] ?? {}),
      odd_fields: Object.keys(invRaw[0]?.odd ?? {}),
      unrealized_fields: Object.keys(unrRaw[0] ?? {}),
      settlement_rows: settleRows.length,
      settlement_fields: fields.settlement_details ?? null,
      realized_rows: realizedRows.length,
      realized_fields: fields.realized ?? null,
      market_probe: PROBE_MARKET ? await runMarketProbe() : undefined,
      warnings,
    };
    return {
      ok: warnings.length === 0,
      counts,
      rows_written: 0,
      rows_skipped: rows.length,
      error: redact(`DRY_RUN ${warnings.length ? 'partial' : 'ok'}: ${JSON.stringify(diag)}`, SECRETS),
    };
  }

  const written = await sb('/rpc/replace_broker_snapshot', { method: 'POST', body: { p_date: date, p_rows: rows } });

  // 庫存已寫;以下任何一步失敗都只進 warnings。realized 是整表取代,查詢不完整就不能動它。
  if (settleRows.length) {
    const fetchedAt = new Date().toISOString();
    await aux('write broker_settlement', () =>
      sb('/broker_settlement?on_conflict=account_no,query_date', {
        method: 'POST',
        body: settleRows.map((r) => ({ snapshot_date: date, fetched_at: fetchedAt, ...r })),
        prefer: 'resolution=merge-duplicates',
      }),
    );
  }
  if (realizedComplete) {
    await aux('write broker_realized_snapshot', () =>
      sb('/rpc/replace_broker_realized', { method: 'POST', body: { p_date: date, p_rows: realizedRows } }),
    );
  }

  // 探測放在所有寫入之後:它再慢 / 再壞,都不會讓快照寫不進去。
  const marketProbe = PROBE_MARKET ? await runMarketProbe() : null;

  const ok = warnings.length === 0;
  const error = ok
    ? marketProbe
      ? redact(`PROBE market: ${JSON.stringify(marketProbe)}`, SECRETS).slice(0, 4000)
      : null
    : redact(`partial: ${warnings.join('; ')}`, SECRETS).slice(0, 300);
  return { ok, counts, rows_written: Number(written), rows_skipped: 0, error };
}

const [{ id: logId }] = await sb('/fetch_log?select=id', {
  method: 'POST',
  prefer: 'return=representation',
  body: { source: 'broker-sync', success: false, error: 'run started, not finished' },
});
const finishLog = (patch) =>
  sb(`/fetch_log?id=eq.${logId}`, { method: 'PATCH', body: { finished_at: new Date().toISOString(), ...patch } });

let code = 0;
try {
  const { ok, counts, ...patch } = await sync();
  await finishLog({ success: ok, ...patch });
  if (!ok) {
    code = 1;
    console.error(`broker-sync partial: ${patch.error}`);
  }
  console.log(JSON.stringify({ ok, dry_run: DRY_RUN, rows_written: patch.rows_written, rows_skipped: patch.rows_skipped, counts }));
} catch (e) {
  code = 1;
  const message = redact(e?.message ?? e, SECRETS).slice(0, 300);
  console.error(`broker-sync failed: ${message}`);
  try {
    await finishLog({ success: false, rows_written: 0, rows_skipped: 0, error: message });
  } catch (logErr) {
    console.error(`could not update fetch_log: ${redact(logErr?.message ?? logErr, SECRETS).slice(0, 200)}`);
  }
} finally {
  try {
    sdk?.logout();
  } catch {
    // 登出失敗不影響結果;程序結束後 session 自然失效
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(code);
