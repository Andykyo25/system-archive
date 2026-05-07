// 把基本面數字轉成自然語言短評
// 各規則的中文說明 + headline 由 score 決定

export interface AnalyzeInput {
  score: number;
  symbol: string;
  name?: string | null;
  // 基本面
  eps_pos_quarters?: number | null;
  quarters_available?: number | null;
  eps_ttm?: number | string | null;
  eps_yoy_pct?: number | string | null;
  last_q_eps_yoy_pct?: number | string | null;
  forecast_eps_yoy_pct?: number | string | null;
  roe_ttm?: number | string | null;
  fcf_ttm?: number | string | null;
  gross_margin_pct?: number | string | null;
  gross_margin_yoy_pp?: number | string | null;
  pe?: number | string | null;
  pb?: number | string | null;
  pb_threshold?: number | string | null;
  peg?: number | string | null;
  peg_basis?: string | null;
  dividend_yield?: number | string | null;
  // 動能
  pct_5d?: number | string | null;
  pct_20d?: number | string | null;
  // 持股額外
  is_provisional?: boolean | null;
  primary_industry?: string | null;
  stock_type?: string | null;
}

export interface AnalysisOut {
  headline: string;
  notes: string[];
}

function toN(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function analyzeRow(r: AnalyzeInput): AnalysisOut {
  const notes: string[] = [];

  // EPS 連續性
  const epsQ = r.eps_pos_quarters;
  const epsT = r.quarters_available;
  if (epsT != null && epsQ != null) {
    if (epsQ === epsT && epsT >= 4) {
      notes.push(`✓ 過去 ${epsT} 季 EPS 全為正(獲利穩定)`);
    } else if (epsT >= 4) {
      notes.push(`✗ 過去 ${epsT} 季有 ${epsT - epsQ} 季虧損(獲利不穩)`);
    } else {
      notes.push(`— EPS 資料只有 ${epsT} 季,無法判斷連續性`);
    }
  }

  // ROE
  const roe = toN(r.roe_ttm);
  if (roe != null) {
    if (roe > 30) notes.push(`✓ ROE ${roe.toFixed(0)}% 極優,資金運用效率高`);
    else if (roe > 15) notes.push(`✓ ROE ${roe.toFixed(0)}% 通過巴菲特門檻`);
    else if (roe > 0) notes.push(`✗ ROE ${roe.toFixed(0)}% 低於 15%(資金效率不足)`);
    else notes.push(`✗ ROE 為負,股東權益虧損`);
  }

  // FCF
  const fcf = toN(r.fcf_ttm);
  if (fcf != null) {
    if (fcf > 0) {
      notes.push(`✓ 自由現金流為正(財務健康)`);
    } else {
      notes.push(`✗ 自由現金流為負(可能擴廠投資中或營運吃緊)`);
    }
  }

  // PEG
  const peg = toN(r.peg);
  const basisLabel =
    r.peg_basis === "forecast"
      ? "法人預估"
      : r.peg_basis === "last_q_yoy"
        ? "近季 YoY"
        : r.peg_basis === "ttm_yoy"
          ? "TTM YoY"
          : null;
  if (peg != null && basisLabel != null) {
    if (peg < 0.66) notes.push(`✓✓ PEG ${peg.toFixed(2)} 極佳(用${basisLabel}),股價尚未反映成長`);
    else if (peg < 1.0) notes.push(`✓ PEG ${peg.toFixed(2)} 合理(用${basisLabel})`);
    else if (peg < 1.5) notes.push(`◎ PEG ${peg.toFixed(2)} 略偏高(用${basisLabel})`);
    else notes.push(`✗ PEG ${peg.toFixed(2)} 偏高(用${basisLabel})`);
  } else {
    notes.push(`— PEG 算不出(EPS 衰退或無成長動能)`);
  }

  // P/B 對產業門檻
  const pb = toN(r.pb);
  const pbTh = toN(r.pb_threshold);
  if (pb != null && pbTh != null) {
    if (pb < pbTh) {
      if (pb < 1) notes.push(`✓✓ P/B ${pb.toFixed(2)} 低於淨值,深度價值區`);
      else notes.push(`✓ P/B ${pb.toFixed(2)} 低於產業門檻 ${pbTh}`);
    } else {
      notes.push(`✗ P/B ${pb.toFixed(2)} 高於產業門檻 ${pbTh}`);
    }
  }

  // 毛利率 YoY
  const gmYoy = toN(r.gross_margin_yoy_pp);
  const gm = toN(r.gross_margin_pct);
  if (gmYoy != null && gm != null) {
    if (gmYoy > 3) notes.push(`✓ 毛利率 ${gm.toFixed(1)}%(YoY +${gmYoy.toFixed(1)}pp,成本轉嫁能力佳)`);
    else if (gmYoy < -3) notes.push(`✗ 毛利率 ${gm.toFixed(1)}%(YoY ${gmYoy.toFixed(1)}pp,可能殺價競爭中)`);
  }

  // 動能
  const p5 = toN(r.pct_5d);
  if (p5 != null) {
    if (p5 > 8) notes.push(`📈 5 日急漲 +${p5.toFixed(1)}%,短期動能強(留意過熱)`);
    else if (p5 < -8) notes.push(`📉 5 日急跌 ${p5.toFixed(1)}%,短期賣壓大`);
  }

  // 殖利率
  const yld = toN(r.dividend_yield);
  if (yld != null && yld > 5) {
    notes.push(`💰 殖利率 ${yld.toFixed(1)}%(高股息股)`);
  }

  // Provisional 警示
  if (r.is_provisional) {
    notes.push(`⚠ 現價來自備案資料(FinMind),待主力 reconcile`);
  }

  // Headline
  const score = r.score;
  let headline: string;
  if (score >= 5) headline = "🚀 體質完美 — 5 條規則全通過,可關注進場時機";
  else if (score >= 4) headline = "📈 體質佳 — 4/5 通過,僅 1 項需注意";
  else if (score >= 3) headline = "🔍 部分亮點 — 3/5 通過,需個別評估";
  else if (score >= 2) headline = "⚠️ 多項偏弱 — 2/5 通過,謹慎";
  else if (score >= 1) headline = "🚧 體質不足 — 僅 1 項通過";
  else headline = "❌ 體質不佳 — 5 條規則皆未通過";

  return { headline, notes };
}
