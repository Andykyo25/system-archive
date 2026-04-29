// 離線/開發備援資料 — 與原 HTML 同源，作為 API 失敗時的 fallback / 啟動時的 placeholder

export const themes = [
  { id:'leo',      name:'低軌衛星',     hot:true,  desc:'Kuiper 量產+ Starlink V3 拉貨', leaders:['3491','6285','2314','2312','3169'], chg:+3.84 },
  { id:'ai',       name:'AI 伺服器',    hot:true,  desc:'Blackwell Ultra / Rubin 拉貨潮', leaders:['2330','2317','6669','3231','2382','2376'], chg:+2.41 },
  { id:'cowos',    name:'CoWoS 先進封裝',hot:true, desc:'TSMC 月產能拉至 8 萬片',         leaders:['2330','3711','6147','5347'], chg:+1.92 },
  { id:'cool',     name:'AI 散熱',      hot:true,  desc:'液冷滲透率突破 35%',             leaders:['3017','3324','6230','3653'], chg:+4.12 },
  { id:'cpo',      name:'矽光子 / CPO', hot:false, desc:'NVIDIA Quantum-X 採用 CPO',      leaders:['6442','3450','3563','3105'], chg:+2.08 },
  { id:'robot',    name:'人形機器人',   hot:true,  desc:'Optimus V3 量產 + 鴻海代工',     leaders:['2317','2308','1503','2059'], chg:+5.21 },
  { id:'biotech',  name:'CDMO / GLP-1', hot:false, desc:'減重藥代工訂單湧入',             leaders:['1707','4174','6446','4142'], chg:+1.34 },
  { id:'powergrid',name:'重電 / AI 電網',hot:false,desc:'資料中心電力缺口',               leaders:['1513','1519','1503','9958'], chg:+0.78 },
];

export const industries = [
  { name:'半導體', chg:+2.18, lead:'2330' }, { name:'電子零組件', chg:+1.45, lead:'2308' },
  { name:'電腦及週邊', chg:+2.91, lead:'2382' }, { name:'通信網路', chg:+3.62, lead:'6285' },
  { name:'光電', chg:-0.52, lead:'2409' }, { name:'其他電子', chg:+1.18, lead:'3017' },
  { name:'金融保險', chg:+0.34, lead:'2882' }, { name:'航運', chg:-1.84, lead:'2603' },
  { name:'觀光', chg:+0.92, lead:'2731' }, { name:'生技醫療', chg:+1.34, lead:'4174' },
  { name:'塑膠', chg:-0.41, lead:'1301' }, { name:'鋼鐵', chg:-0.18, lead:'2002' },
  { name:'紡織纖維', chg:+0.22, lead:'1402' }, { name:'汽車', chg:+0.65, lead:'2207' },
  { name:'食品', chg:+0.08, lead:'1216' }, { name:'營建', chg:-0.28, lead:'2548' },
  { name:'貿易百貨', chg:+0.45, lead:'2912' }, { name:'電器電纜', chg:+1.02, lead:'1503' },
  { name:'橡膠', chg:+0.12, lead:'2105' }, { name:'資訊服務', chg:+1.78, lead:'6214' },
  { name:'油電燃氣', chg:+0.48, lead:'9917' }, { name:'水泥', chg:-0.12, lead:'1101' },
  { name:'造紙', chg:+0.04, lead:'1905' }, { name:'化工', chg:-0.22, lead:'1722' },
  { name:'文化創意', chg:+0.84, lead:'8454' }, { name:'運動休閒', chg:+0.31, lead:'9921' },
  { name:'居家生活', chg:+0.18, lead:'9938' }, { name:'綠能環保', chg:+1.92, lead:'6443' },
];

// 註：price / chg / pct 一律設 null，UI 顯示 "--"，等 bootstrapQuotes 從 FinMind 灌入真實價
// 基本面欄位（eps/pe/pb/roe/divYield/mcap）也設 null，等 financial API 覆蓋
const meta = (name, industry, theme = []) => ({
  name, industry, theme,
  price: null, chg: null, pct: null,
  eps: null, pe: null, pb: null, roe: null, divYield: null, mcap: null,
});

