import type {
  BasisPoints,
  BenefitId,
  Card,
  CardId,
  CardType,
  CategoryTarget,
  ExclusiveGroupId,
  PerformanceTier,
  PerformanceTierId,
  PerkBenefit,
  RewardCurrency,
  SharedCapId,
  SpendingBenefit,
  SpendingCategory,
  UnverifiedCondition,
  Won,
} from "../recommendation/types";

/**
 * Supabase nested select 결과(§`loadCards.ts`) → Domain `Card` 변환.
 *
 * 원칙: 값이 없다는 이유로 임의의 fallback/default를 만들지 않는다. DB 값이 Domain 타입과
 * 맞지 않으면(예: 알 수 없는 `kind`, discriminant에 맞지 않는 null 조합) 조용히 넘어가지
 * 않고 `DbMapperError`를 던진다 — 이 mapper가 shape 자체를 잘못 옮기면 이후 `validateCard()`가
 * 잡아줄 수 없는 문제(예: TypeScript 유니온과 실제 값 불일치)이기 때문이다. 반대로 JSONB
 * 필드(`target`/`currency`/`unverified_conditions`/`performance_excluded_categories`/
 * `requirement`) 안의 **값 자체**가 도메인 규칙에 맞는지(예: `categories`가 실제 알려진
 * `SpendingCategory`인지)는 이 mapper의 책임이 아니다 — `recommendCards()`가 내부에서
 * 호출하는 `validateCard()`가 그 검증을 그대로 담당한다.
 *
 * `card_code`/`source_benefit_order`/`piece_index`/`original_condition_text`/`extracted_at`은
 * Domain `Card`/`SpendingBenefit`/`PerkBenefit` 어디에도 없는 DB 전용 provenance 필드라
 * 여기서 읽지 않고 버린다(반대 방향인 `src/lib/ingestion/mapper.ts`가 이 필드들을 채우는
 * 이유이기도 하다).
 */

export class DbMapperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbMapperError";
  }
}

export interface DbPerformanceTierRow {
  readonly id: string;
  readonly card_id: string;
  readonly name: string;
  readonly min_previous_month_spend: number;
}

export interface DbSpendingBenefitRow {
  readonly id: string;
  readonly card_id: string;
  readonly source_benefit_order: number;
  readonly piece_index: number;
  readonly name: string;
  readonly priority: number;
  readonly required_tier_id: string | null;
  readonly target: unknown;
  readonly min_monthly_spend: number | null;
  readonly monthly_reward_cap: number | null;
  readonly monthly_eligible_spend_cap: number | null;
  readonly shared_cap_id: string | null;
  readonly exclusive_group_id: string | null;
  readonly kind: string;
  readonly rate_bps: number | null;
  readonly monthly_amount: number | null;
  readonly currency: unknown;
  readonly original_condition_text: string | null;
  readonly extracted_at: string;
}

export interface DbPerkRow {
  readonly id: string;
  readonly card_id: string;
  readonly source_benefit_order: number;
  readonly piece_index: number;
  readonly name: string;
  readonly required_tier_id: string | null;
  readonly kind: string;
  readonly value: number | null;
  readonly frequency: string | null;
  readonly visits_per_year: number | null;
  readonly value_per_visit: number | null;
  readonly requirement: unknown;
  readonly original_condition_text: string | null;
  readonly extracted_at: string;
}

export interface DbCardRow {
  readonly id: string;
  readonly issuer: string;
  readonly name: string;
  readonly card_type: string;
  readonly annual_fee_amount: number;
  readonly annual_fee_first_year_waived: boolean;
  readonly performance_excluded_categories: unknown;
  readonly unverified_conditions: unknown;
  readonly source_url: string;
  readonly verified_at: string | null;
  readonly card_code: string | null;
  readonly performance_tiers: readonly DbPerformanceTierRow[];
  readonly spending_benefits: readonly DbSpendingBenefitRow[];
  readonly perks: readonly DbPerkRow[];
}

// ---------------------------------------------------------------------------
// 브랜드 캐스팅 helper — `id.ts`/`toDomainCard.ts`와 같은 패턴(문자열/숫자를 그대로
// brand로 캐스팅, 값 자체를 해석하거나 변형하지 않는다).
// ---------------------------------------------------------------------------

function asCardId(value: string): CardId {
  return value as CardId;
}
function asBenefitId(value: string): BenefitId {
  return value as BenefitId;
}
function asPerformanceTierId(value: string): PerformanceTierId {
  return value as PerformanceTierId;
}
function asPerformanceTierIdOrNull(value: string | null): PerformanceTierId | null {
  return value === null ? null : asPerformanceTierId(value);
}
function asSharedCapId(value: string): SharedCapId {
  return value as SharedCapId;
}
function asExclusiveGroupId(value: string): ExclusiveGroupId {
  return value as ExclusiveGroupId;
}
function asWon(value: number): Won {
  return value as Won;
}
function asWonOrNull(value: number | null): Won | null {
  return value === null ? null : asWon(value);
}
function asBasisPoints(value: number): BasisPoints {
  return value as BasisPoints;
}

