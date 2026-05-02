// 個人持股追蹤 — Supabase backed
//
// 流程：使用者在 UI 輸入「我在 X 日買了 Y 股 Z 元」→ 記錄到 portfolio_holdings
// 系統用現有 diagnose 自動為每檔持股產生「現在該怎麼辦」的建議
// 每日報告 / 每週復盤 由 reports.js 調用本模組做盤點
//
// Supabase schema：
//   CREATE TABLE IF NOT EXISTS portfolio_holdings (
//     id BIGSERIAL PRIMARY KEY,
//     code TEXT NOT NULL,
//     entry_date DATE NOT NULL,
//     entry_price NUMERIC NOT NULL,
//     lots INTEGER NOT NULL DEFAULT 1,
//     note TEXT,
//     status TEXT DEFAULT 'active',     -- active / closed
//     exit_date DATE,
//     exit_price NUMERIC,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX idx_portfolio_status ON portfolio_holdings(status);
//   CREATE INDEX idx_portfolio_code ON portfolio_holdings(code);

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// 新增持股
export async function add({ code, entry_date, entry_price, lots = 1, note = null }) {
  if (!supabase) throw new Error('Supabase 未連接');
  if (!code || !entry_date || !entry_price) throw new Error('code / entry_date / entry_price 必填');
  const { data, error } = await supabase
    .from('portfolio_holdings')
    .insert({
      code: String(code).trim(),
      entry_date,
      entry_price: +entry_price,
      lots: +lots || 1,
      note: note || null,
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 列出全部持股（active 在前）
export async function list({ status = null } = {}) {
  if (!supabase) return [];
  let q = supabase.from('portfolio_holdings').select('*').order('entry_date', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) {
    console.warn('[portfolio list]', error.message);
    return [];
  }
  return data || [];
}

// 平倉（標記為 closed + 記錄出場價）
export async function close(id, { exit_date, exit_price } = {}) {
  if (!supabase) throw new Error('Supabase 未連接');
  if (!id) throw new Error('id 必填');
  const { data, error } = await supabase
    .from('portfolio_holdings')
    .update({
      status: 'closed',
      exit_date: exit_date || new Date().toISOString().slice(0, 10),
      exit_price: exit_price != null ? +exit_price : null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 刪除（單純移除，與平倉不同 — 用於誤輸入）
export async function remove(id) {
  if (!supabase) throw new Error('Supabase 未連接');
  const { error } = await supabase.from('portfolio_holdings').delete().eq('id', id);
  if (error) throw error;
  return { id, deleted: true };
}

// 更新（編輯進場價/張數/備註）
export async function update(id, patch) {
  if (!supabase) throw new Error('Supabase 未連接');
  const allowed = ['code', 'entry_date', 'entry_price', 'lots', 'note', 'exit_date', 'exit_price', 'status'];
  const clean = {};
  Object.keys(patch).forEach((k) => { if (allowed.includes(k) && patch[k] != null) clean[k] = patch[k]; });
  const { data, error } = await supabase
    .from('portfolio_holdings')
    .update(clean)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export function isConnected() {
  return !!supabase;
}
