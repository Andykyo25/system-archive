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

export async function memo(key, ttlMs, fn) {
  const cached = get(key);
  if (cached !== null) return cached;
  const value = await fn();
  set(key, value, ttlMs);
  return value;
}

export function clear() {
  store.clear();
}

export function stats() {
  return { size: store.size, keys: [...store.keys()] };
}
