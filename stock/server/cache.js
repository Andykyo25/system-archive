const store = new Map();

export function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function set(key, value, ttlMs) {
  store.set(key, { value, exp: Date.now() + ttlMs });
}

// in-flight 鎖：避免 concurrent request 同 key 各自跑 fn（log 暴增、上游被打爆）
const inflight = new Map();

export async function memo(key, ttlMs, fn) {
  const cached = get(key);
  if (cached !== null) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      set(key, value, ttlMs);
      return value;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// memo 但「失敗也 cache 短時間」— 避免上游持續不可用時被狂打
// 例如 marketContext 拿不到 TAIEX 時，60 秒內都直接回 null 不重打
export async function memoFailsafe(key, ttlMs, failTtlMs, fn) {
  const cached = get(key);
  if (cached === false) return null;            // 失敗 sentinel
  if (cached !== null) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      set(key, value, ttlMs);
      return value;
    } catch {
      set(key, false, failTtlMs);
      return null;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

export function clear() {
  store.clear();
}

export function stats() {
  return { size: store.size, keys: [...store.keys()] };
}
