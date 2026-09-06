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
  positionPct: number;
  industryPct: number;
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

// Budget estimate, not a guaranteed fill/loss bound. Caps are supplied explicitly
// by the user; avoid inventing personalised allocation limits.
export function estimateRisk(
  context: RiskContext,
  input: {
    symbol: string;
    industry: string | null;
    entry: number;
    stop: number;
    positionPct: number;
    industryPct: number;
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
    !input.industry ||
    !context.price_date ||
    [cash, equity, riskPct, fee, tax].some(
      (v) => v == null || !Number.isFinite(Number(v)),
    )
  ) {
    throw new Error("持股估值、產業或風險設定未齊，暫不提供股數估算");
  }
  const age = Date.parse(today) - Date.parse(context.price_date);
  if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000)
    throw new Error("估值日期不適用，請先更新價格");
  if (
    Number(equity) <= 0 ||
    Number(cash) < 0 ||
    Number(riskPct) <= 0 ||
    Number(riskPct) > 1 ||
    Number(fee) < 0 ||
    Number(tax) < 0 ||
    Number(fee) + Number(tax) >= 1
  ) {
    throw new Error("現金或風險設定不適用，請確認本金與費率");
  }
  const { entry, stop, positionPct, industryPct, slippagePct } = input;
  if (
    ![entry, stop, positionPct, industryPct, slippagePct].every(
      Number.isFinite,
    ) ||
    stop <= 0 ||
    entry <= stop ||
    positionPct <= 0 ||
    positionPct > 100 ||
    industryPct <= 0 ||
    industryPct > 100 ||
    slippagePct < 0 ||
    slippagePct > 10
  )
    throw new Error("請填寫有效的價格、集中度上限與滑價假設");
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
    {
      label: "單股集中度",
      shares: cap((Number(equity) * positionPct) / 100 - existing),
    },
    {
      label: "產業集中度",
      shares: cap((Number(equity) * industryPct) / 100 - industryValue),
    },
  ];
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
