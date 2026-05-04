export const fmt = (n, d = 2) => {
  if (n == null || !Number.isFinite(+n)) return '--';
  return (+n).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
};

// 台股跳動單位：< 10:0.01、< 50:0.05、< 100:0.1、< 500:0.5、< 1000:1、≥ 1000:5
export function roundToTick(p) {
  if (p == null || !Number.isFinite(+p)) return p;
  const v = +p;
  if (v < 10)   return Math.round(v * 100) / 100;
  if (v < 50)   return Math.round(v * 20) / 20;
  if (v < 100)  return Math.round(v * 10) / 10;
  if (v < 500)  return Math.round(v * 2) / 2;
  if (v < 1000) return Math.round(v);
  return Math.round(v / 5) * 5;
}

// 顯示用：先 roundToTick 再 fmt
export function fmtTick(n, d = 2) {
  return fmt(roundToTick(n), d);
}
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
