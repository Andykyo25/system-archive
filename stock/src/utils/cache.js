// localStorage 快取（瀏覽器端）— 用於歷史 K 線、財報這類更新頻率低的資料
const PREFIX = 'twr:';

export function get(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { v, exp } = JSON.parse(raw);
    if (exp && Date.now() > exp) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return v;
  } catch { return null; }
}

export function set(key, value, ttlMs) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 }));
  } catch { /* quota exceeded — ignore */ }
}

export async function memo(key, ttlMs, fn) {
  const cached = get(key);
  if (cached !== null) return cached;
  const v = await fn();
  set(key, v, ttlMs);
  return v;
}
