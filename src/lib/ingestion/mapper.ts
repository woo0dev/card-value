import type { NormalizedBenefitPiece, NormalizedCard } from "../card-data/normalizeTypes";
import type { RawBenefitRecord, RawCardRecord } from "../card-data/types";
import type { ValidatedCard } from "../recommendation/types/validation";
import type {
  CardRow,
  PerformanceTierRow,
  PerkRow,
  RawBenefitSnapshotRow,
  RawCardSnapshotRow,
  SpendingBenefitRow,
} from "./types";

/**
 * Domain `Card`(+ `ValidatedCard`)만으로는 DB provenance(`source_benefit_order`/
 * `piece_index`/`original_condition_text`/`extracted_at`)를 복원할 수 없다 — 이 필드들은
 * `SpendingBenefit`/`PerkBenefit`에 없고 `NormalizedCard.benefits[].pieces[].provenance`에만
 * 있다. 그래서 이 파일의 모든 mapper 함수는 `NormalizedCard`와 `ValidatedCard`를 함께 받는다.
 *
 * 짝을 짓는 기준은 정확히 `NormalizedCard.benefits[].pieces[].benefitId === SpendingBenefit.id`
 * (완전한 문자열 일치)다. `id.ts`가 명시하는 대로 이 id 문자열을 split하거나 `-b`/`-0` 같은
 * 구조를 역파싱해서 provenance를 복원하지 않는다.
 */

function buildPieceIndex(normalized: NormalizedCard): ReadonlyMap<string, NormalizedBenefitPiece> {
  const index = new Map<string, NormalizedBenefitPiece>();
  for (const benefit of normalized.benefits) {
    for (const piece of benefit.pieces) {
      index.set(piece.benefitId, piece);
    }
  }
  return index;
}

interface PieceProvenance {
  readonly sourceBenefitOrder: number;
  readonly pieceIndex: number;
  readonly originalConditionText: string;
  readonly extractedAt: string;
}

/**
 * `toDomainCard()`는 fully-parsed piece만 `spendingBenefits`/`perks`로 만들고, 그때 쓰는
 * id(`piece.benefitId`)를 그대로 `SpendingBenefit.id`/`PerkBenefit.id`로 옮긴다(toDomainCard.ts
 * `buildSpendingBenefit`/`buildPerk` 참고) — 그래서 `card`가 `normalized`로부터 만들어진
 * 것이라면 이 조회는 항상 성공해야 한다. 실패하면 두 값이 서로 다른 카드에서 왔다는 뜻이므로
 * 조용히 넘어가지 않고 throw한다.
 */
function requirePieceProvenance(
  pieceIndex: ReadonlyMap<string, NormalizedBenefitPiece>,
  benefitId: string,
): PieceProvenance {
  const piece = pieceIndex.get(benefitId);
  if (piece === undefined) {
    throw new Error(
      `ingestion mapper: 불변식 위반 — benefitId="${benefitId}"에 대응하는 NormalizedCard piece를 찾을 수 없음(normalized와 card가 서로 다른 카드에서 온 것으로 보임)`,
    );
  }
  const { provenance } = piece;
  if (provenance.benefitOrder === null || provenance.pieceIndex === null) {
    throw new Error(
      `ingestion mapper: 불변식 위반 — benefitId="${benefitId}" piece의 provenance.benefitOrder/pieceIndex가 null(카드 단위 값이어야 할 provenance가 benefit piece에 쓰임)`,
    );
  }
  return {
    sourceBenefitOrder: provenance.benefitOrder,
    pieceIndex: provenance.pieceIndex,
    originalConditionText: provenance.originalConditionText,
    extractedAt: provenance.extractedAt,
  };
}

export function buildCardRow(
  card: ValidatedCard,
  rawCard: RawCardRecord,
  updatedAt: string,
): CardRow {
  return {
    id: card.id,
    issuer: card.issuer,
    name: card.name,
    card_type: card.cardType,
    annual_fee_amount: card.annualFee.amount,
    annual_fee_first_year_waived: card.annualFee.firstYearWaived,
    performance_excluded_categories: card.performanceExcludedCategories,
    unverified_conditions: card.unverifiedConditions,
    source_url: card.source.sourceUrl,
    verified_at: card.source.verifiedAt,
    card_code: rawCard.cardCode,
    updated_at: updatedAt,
  };
}

