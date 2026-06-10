// 海外領先共用 mapping(OverseasWidget + /rank 海外 gate 共用)
// 領先性圖譜(2026-06-02~04 全 universe 掃描驗證,n≈470 intraday corr):
//   記憶體→MU(0.13-0.19)✅ / 台積電鏈→TSM(0.13-0.29)✅ / 金融傳產→無效(不映射)
//   不對稱:下檔警示強(MU<-2% → 記憶體隔日均 -0.93%)、上檔買訊弱(勝率 48%)

export const SOURCE_META: Record<
  string,
  { label: string; group: "index" | "adr" | "proxy"; neutral?: boolean }
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
