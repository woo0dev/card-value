/**
 * ingestion 전용 환경변수. dry-run은 이 파일을 전혀 호출하지 않는다(`run.ts` 참고) — DB에
 * 실제로 쓰기를 시도할 때만 필요하므로, dry-run 실행에는 이 값들이 없어도 된다.
 */
export interface IngestionEnv {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
}

export function loadIngestionEnv(): IngestionEnv {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `ingestion: 필요한 환경변수가 없습니다: ${missing.join(", ")}. .env.example을 참고해 ` +
        `.env.local(커밋 금지, .gitignore로 이미 제외됨)에 설정하세요.`,
    );
  }

  return { supabaseUrl: supabaseUrl as string, supabaseServiceRoleKey: supabaseServiceRoleKey as string };
}
