// 注意:Postgres NUMERIC 在 Supabase JS 內回傳為 string(保留精度),
// 顯示時用 Number(x) 轉換,計算時務必小心精度

export interface Holding {
  id: number;
  symbol: string;
  qty: number;
  avg_cost: number | string;
  opened_at: string;
  closed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Watchlist {
  id: number;
  symbol: string;
  added_at: string;
  note: string | null;
}

export interface PaperOrder {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number | string;
  ordered_at: string;
  note: string | null;
}

export interface PortfolioSummary {
  positions: number;
  total_cost: number | string;
  total_value: number | string;
  total_pnl: number | string;
  total_pct: number | string;
}

export interface HoldingPnL {
  id: number;
  symbol: string;
  qty: number;
  avg_cost: number | string;
  current_price: number | string | null;
  price_date: string | null;
  is_provisional: boolean | null;
  unrealized_pnl: number | string | null;
  unrealized_pct: number | string | null;
  market_value: number | string | null;
  cost_basis: number | string;
  opened_at: string;
  note: string | null;
}

export interface PaperPnL {
  symbol: string;
  net_qty: number;
  avg_cost: number | string | null;
  current_price: number | string | null;
  price_date: string | null;
  is_provisional: boolean | null;
  market_value: number | string | null;
  cost_basis: number | string;
  unrealized_pnl: number | string | null;
  unrealized_pct: number | string | null;
}