function mapCardType(value: string): CardType {
  if (value === "credit" || value === "check" || value === "unknown") return value;
  throw new DbMapperError(`db mapper: 알 수 없는 card_type="${value}"`);
}

function mapPerformanceTier(row: DbPerformanceTierRow): PerformanceTier {
  return {
    id: asPerformanceTierId(row.id),
    name: row.name,
    minPreviousMonthSpend: asWon(row.min_previous_month_spend),
  };
}

function mapSpendingBenefit(row: DbSpendingBenefitRow): SpendingBenefit {
  const base = {
    id: asBenefitId(row.id),
    name: row.name,
    priority: row.priority,
    requiredTierId: asPerformanceTierIdOrNull(row.required_tier_id),
    target: row.target as CategoryTarget,
    minMonthlySpend: asWonOrNull(row.min_monthly_spend),
    limits: {
      monthlyRewardCap: asWonOrNull(row.monthly_reward_cap),
      monthlyEligibleSpendCap: asWonOrNull(row.monthly_eligible_spend_cap),
    },
    sharedCapId: row.shared_cap_id === null ? null : asSharedCapId(row.shared_cap_id),
    exclusiveGroupId: row.exclusive_group_id === null ? null : asExclusiveGroupId(row.exclusive_group_id),
  };

  if (row.kind === "rate") {
    if (row.rate_bps === null || row.currency === null) {
      throw new DbMapperError(
        `db mapper: spending_benefits id="${row.id}"의 kind="rate"인데 rate_bps 또는 currency가 null`,
      );
    }
    return { ...base, kind: "rate", rateBps: asBasisPoints(row.rate_bps), currency: row.currency as RewardCurrency };
  }
  if (row.kind === "fixed") {
    if (row.monthly_amount === null) {
      throw new DbMapperError(`db mapper: spending_benefits id="${row.id}"의 kind="fixed"인데 monthly_amount가 null`);
    }
    return { ...base, kind: "fixed", monthlyAmount: asWon(row.monthly_amount) };
  }
  throw new DbMapperError(`db mapper: spending_benefits id="${row.id}"의 알 수 없는 kind="${row.kind}"`);
}

function mapPerk(row: DbPerkRow): PerkBenefit {
  const base = {
    id: asBenefitId(row.id),
    name: row.name,
    requiredTierId: asPerformanceTierIdOrNull(row.required_tier_id),
  };

  switch (row.kind) {
    case "voucher":
    case "gift": {
      if (row.value === null || row.frequency === null) {
        throw new DbMapperError(`db mapper: perks id="${row.id}"의 kind="${row.kind}"인데 value 또는 frequency가 null`);
      }
      if (row.frequency !== "monthly" && row.frequency !== "yearly" && row.frequency !== "once") {
        throw new DbMapperError(`db mapper: perks id="${row.id}"의 알 수 없는 frequency="${row.frequency}"`);
      }
      return { ...base, kind: row.kind, value: asWon(row.value), frequency: row.frequency };
    }
    case "lounge": {
      if (row.visits_per_year === null || row.value_per_visit === null) {
        throw new DbMapperError(
          `db mapper: perks id="${row.id}"의 kind="lounge"인데 visits_per_year 또는 value_per_visit이 null`,
        );
      }
      return { ...base, kind: "lounge", visitsPerYear: row.visits_per_year, valuePerVisit: asWon(row.value_per_visit) };
    }
    case "signupBonus": {
      if (row.value === null) {
        throw new DbMapperError(`db mapper: perks id="${row.id}"의 kind="signupBonus"인데 value가 null`);
      }
      return {
        ...base,
        kind: "signupBonus",
        value: asWon(row.value),
        requirement: row.requirement as { minSpend: Won; withinMonths: number } | null,
      };
    }
    default:
      throw new DbMapperError(`db mapper: perks id="${row.id}"의 알 수 없는 kind="${row.kind}"`);
  }
}

export function mapDbCardToCard(row: DbCardRow): Card {
  return {
    id: asCardId(row.id),
    issuer: row.issuer,
    name: row.name,
    cardType: mapCardType(row.card_type),
    annualFee: {
      amount: asWon(row.annual_fee_amount),
      firstYearWaived: row.annual_fee_first_year_waived,
    },
    performanceTiers: row.performance_tiers.map(mapPerformanceTier),
    performanceExcludedCategories: row.performance_excluded_categories as readonly SpendingCategory[],
    // shared_caps 테이블이 아직 없다(읽기 전용 분석 §4/§5) — Domain Card.sharedCaps는 항상 [].
    sharedCaps: [],
    spendingBenefits: row.spending_benefits.map(mapSpendingBenefit),
    perks: row.perks.map(mapPerk),
    source: {
      sourceUrl: row.source_url,
      verifiedAt: row.verified_at,
    },
    unverifiedConditions: row.unverified_conditions as readonly UnverifiedCondition[],
  };
}
