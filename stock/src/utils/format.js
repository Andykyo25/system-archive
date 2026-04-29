export const fmt = (n, d = 2) => {
  if (n == null || !Number.isFinite(+n)) return '--';
  return (+n).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const sign = (n) => (n > 0 ? '+' : '') + fmt(n, 2);
export const pctClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
export const colorOf = (n) => (n > 0 ? 'var(--up)' : n < 0 ? 'var(--down)' : 'var(--flat)');

export function pad(n) { return String(n).padStart(2, '0'); }

export function todayLabel() {
  const d = new Date();
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${wd})`;
}

export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 民國年 1150428 → 2026-04-28
export function rocToIso(roc) {
  if (!roc || roc.length < 7) return '';
  const y = +roc.slice(0, roc.length - 4) + 1911;
  const m = roc.slice(roc.length - 4, roc.length - 2);
  const d = roc.slice(roc.length - 2);
  return `${y}-${m}-${d}`;
}