export const stocks = {
  '2330': meta('台積電', '半導體', ['ai','cowos']),
  '2317': meta('鴻海', '電腦及週邊', ['ai','robot']),
  '2454': meta('聯發科', '半導體', ['ai']),
  '2382': meta('廣達', '電腦及週邊', ['ai']),
  '6669': meta('緯穎', '電腦及週邊', ['ai']),
  '3231': meta('緯創', '電腦及週邊', ['ai']),
  '2376': meta('技嘉', '電腦及週邊', ['ai']),
  '3017': meta('奇鋐', '其他電子', ['cool']),
  '3324': meta('雙鴻', '其他電子', ['cool']),
  '6285': meta('啟碁', '通信網路', ['leo']),
  '3491': meta('昇達科', '通信網路', ['leo']),
  '2314': meta('台揚', '通信網路', ['leo']),
  '2308': meta('台達電', '電子零組件', ['ai','robot']),
  '6442': meta('光聖', '光電', ['cpo']),
  '3711': meta('日月光投控', '半導體', ['cowos']),
  '2603': meta('長榮', '航運'),
  '2882': meta('國泰金', '金融保險'),
  '4174': meta('浩鼎', '生技醫療', ['biotech']),
  '1503': meta('士電', '電器電纜', ['robot','powergrid']),
  '6147': meta('頎邦', '半導體', ['cowos']),
  '5347': meta('世界', '半導體', ['cowos']),
  '6214': meta('精誠', '資訊服務', ['ai']),
  '6443': meta('元晶', '綠能環保'),
  '6230': meta('尼得科超眾', '其他電子', ['cool']),
  '3450': meta('聯鈞', '光電', ['cpo']),
  '2312': meta('金寶', '電子零組件', ['leo']),
  '3169': meta('亞信', '通信網路', ['leo']),
  '6446': meta('藥華藥', '生技醫療', ['biotech']),
  '8454': meta('富邦媒', '文化創意'),
  '2207': meta('和泰車', '汽車'),
  '2731': meta('雄獅', '觀光'),
  '2409': meta('友達', '光電'),
  '2002': meta('中鋼', '鋼鐵'),
  '1216': meta('統一', '食品'),
  '1301': meta('台塑', '塑膠'),
};

export const newsMock = [
  { time:'11:24', tag:'快訊', urgent:true,  title:'台積電 4 月營收創歷史新高 月增 8.4% 法人調升目標價至 1,420 元' },
  { time:'11:18', tag:'產業', urgent:false, title:'Amazon Kuiper 第三批衛星升空 啟碁、昇達科 Q2 出貨量上修' },
  { time:'11:12', tag:'籌碼', urgent:false, title:'外資連 5 買加碼權值 鴻海買超 2.8 萬張居首' },
  { time:'11:05', tag:'美股', urgent:false, title:'NVIDIA 盤後 +2.1% Blackwell Ultra Q2 拉貨優於預期' },
  { time:'10:48', tag:'公告', urgent:false, title:'廣達董事會通過 配發現金股利 7 元 殖利率 2.13%' },
  { time:'10:32', tag:'產業', urgent:false, title:'特斯拉 Optimus V3 量產 鴻海越南廠取得獨家代工' },
  { time:'10:21', tag:'快訊', urgent:true,  title:'央行宣布利率不變 重貼現率維持 2.000%' },
  { time:'10:08', tag:'籌碼', urgent:false, title:'投信集中加碼 AI 散熱 奇鋐、雙鴻三日累計買超逾 3,500 張' },
];

export const stockNews = {
  '2330':[
    { time:'11:24', title:'4 月營收創高 月增 8.4% 法人調升目標價' },
    { time:'09:18', title:'CoWoS 月產能拉至 8 萬片 2026 年再擴 30%' },
    { time:'昨日',   title:'資本支出上修至 480 億美元 全力衝刺 N2 / A16' },
  ],
  '2317':[
    { time:'11:32', title:'Optimus V3 取得獨家代工 越南廠 Q3 投產' },
    { time:'10:14', title:'AI 伺服器 Q2 出貨量上修 15% Blackwell Ultra 滿載' },
    { time:'昨日',   title:'外資連 5 日買超 2.8 萬張 推升站上 248' },
  ],
};

export const flowMock = [
  { who:'外資',   buy:856.4, sell:702.8 },
  { who:'投信',   buy:128.6, sell: 88.4 },
  { who:'自營商', buy:218.4, sell:228.2 },
];

// 持股策略 — 只保留「策略層」資訊，價格區間 / 停損 / 目標 / 勝率 / 評等
// 全由前端依即時 K 線 + 三大法人動態計算
export const portfolio = [
  { code:'2330', plan:'B', weight:18, theme:'CoWoS / AI 伺服器主軸',  reason:'CoWoS 月產能擴張，N2 / A16 訂單能見度長；外資持股創高。' },
  { code:'2317', plan:'B', weight:12, theme:'AI 伺服器 + Optimus',     reason:'雙引擎 — AI 伺服器代工 + 機器人組裝；三率齊升。' },
  { code:'2382', plan:'B', weight:10, theme:'Blackwell Ultra 主供應',  reason:'AI 伺服器代工廠，營收 YoY 高速成長。' },
  { code:'6669', plan:'B', weight:10, theme:'AI 伺服器 ROE 王',        reason:'ROE 居全市場前列；PE 偏高需嚴守停損。' },
  { code:'3491', plan:'A', weight:10, theme:'低軌衛星地面站',          reason:'Kuiper / Starlink 拉貨；中小型股符合作帳區間。' },
  { code:'3017', plan:'A', weight:10, theme:'AI 散熱龍頭',             reason:'液冷模組獨家供應；投信集中買超。' },
  { code:'6285', plan:'A', weight:8,  theme:'Amazon Kuiper 用戶終端',  reason:'Q2 出貨上修；殖利率 3% 提供支撐。' },
  { code:'1503', plan:'A', weight:7,  theme:'AI 電網 + 機器人',        reason:'資料中心電力缺口受惠；技術面突破平台。' },
];
