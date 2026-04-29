// 台股交易時段判斷（Asia/Taipei）
// 盤前 8:30-9:00、盤中 9:00-13:30、盤後 13:30-14:30、收盤後 14:30+
// 假日不交易（週六日；國定假日交給呼叫端用 TWSE 回應判斷，後端不維護假日表）

function taipeiNow() {
  const now = new Date();
  // 直接用 toLocaleString 拿到台北時間 parts
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (k) => +fmt.find((p) => p.type === k).value;
  return {
    y: get('year'), m: get('month'), d: get('day'),
    H: get('hour'), M: get('minute'), S: get('second'),
    weekday: new Date(Date.UTC(get('year'), get('month') - 1, get('day'))).getUTCDay(),
  };
}

export function getSession() {
  const t = taipeiNow();
  const minutes = t.H * 60 + t.M;
  const isWeekend = t.weekday === 0 || t.weekday === 6;
  if (isWeekend) return 'closed';
  if (minutes < 8 * 60 + 30) return 'pre';
  if (minutes < 9 * 60) return 'pre';
  if (minutes < 13 * 60 + 30) return 'live';
  if (minutes < 14 * 60 + 30) return 'after';
  return 'closed';
}

export function todayRoc() {
  const t = taipeiNow();
  const roc = t.y - 1911;
  return `${roc}${String(t.m).padStart(2, '0')}${String(t.d).padStart(2, '0')}`;
}

export function todayIso() {
  const t = taipeiNow();
  return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
}

export function todayCompact() {
  const t = taipeiNow();
  return `${t.y}${String(t.m).padStart(2, '0')}${String(t.d).padStart(2, '0')}`;
}
