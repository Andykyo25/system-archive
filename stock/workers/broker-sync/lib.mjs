// 純函式:SDK 回傳 → 快照列。不碰 SDK / 網路 / DB,方便單元測試(lib.test.mjs)。
// 欄位名稱依官方 fubon-neo 2.4.0 的 trade.d.ts(Inventory / unrealizedGainsAndLoses);
// 回傳形狀一變就丟錯,讓 fetch_log 變 danger,而不是靜默寫入錯誤的快照。

const SYMBOL_RE = /^[0-9A-Za-z]{4,6}$/;

// 必填欄位缺漏或非數字 → 丟錯;給了 dflt 的欄位缺漏時用 dflt。
function num(v, what, dflt) {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing ${what}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`non-numeric ${what}`);
  return n;
}

function int(v, what, dflt) {
  const n = num(v, what, dflt);
  if (!Number.isInteger(n)) throw new Error(`non-integer ${what}: ${n}`);
  return n;
}

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

export function toIsoDate(s) {
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// 快照日期:優先用券商回傳的 date,沒有才用台北今天。
export function snapshotDate(inventoryRows, now = new Date()) {
  for (const r of inventoryRows ?? []) {
    const d = toIsoDate(r?.date);
    if (d) return d;
  }
  return taipeiToday(now);
}

// SDK 的 Response<T>:成功 / 「查無資料」都算有結果(空帳戶可能回後者),其餘視為失敗。
export function listOf(res) {
  if (res?.isSuccess) return { ok: true, list: Array.isArray(res.data) ? res.data : [] };
  const message = String(res?.message ?? 'no response');
  if (/查無|無資料|no data/i.test(message)) return { ok: true, list: [] };
  return { ok: false, message };
}

// inventories + unrealizedGainsAndLoses → broker_inventory_snapshot 的列。
// 以 (symbol, orderType) 合併重複列;整股 todayQty 與零股 odd.todayQty 分開存;
// 成本價用 unrealized 的 costPrice 依股數加權。兩邊 orderType 對不上時 cost_price 為 null。
export function buildSnapshotRows(accountNo, inventories, unrealized) {
  const costs = new Map();
  for (const u of unrealized ?? []) {
    const key = `${u.stockNo}|${u.orderType}`;
    const c = costs.get(key) ?? { value: 0, qty: 0, pnl: 0, rows: [] };
    const q = num(u.todayQty, 'unrealized.todayQty');
    c.value += num(u.costPrice, 'costPrice') * q;
    c.qty += q;
    c.pnl += num(u.unrealizedProfit, 'unrealizedProfit', 0) - num(u.unrealizedLoss, 'unrealizedLoss', 0);
    c.rows.push(u);
    costs.set(key, c);
  }

  const out = new Map();
  for (const r of inventories ?? []) {
    const symbol = String(r.stockNo ?? '');
    if (!SYMBOL_RE.test(symbol)) throw new Error(`unexpected stockNo: ${symbol.slice(0, 10)}`);
    const orderType = String(r.orderType ?? '');
    const board = int(r.todayQty, 'todayQty');
    const odd = int(r.odd?.todayQty, 'odd.todayQty', 0);
    if (board + odd === 0) continue;
    const tradable = r.tradableQty === undefined || r.tradableQty === null ? null : int(r.tradableQty, 'tradableQty');

    const key = `${symbol}|${orderType}`;
    const cur = out.get(key);
    if (cur) {
      cur.board_qty += board;
      cur.odd_qty += odd;
      if (tradable !== null) cur.tradable_qty = (cur.tradable_qty ?? 0) + tradable;
      cur.raw.inventory.push(r);
      continue;
    }
    const c = costs.get(key);
    out.set(key, {
      account_no: accountNo,
      symbol,
      order_type: orderType,
      board_qty: board,
      odd_qty: odd,
      tradable_qty: tradable,
      cost_price: c && c.qty > 0 ? round(c.value / c.qty, 4) : null,
      unrealized_pnl: c ? round(c.pnl, 2) : null,
      raw: { inventory: [r], unrealized: c ? c.rows : [] },
    });
  }
  return [...out.values()];
}

// 可空欄位:undefined / null / '' → null;其餘必須是有限數字。
function optNum(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`non-numeric ${what}`);
  return n;
}

// 帳務查詢的 data 是單一物件(querySettlement);「查無資料」算成功但沒有資料。
export function objOf(res) {
  if (res?.isSuccess) return { ok: true, data: res.data ?? null };
  const message = String(res?.message ?? 'no response');
  if (/查無|無資料|no data/i.test(message)) return { ok: true, data: null };
  return { ok: false, message };
}

