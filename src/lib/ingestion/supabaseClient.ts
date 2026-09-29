import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadIngestionEnv } from "./env";

let cachedClient: SupabaseClient | null = null;

/**
 * service role key로 만드는 클라이언트 — Row Level Security를 우회한다. `src/lib/ingestion/`
 * 밖(특히 `src/app/`, `src/lib/recommendation/`)에서는 절대 재사용하지 않는다. 이 디렉터리는
 * 브라우저로 번들되지 않는 서버/CLI 전용 코드다(`scripts/ingest-cards.ts`에서만 실행됨).
 */
export function getSupabaseServiceRoleClient(): SupabaseClient {
  if (cachedClient !== null) return cachedClient;
  const env = loadIngestionEnv();
  cachedClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}
