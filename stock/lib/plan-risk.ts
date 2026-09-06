export interface RiskContext {
  cash: number | null;
  equity: number | null;
  risk_pct: number | null;
  fee_rate: number | null;
  tax_rate: number | null;
  price_date: string | null;
  coverage_ok: boolean;
  positions: {
    symbol: string;
    industry: string | null;
    market_value: number | null;
  }[];
  calculated_at: string;
}

export interface RiskEstimate {
  shares: number;
  riskBudget: number;
  riskPerShare: number;
  estimatedLoss: number;
  cashRequired: number;
  limitingFactors: string[];
  caps: { label: string; shares: number }[];
  positionPct: number | null;
  industryPct: number | null;
  slippagePct: number;
  priceDate: string;
  calculatedAt: string;
  inputs: {
    entry: number;
    stop: number;
    cash: number;
    equity: number;
    riskPct: number;
    feeRate: number;
    taxRate: number;
    existingSymbolValue: number;
    existingIndustryValue: number;
  };
}

// Budget estimate, not a guaranteed fill/loss bound. Concentration caps stay
// OPTIONAL and user-supplied; avoid inventing personalised allocation limits.
// The risk-budget and cash caps need no such policy, so an estimate is still
// produced when the user has not set any concentration limit.
export function estimateRisk(
  context: RiskContext,
  input: {
    symbol: string;
    industry: string | null;
    entry: number;
    stop: number;
    positionPct?: number | null;
    industryPct?: number | null;
    slippagePct: number;
  },
  today: string,
): RiskEstimate {
  const {
    cash,
    equity,
    risk_pct: riskPct,
    fee_rate: fee,
    tax_rate: tax,
  } = context;
  if (
    !context.coverage_ok ||
    !context.price_date ||
    [cash, equity, riskPct, fee, tax].some(
      (v) => v == null || !Number.isFinite(Number(v)),
    )
  ) {
    throw new Error("持股估值或風險設定未齊，暫不提供股數估算");
  }
  const age = Date.parse(today) - Date.parse(context.price_date);
  if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000)
    throw new Error("估值日期不適用，請先更新價格");
  // Cash below zero (over-invested, or a rounding residue) is a real account
  // state, not a data fault: it must size to 0 shares and stay visible, never
  // disable the estimate. Only genuinely unusable settings refuse.
  if (
    Number(equity) <= 0 ||
    Number(riskPct) <= 0 ||
    Number(riskPct) > 1 ||
    Number(fee) < 0 ||
    Number(tax) < 0 ||
    Number(fee) + Number(tax) >= 1
  ) {
    throw new Error("現金或風險設定不適用，請確認本金與費率");
  }
  const { entry, stop, slippagePct } = input;
  const positionPct = input.positionPct ?? null;
  const industryPct = input.industryPct ?? null;
  if (
    ![entry, stop, slippagePct].every(Number.isFinite) ||
    stop <= 0 ||
    entry <= stop ||
    slippagePct < 0 ||
    slippagePct > 10
  )
    throw new Error("請填寫有效的價格與滑價假設");
  const badCap = (v: number | null) =>
    v != null && (!Number.isFinite(v) || v <= 0 || v > 100);
  if (badCap(positionPct) || badCap(industryPct))
    throw new Error("集中度上限須介於 0 與 100 之間");
  if (industryPct != null && !input.industry)
    throw new Error("此標的沒有產業分類，無法套用產業集中度上限");
  const slip = slippagePct / 100;
  const buyCost = entry * (1 + slip) * (1 + Number(fee));
  const sellProceeds = stop * (1 - slip) * (1 - Number(fee) - Number(tax));
  const riskPerShare = buyCost - sellProceeds;
  const riskBudget = Number(equity) * Number(riskPct);
  const existing = context.positions
    .filter((p) => p.symbol === input.symbol)
    .reduce((a, p) => a + Number(p.market_value), 0);
  const industryValue = context.positions
    .filter((p) => p.industry === input.industry)
    .reduce((a, p) => a + Number(p.market_value), 0);
  const cap = (amount: number) => Math.max(0, Math.floor(amount / buyCost));
  const caps = [
    {
      label: "單筆風險預算",
      shares: Math.max(0, Math.floor(riskBudget / riskPerShare)),
    },
    { label: "可用現金", shares: cap(Number(cash)) },
  ];
  if (positionPct != null)
    caps.push({
      label: "單股集中度",
      shares: cap((Number(equity) * positionPct) / 100 - existing),
    });
  if (industryPct != null)
    caps.push({
      label: "產業集中度",
      shares: cap((Number(equity) * industryPct) / 100 - industryValue),
    });
  const shares = Math.min(...caps.map((c) => c.shares));
  return {
    shares,
    riskBudget,
    riskPerShare,
    estimatedLoss: shares * riskPerShare,
    cashRequired: shares * buyCost,
    limitingFactors: caps
      .filter((c) => c.shares === shares)
      .map((c) => c.label),
    caps,
    positionPct,
    industryPct,
    slippagePct,
    priceDate: context.price_date,
    calculatedAt: context.calculated_at,
    inputs: {
      entry,
      stop,
      cash: Number(cash),
      equity: Number(equity),
      riskPct: Number(riskPct),
      feeRate: Number(fee),
      taxRate: Number(tax),
      existingSymbolValue: existing,
      existingIndustryValue: industryValue,
    },
  };
}
