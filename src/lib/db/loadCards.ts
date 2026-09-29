import { getSupabaseServiceRoleClient } from "./client";
import { mapDbCardToCard, type DbCardRow } from "./mapper";
import type { Card } from "../recommendation/types";

export class DbQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbQueryError";
  }
}

/**
 * recommendation에 필요한 카드를 Supabase에서 조회해 Domain `Card[]`로 변환한다.
 * `raw_card_snapshots`/`raw_benefit_snapshots`는 조회하지 않는다 — recommendation 계산과
 * 무관한 감사 전용 데이터다.
 *
 * DB 조회 실패는 `DbQueryError`로, row → Domain 변환 실패는 `DbMapperError`(mapper.ts,
 * `.map(mapDbCardToCard)` 안에서 던져지며 여기서 다시 감싸지 않고 그대로 전파됨)로 구분된다
 * — 호출자(API route handler)가 `instanceof`로 둘을 구분할 수 있다.
 *
 * 이번 단계에서는 페이지네이션이나 카드 필터링을 하지 않는다 — 전체 카드를 가져온다.
 */
export async function loadCards(): Promise<readonly Card[]> {
  const client = getSupabaseServiceRoleClient();
  const { data, error } = await client.from("cards").select(`
      *,
      performance_tiers(*),
      spending_benefits(*),
      perks(*)
    `);

  if (error) {
    throw new DbQueryError(`cards 조회 실패: ${error.message}`);
  }

  // supabase-js는 nested select(`performance_tiers(*)` 등)의 결과 타입을 자동으로 추론하지
  // 못하므로 여기서 DbCardRow[]로 명시 캐스팅한다 — 실제 값의 shape이 이 타입과 다르면
  // 아래 `mapDbCardToCard`가 `DbMapperError`를 던진다.
  const rows = (data ?? []) as unknown as readonly DbCardRow[];
  return rows.map(mapDbCardToCard);
}
