// 個股頁「集保與主動式 ETF」區塊的純邏輯(不碰 DB / React),方便用 node --experimental-strip-types 測試。
// 資料來源:v_tdcc_latest、tdcc_distribution_weekly、v_etf_active_flow、etf_holdings_daily(皆僅 service_role 可讀)。
// 這些是看盤資訊:集保 / ETF 持股指標的預測力尚未經本系統 PIT 驗證(M10),不構成買賣訊號。

export type Num = number | string | null;

export type TdccWeek = {
  data_date: string;
  holders_total: Num;
  big400_ratio: Num;
  big1000_ratio: Num;
  retail50_ratio: Num;
};

export type TdccLatest = {
  data_date: string;
  holders_total: Num;
  big400_ratio: Num;
  big400_wow: Num;
  big1000_ratio: Num;
  big1000_wow: Num;
  retail50_ratio: Num;
  retail50_wow: Num;
  holders_wow: Num;
};

export type EtfFlow = {
  as_of_date: string | null;
  n_etf: Num;
  qty: Num;
  chg_1d: Num;
  chg_5d: Num;
  chg_20d: Num;
  n_buy_5d: Num;
  n_sell_5d: Num;
};

export type EtfHolderRow = {
  etf_symbol: string;
  data_date: string;
  quantity: Num;
  weight: Num;
  quantity_change: Num;
};

const n = (v: Num | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export const fmtInt = (v: Num | undefined): string => {
  const x = n(v);
  return x === null ? '—' : x.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
};
export const fmtSigned = (v: Num | undefined, digits = 0): string => {
  const x = n(v);
  if (x === null) return '—';
  return `${x > 0 ? '+' : ''}${x.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
// 股 → 張(1 張 = 1,000 股)
export const lots = (shares: Num | undefined): number | null => {
  const x = n(shares);
  return x === null ? null : Math.round(x / 1000);
};
export const fmtLots = (shares: Num | undefined): string => {
  const x = lots(shares);
  return x === null ? '—' : x.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
};
export const fmtLotsSigned = (shares: Num | undefined): string => {
  const x = lots(shares);
  if (x === null) return '—';
  return `${x > 0 ? '+' : ''}${x.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`;
};

export type Metric = {
  key: string;
  label: string;
  hint: string;
  value: string; // 現值(含單位)
  delta: number | null; // 較上一期的變化(比例為百分點、人數為人)
  deltaText: string;
  points: { as_of: string; value: number }[]; // 由舊到新
};

// 四張卡:千張大戶 / 400 張以上大戶 / 散戶(≤50 張)持股比 + 股東人數。weeks 順序不拘。
export function tdccMetrics(latest: TdccLatest | null, weeks: TdccWeek[]): Metric[] {
  if (!latest) return [];
  const asc = [...weeks].sort((a, b) => (a.data_date < b.data_date ? -1 : 1));
  const pts = (key: keyof TdccWeek) =>
    asc.flatMap((w) => {
      const v = n(w[key]);
      return v === null ? [] : [{ as_of: w.data_date, value: v }];
    });
  const pct = (v: Num) => (n(v) === null ? '—' : `${(n(v) as number).toFixed(2)}%`);
  const pp = (v: Num) => (n(v) === null ? '—' : `${fmtSigned(v, 2)} pp`);
  return [
    { key: 'big1000', label: '千張大戶持股比', hint: '≥1,000 張', value: pct(latest.big1000_ratio), delta: n(latest.big1000_wow), deltaText: pp(latest.big1000_wow), points: pts('big1000_ratio') },
    { key: 'big400', label: '400 張以上大戶持股比', hint: '≥400 張', value: pct(latest.big400_ratio), delta: n(latest.big400_wow), deltaText: pp(latest.big400_wow), points: pts('big400_ratio') },
    { key: 'retail50', label: '散戶持股比', hint: '≤50 張', value: pct(latest.retail50_ratio), delta: n(latest.retail50_wow), deltaText: pp(latest.retail50_wow), points: pts('retail50_ratio') },
    { key: 'holders', label: '集保股東人數', hint: '全體', value: `${fmtInt(latest.holders_total)} 人`, delta: n(latest.holders_wow), deltaText: n(latest.holders_wow) === null ? '—' : `${fmtSigned(latest.holders_wow)} 人`, points: pts('holders_total') },
  ];
}

export type EtfModel = {
  hasData: boolean;
  asOf: string | null;
  nEtf: number;
  totalLots: string;
  windows: { label: string; value: string; delta: number | null }[];
  buySell: string;
  holders: { etf: string; name: string; lots: string; weight: string; changeLots: string; change: number | null }[];
};

// flow:v_etf_active_flow 該股一列(可為 null);rows:該股的 etf_holdings_daily(任意日期);names:ETF 代號 → 名稱。
// 目前持有 = 全域最新資料日(flow.as_of_date)且股數 > 0 的列,依股數取前 5。
export function etfModel(flow: EtfFlow | null, rows: EtfHolderRow[], names: Record<string, string>): EtfModel {
  const asOf = flow?.as_of_date ?? null;
  const nEtf = n(flow?.n_etf) ?? 0;
  const current = rows
    .filter((r) => asOf !== null && r.data_date === asOf && (n(r.quantity) ?? 0) > 0)
    .sort((a, b) => (n(b.quantity) as number) - (n(a.quantity) as number))
    .slice(0, 5);
  const hasData = flow !== null && (nEtf > 0 || n(flow.chg_20d) !== 0 || rows.length > 0);
  return {
    hasData,
    asOf,
    nEtf,
    totalLots: fmtLots(flow?.qty),
    windows: [
      { label: '近 1 日', value: fmtLotsSigned(flow?.chg_1d), delta: n(flow?.chg_1d) },
      { label: '近 5 日', value: fmtLotsSigned(flow?.chg_5d), delta: n(flow?.chg_5d) },
      { label: '近 20 日', value: fmtLotsSigned(flow?.chg_20d), delta: n(flow?.chg_20d) },
    ],
    buySell: `近 5 日 ${n(flow?.n_buy_5d) ?? 0} 檔加碼、${n(flow?.n_sell_5d) ?? 0} 檔減碼`,
    holders: current.map((r) => ({
      etf: r.etf_symbol,
      name: names[r.etf_symbol] ?? '',
      lots: fmtLots(r.quantity),
      weight: n(r.weight) === null ? '—' : `${(n(r.weight) as number).toFixed(2)}%`,
      changeLots: fmtLotsSigned(r.quantity_change),
      change: n(r.quantity_change),
    })),
  };
}
