import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * API Route Handler 전용 Supabase 클라이언트. service role key로 만들어 RLS를 우회한다
 * (현재 `anon`에는 카탈로그 테이블 SELECT grant가 없다 — 읽기 전용 분석 §10 참고).
 *
 * 이 파일은 서버에서만 import된다(`src/app/api/**`의 Route Handler에서만 사용) — 클라이언트
 * 컴포넌트에서 import하면 안 된다. 환경변수 이름/생성 방식은 `src/lib/ingestion/
 * supabaseClient.ts`와 같지만(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), 목적(ingestion 쓰기
 * vs API 읽기)이 달라 의도적으로 별개 모듈로 둔다 — 지금 공통 추상화로 합치지 않는다.
 */
let cachedClient: SupabaseClient | null = null;

export function getSupabaseServiceRoleClient(): SupabaseClient {
  if (cachedClient !== null) return cachedClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    throw new Error(`db client: 필요한 환경변수가 없습니다: ${missing.join(", ")}`);
  }

  cachedClient = createClient(supabaseUrl as string, supabaseServiceRoleKey as string, {
    auth: { persistSession: false },
  });
  return cachedClient;
}