export function buildPerformanceTierRows(card: ValidatedCard): readonly PerformanceTierRow[] {
  return card.performanceTiers.map((tier) => ({
    id: tier.id,
    card_id: card.id,
    name: tier.name,
    min_previous_month_spend: tier.minPreviousMonthSpend,
  }));
}

export function buildSpendingBenefitRows(
  normalized: NormalizedCard,
  card: ValidatedCard,
): readonly SpendingBenefitRow[] {
  const pieceIndex = buildPieceIndex(normalized);
  return card.spendingBenefits.map((benefit): SpendingBenefitRow => {
    const provenance = requirePieceProvenance(pieceIndex, benefit.id);
    const base = {
      id: benefit.id,
      card_id: card.id,
      source_benefit_order: provenance.sourceBenefitOrder,
      piece_index: provenance.pieceIndex,
      name: benefit.name,
      priority: benefit.priority,
      required_tier_id: benefit.requiredTierId,
      target: benefit.target,
      min_monthly_spend: benefit.minMonthlySpend,
      monthly_reward_cap: benefit.limits.monthlyRewardCap,
      monthly_eligible_spend_cap: benefit.limits.monthlyEligibleSpendCap,
      shared_cap_id: benefit.sharedCapId,
      exclusive_group_id: benefit.exclusiveGroupId,
      original_condition_text: provenance.originalConditionText,
      extracted_at: provenance.extractedAt,
    };
    if (benefit.kind === "rate") {
      return { ...base, kind: "rate", rate_bps: benefit.rateBps, monthly_amount: null, currency: benefit.currency };
    }
    return { ...base, kind: "fixed", rate_bps: null, monthly_amount: benefit.monthlyAmount, currency: null };
  });
}

function assertNeverPerkKind(value: never): never {
  throw new Error(`ingestion mapper: 예상하지 못한 perk kind: ${JSON.stringify(value)}`);
}

export function buildPerkRows(normalized: NormalizedCard, card: ValidatedCard): readonly PerkRow[] {
  const pieceIndex = buildPieceIndex(normalized);
  return card.perks.map((perk): PerkRow => {
    const provenance = requirePieceProvenance(pieceIndex, perk.id);
    const base = {
      id: perk.id,
      card_id: card.id,
      source_benefit_order: provenance.sourceBenefitOrder,
      piece_index: provenance.pieceIndex,
      name: perk.name,
      required_tier_id: perk.requiredTierId,
      original_condition_text: provenance.originalConditionText,
      extracted_at: provenance.extractedAt,
    };
    switch (perk.kind) {
      case "voucher":
      case "gift":
        return {
          ...base,
          kind: perk.kind,
          value: perk.value,
          frequency: perk.frequency,
          visits_per_year: null,
          value_per_visit: null,
          requirement: null,
        };
      case "lounge":
        return {
          ...base,
          kind: "lounge",
          value: null,
          frequency: null,
          visits_per_year: perk.visitsPerYear,
          value_per_visit: perk.valuePerVisit,
          requirement: null,
        };
      case "signupBonus":
        return {
          ...base,
          kind: "signupBonus",
          value: perk.value,
          frequency: null,
          visits_per_year: null,
          value_per_visit: null,
          requirement: perk.requirement,
        };
      default:
        return assertNeverPerkKind(perk);
    }
  });
}

export function buildRawCardSnapshotRow(rawCard: RawCardRecord, ingestedAt: string): RawCardSnapshotRow {
  return { card_ad_id: rawCard.cardAdId, ingested_at: ingestedAt, raw: rawCard.raw };
}

export function buildRawBenefitSnapshotRow(
  rawBenefit: RawBenefitRecord,
  ingestedAt: string,
): RawBenefitSnapshotRow {
  return {
    card_ad_id: rawBenefit.cardAdId,
    benefit_order: Number(rawBenefit.benefitOrder),
    ingested_at: ingestedAt,
    raw: rawBenefit.raw,
  };
}
