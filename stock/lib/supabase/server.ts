import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client。用 service_role key 全 bypass RLS,做為唯一寫入入口。
// 注意:絕對不可以暴露給 browser bundle(Next.js server-only 檔案)。
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
