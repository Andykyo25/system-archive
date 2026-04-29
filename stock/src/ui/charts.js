// Chart.js 實例集中管理 — 解決原本每 3 秒都 new Chart 的記憶體洩漏
const charts = new Map();

export function mountChart(id, config) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return null;
  destroyChart(id);
  // eslint-disable-next-line no-undef
  const c = new Chart(el, config);
  charts.set(typeof id === 'string' ? id : el, c);
  return c;
}

export function destroyChart(id) {
  const key = typeof id === 'string' ? id : id;
  const c = charts.get(key);
  if (c) {
    try { c.destroy(); } catch { /* ignore */ }
    charts.delete(key);
  }
}

export function getChart(id) { return charts.get(id); }

export function destroyAll() {
  for (const c of charts.values()) {
    try { c.destroy(); } catch { /* ignore */ }
  }
  charts.clear();
}

// 通用 Chart.js theme（沿用配色）
export const theme = {
  axis: { color: '#7d8aa0', font: { size: 9 } },
  grid: { color: '#1f2836' },
};
