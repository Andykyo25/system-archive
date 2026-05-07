-- 移除 paper trading(改用產業熱門股清單)
-- View 必須先 drop,因為 v_paper_pnl/v_paper_positions 依賴 paper_orders

drop view if exists public.v_paper_pnl;
drop view if exists public.v_paper_positions;
drop table if exists public.paper_orders;
