// broker-sync:唯讀地把富邦證券庫存快照寫進 Supabase(broker_inventory_snapshot),
// 供 v_broker_recon 與 holdings_transactions 對帳。Railway cron 每個交易日收盤後跑一次。
//
// 只呼叫 sdk.accounting.*(庫存 / 未實現損益),不下單、不碰 holdings_transactions。
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
import { buildSnapshotRows, checkSnapshot, listOf, redact, snapshotDate, withBackoff } from './lib.mjs';

const env = process.env;
const required = ['FUBON_ID', 'FUBON_API_KEY', 'FUBON_CERT_B64', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const DRY_RUN = env.DRY_RUN !== '0';
const ALLOW_EMPTY = env.ALLOW_EMPTY === '1';
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
  for (const acct of login.data) {
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
    rows.push(...buildSnapshotRows(`${acct.branchNo}-${acct.account}`, inv.list, unr.list));
  }
  if (!accounts.some((a) => a.ok)) throw new Error(`no account answered inventories: ${JSON.stringify(accounts)}`);

  const verdict = checkSnapshot({ rowCount: rows.length, systemOpenCount: open.length, allowEmpty: ALLOW_EMPTY });
  if (!verdict.ok) throw new Error(verdict.reason);

  const date = snapshotDate(invRaw);
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
    };
    return { rows_written: 0, rows_skipped: rows.length, error: `DRY_RUN ok: ${JSON.stringify(diag)}` };
  }

  const written = await sb('/rpc/replace_broker_snapshot', { method: 'POST', body: { p_date: date, p_rows: rows } });
  return { rows_written: Number(written), rows_skipped: 0, error: null };
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
  const result = await sync();
  await finishLog({ success: true, ...result });
  console.log(JSON.stringify({ ok: true, dry_run: DRY_RUN, rows_written: result.rows_written, rows_skipped: result.rows_skipped }));
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
