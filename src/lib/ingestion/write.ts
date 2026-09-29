import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleClient } from "./supabaseClient";
import type {
  CardRow,
  PerformanceTierRow,
  PerkRow,
  RawBenefitSnapshotRow,
  RawCardSnapshotRow,
  SpendingBenefitRow,
} from "./types";

/**
 * Supabase JS(PostgREST 기반)는 여러 테이블에 걸친 진짜 DB transaction을 지원하지 않는다 —
 * `.insert()`/`.upsert()`/`.delete()` 각각이 독립된 HTTP 요청이며, 하나의 요청 안에서만
 * 원자적이다(여러 row를 한 번에 insert하는 것 자체는 그 한 요청 안에서 원자적이다). 여러
 * 테이블에 걸친 원자성을 얻으려면 Postgres 함수(RPC) 하나로 감싸야 하는데, 이번 단계는 DB
 * schema/migration을 수정하지 않기로 했으므로 새 RPC를 추가하지 않는다.
 *
 * 그래서 이 파일은 "카드 단위 transaction"을 흉내 내지 않는다. 대신:
 * - 각 카드는 독립적으로 처리되고(한 카드의 실패가 다른 카드를 막지 않음),
 * - 자식 테이블 삭제/삽입은 FK 의존성이 실제로 요구하는 순서를 지킨다(아래 `writeCardBatch`
 *   참고 — `spending_benefits`/`perks`가 `performance_tiers`를 참조하므로, 삭제는 자식이
 *   먼저, 삽입은 부모(tiers)가 먼저다),
 * - 처리 도중 실패하면 그 카드는 일시적으로 자식 테이블이 비어 있는 상태로 남을 수 있다.
 *   이건 알려진 한계이며, ingestion 전체가 멱등적으로 설계돼 있으므로(카드 단위 전체 교체 —
 *   `run.ts`/`mapper.ts` 참고) 다음 재실행이 그 카드를 다시 정상 상태로 복구한다.
 */

export interface CardWriteBatch {
  readonly cardRow: CardRow;
  readonly tierRows: readonly PerformanceTierRow[];
  readonly spendingBenefitRows: readonly SpendingBenefitRow[];
  readonly perkRows: readonly PerkRow[];
}

export interface WriteIngestionResultInput {
  readonly rawCardSnapshotRows: readonly RawCardSnapshotRow[];
  readonly rawBenefitSnapshotRows: readonly RawBenefitSnapshotRow[];
  readonly cardBatches: readonly CardWriteBatch[];
}

export async function writeIngestionResult(input: WriteIngestionResultInput): Promise<void> {
  const client = getSupabaseServiceRoleClient();

  // raw snapshot: append-only, 카드 성공/실패와 무관하게 전부 기록한다.
  if (input.rawCardSnapshotRows.length > 0) {
    const { error } = await client.from("raw_card_snapshots").insert([...input.rawCardSnapshotRows]);
    if (error) throw new Error(`raw_card_snapshots insert 실패: ${error.message}`);
  }
  if (input.rawBenefitSnapshotRows.length > 0) {
    const { error } = await client.from("raw_benefit_snapshots").insert([...input.rawBenefitSnapshotRows]);
    if (error) throw new Error(`raw_benefit_snapshots insert 실패: ${error.message}`);
  }

  for (const batch of input.cardBatches) {
    await writeCardBatch(client, batch);
  }
}

async function writeCardBatch(client: SupabaseClient, batch: CardWriteBatch): Promise<void> {
  const cardId = batch.cardRow.id;

  // cards: PK(id) 기준 upsert. `card_row`에 created_at을 넣지 않으므로(types.ts 참고) 최초
  // 생성 시각은 DB default로만 정해지고 재수집 시 덮어써지지 않는다.
  const { error: cardError } = await client.from("cards").upsert(batch.cardRow, { onConflict: "id" });
  if (cardError) throw new Error(`cards upsert 실패(${cardId}): ${cardError.message}`);

  // 자식 삭제: spending_benefits/perks.required_tier_id가 performance_tiers.id를 참조하므로
  // (ON DELETE 지정 없음 = NO ACTION), performance_tiers를 지우기 전에 spending_benefits/
  // perks부터 지워야 FK 위반이 나지 않는다. 이 순서로 "카드 단위 전체 교체"를 구현해
  // 재수집 시 사라진 benefit이 DB에 stale로 남는 문제를 없앤다.
  const { error: deleteBenefitsError } = await client.from("spending_benefits").delete().eq("card_id", cardId);
  if (deleteBenefitsError) {
    throw new Error(`spending_benefits delete 실패(${cardId}): ${deleteBenefitsError.message}`);
  }

  const { error: deletePerksError } = await client.from("perks").delete().eq("card_id", cardId);
  if (deletePerksError) throw new Error(`perks delete 실패(${cardId}): ${deletePerksError.message}`);

  const { error: deleteTiersError } = await client.from("performance_tiers").delete().eq("card_id", cardId);
  if (deleteTiersError) {
    throw new Error(`performance_tiers delete 실패(${cardId}): ${deleteTiersError.message}`);
  }

  // 삽입: performance_tiers를 먼저(자식이 참조할 수 있도록), 그다음 spending_benefits/perks.
  if (batch.tierRows.length > 0) {
    const { error } = await client.from("performance_tiers").insert([...batch.tierRows]);
    if (error) throw new Error(`performance_tiers insert 실패(${cardId}): ${error.message}`);
  }
  if (batch.spendingBenefitRows.length > 0) {
    const { error } = await client.from("spending_benefits").insert([...batch.spendingBenefitRows]);
    if (error) throw new Error(`spending_benefits insert 실패(${cardId}): ${error.message}`);
  }
  if (batch.perkRows.length > 0) {
    const { error } = await client.from("perks").insert([...batch.perkRows]);
    if (error) throw new Error(`perks insert 실패(${cardId}): ${error.message}`);
  }
}
