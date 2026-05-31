import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client。用 service_role key 全 bypass RLS,做為唯一寫入入口。
// 注意:絕對不可以暴露給 browser bundle。
//   `import "server-only"`(A3/D):任何 client component 誤 import 本檔 → build
//   直接失敗,把「service_role 不進 client bundle」這條紅線變成編譯期保證,
//   不再靠 grep/記憶(L42/L46 根治精神:機制防呆,非紀律防呆)。
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