// querySettlement → broker_settlement 的列,以「查詢日」為鍵。沒有交易的日子金額欄全空,照存(欄位為 null)。
// 官方 Node.js 文件範例把 settlement_date 寫成 snake_case、其餘是 camelCase,疑為文件筆誤 → 兩種拼法都收。
export function buildSettlementRows(accountNo, data) {
  if (!data) return [];
  if (!Array.isArray(data.details)) throw new Error('unexpected settlement shape: no details array');
  const out = new Map();
  for (const d of data.details) {
    const queryDate = toIsoDate(d?.date);
    if (!queryDate) throw new Error(`unexpected settlement date: ${String(d?.date).slice(0, 12)}`);
    const rawSettle = d.settlementDate ?? d.settlement_date;
    const settlementDate = rawSettle ? toIsoDate(rawSettle) : null;
    if (rawSettle && !settlementDate) throw new Error(`unexpected settlementDate: ${String(rawSettle).slice(0, 12)}`);
    out.set(queryDate, {
      account_no: accountNo,
      query_date: queryDate,
      settlement_date: settlementDate,
      buy_value: optNum(d.buyValue, 'buyValue'),
      buy_fee: optNum(d.buyFee, 'buyFee'),
      buy_tax: optNum(d.buyTax, 'buyTax'),
      buy_settlement: optNum(d.buySettlement, 'buySettlement'),
      sell_value: optNum(d.sellValue, 'sellValue'),
      sell_fee: optNum(d.sellFee, 'sellFee'),
      sell_tax: optNum(d.sellTax, 'sellTax'),
      sell_settlement: optNum(d.sellSettlement, 'sellSettlement'),
      total_bs_value: optNum(d.totalBsValue, 'totalBsValue'),
      total_fee: optNum(d.totalFee, 'totalFee'),
      total_tax: optNum(d.totalTax, 'totalTax'),
      total_settlement_amount: optNum(d.totalSettlementAmount, 'totalSettlementAmount'),
      currency: d.currency ? String(d.currency) : null,
      raw: d,
    });
  }
  return [...out.values()];
}

// realizedGainsAndLoses → broker_realized_snapshot 的列。沒有唯一鍵,所以不去重,一列對一列。
export function buildRealizedRows(accountNo, list) {
  const out = [];
  for (const r of list ?? []) {
    const symbol = String(r.stockNo ?? '');
    if (!SYMBOL_RE.test(symbol)) throw new Error(`unexpected stockNo: ${symbol.slice(0, 10)}`);
    const dataDate = r.date ? toIsoDate(r.date) : null;
    if (r.date && !dataDate) throw new Error(`unexpected realized date: ${String(r.date).slice(0, 12)}`);
    out.push({
      account_no: accountNo,
      data_date: dataDate,
      symbol,
      buy_sell: String(r.buySell ?? ''),
      order_type: String(r.orderType ?? ''),
      filled_qty: int(r.filledQty, 'filledQty'),
      filled_price: num(r.filledPrice, 'filledPrice'),
      realized_profit: num(r.realizedProfit, 'realizedProfit', 0),
      realized_loss: num(r.realizedLoss, 'realizedLoss', 0),
      raw: r,
    });
  }
  return out;
}

// ISO 日期加減天數(純日曆運算,與時區無關)。
export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// '2026-10-08' → '20261008'(filledHistory 的日期參數格式,依官方 C# 文件)。
export const compactDate = (iso) => iso.replaceAll('-', '');

// stock.filledHistory 的回傳 → 探測摘要。只含筆數、欄位名、委託類別、日期範圍,不含價量。
export function summarizeFilled(res) {
  const r = listOf(res);
  if (!r.ok) return { ok: false, message: r.message.slice(0, 120) };
  const dates = r.list.map((x) => toIsoDate(x?.date)).filter(Boolean).sort();
  const types = r.list.map((x) => String(x?.orderType ?? ''));
  return {
    ok: true,
    rows: r.list.length,
    fields: Object.keys(r.list[0] ?? {}),
    order_types: [...new Set(types)].sort(),
    day_trade_rows: types.filter((t) => /day.?trade/i.test(t)).length,
    first_date: dates[0] ?? null,
    last_date: dates.at(-1) ?? null,
  };
}

// 券商回空、但系統認為還有持股 → 多半是 API / 權限問題,不是真的清倉,視為失敗。
export function checkSnapshot({ rowCount, systemOpenCount, allowEmpty = false }) {
  if (rowCount === 0 && systemOpenCount > 0 && !allowEmpty) {
    return { ok: false, reason: `broker returned no positions but the system has ${systemOpenCount} open position(s)` };
  }
  return { ok: true };
}

export function isThrottleMessage(message) {
  return /流量|控管|too many|rate.?limit|throttl/i.test(String(message ?? ''));
}

// 官方 accounting 查詢上限 5 次 / 秒;被流量控管時依 2/4/8/16 秒退避重試。
export async function withBackoff(
  fn,
  { delays = [2000, 4000, 8000, 16000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  let res = await fn();
  for (const d of delays) {
    if (res?.isSuccess || !isThrottleMessage(res?.message)) return res;
    await sleep(d);
    res = await fn();
  }
  return res;
}

// 錯誤訊息會進 fetch_log,而 /health 沒有登入保護 → 先把機密值遮掉。
export function redact(text, secrets) {
  let s = String(text ?? '');
  for (const v of secrets) {
    if (v && v.length >= 4) s = s.split(v).join('***');
  }
  return s;
}
