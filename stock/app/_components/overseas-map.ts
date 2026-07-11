// 海外領先共用 mapping(MorningPanel gate + HoldingsIntelWidget + /rank 海外 gate 共用)
// 領先性圖譜(2026-06-02~04 全 universe 掃描驗證,n≈470 intraday corr):
//   記憶體→MU(0.13-0.19)✅ / 台積電鏈→TSM(0.13-0.29)✅ / 金融傳產→無效(不映射)
//   不對稱:下檔警示強(MU<-2% → 記憶體隔日均 -0.93%)、上檔買訊弱(勝率 48%)

export const SOURCE_META: Record<
  string,
  { label: string; group: "index" | "adr" | "proxy" | "kr"; neutral?: boolean }
> = {
  "^SOX": { label: "費半", group: "index" },
  "^IXIC": { label: "那斯達克", group: "index" },
  "NQ=F": { label: "那指期", group: "index" },
  "^VIX": { label: "VIX", group: "index", neutral: true },
  TSM: { label: "台積ADR", group: "adr" },
  UMC: { label: "聯電ADR", group: "adr" },
  MU: { label: "美光", group: "proxy" },
  NVDA: { label: "輝達", group: "proxy" },
  AAPL: { label: "蘋果", group: "proxy" },
  AVGO: { label: "博通", group: "proxy" },
  AMD: { label: "超微", group: "proxy" },
  // 韓股(2026-07-11 晨間情報改版):KRX 與台股盤有重疊,08:30 抓到的是開盤中快照
  "005930.KS": { label: "三星電子", group: "kr" },
  "000660.KS": { label: "SK海力士", group: "kr" },
  "^KS11": { label: "KOSPI", group: "kr" },
};

// 產業 → 海外對應源。verified = 圖譜實證過(只有實證的觸發下檔警示/買進 gate)
export const INDUSTRY_SOURCE: Record<
  string,
  { src: string; verified: boolean; downNote: string }
> = {
  記憶體: { src: "MU", verified: true, downNote: "歷史隔日均約 -0.9%" },
  IC設計: { src: "TSM", verified: true, downNote: "台積電鏈隔日偏弱" },
  半導體封測: { src: "TSM", verified: true, downNote: "台積電鏈隔日偏弱" },
  AI伺服器: { src: "NVDA", verified: false, downNote: "" },
};

// 買進 gate 門檻:對應源隔夜跌幅 ≤ -2%(已驗證下檔不對稱)→ 當日勿進場
export const GATE_THRESHOLD = -2;

// 晨間持股情報(2026-07-11):產業 → 報價 chips + 國際新聞 tag(對齊 fetch-intl-news 的 INDUSTRY_TOPICS)
// ⚠ 只有 INDUSTRY_SOURCE.verified 的源觸發 gate;韓股/其他為資訊性對照,未經 lead-lag 驗證
export const INDUSTRY_INTEL: Record<
  string,
  { quotes: string[]; news: string[] }
> = {
  記憶體: {
    quotes: ["MU", "005930.KS", "000660.KS", "^KS11"],
    news: ["MU", "005930.KS", "000660.KS"],
  },
  IC設計: { quotes: ["TSM", "NVDA", "^SOX"], news: ["TSM", "NVDA"] },
  半導體封測: { quotes: ["TSM", "^SOX"], news: ["TSM"] },
  AI伺服器: { quotes: ["NVDA", "^SOX"], news: ["NVDA"] },
};
export const GENERIC_INTEL: { quotes: string[]; news: string[] } = {
  quotes: ["^SOX", "^IXIC", "^VIX"],
  news: ["^SOX"],
};
