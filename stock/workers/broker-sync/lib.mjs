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
