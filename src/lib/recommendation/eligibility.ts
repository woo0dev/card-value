import type {
  CategorySpending,
  CategoryTarget,
  MonthlySpending,
  NotAppliedReason,
  PerformanceTier,
  PerformanceTierId,
  PerkBenefit,
  SpendingBenefit,
  SpendingCategory,
  Won,
} from "./types";
import { SPENDING_CATEGORIES } from "./types";
import type { ValidatedCard } from "./types/validation";
import { sumWon } from "./rounding";

/**
 * `MonthlySpending` + `ValidatedCard` → 카드의 각 혜택이 구조적으로 적용 대상인지 판정한다.
 *
 * 이 파일은 금액(reward)을 계산하지 않는다. `SpendingBenefit`의 `rate`/`monthlyAmount`,
 * `BenefitLimits`의 한도, `SharedCap` 소진은 전부 `rewards.ts`/`calculator.ts`의 책임이다.
 * 여기서 결정하는 것은 오직: 이 혜택에 이번 달 소비를 적용해도 되는가, 적용된다면 대상
 * 소비액(`eligibleSpend`)이 얼마인가, 배타 그룹이 있다면 누가 이기는가— 뿐이다.
 *
 * `requiredTierId`/`exclusiveGroupId`가 가리키는 구간·혜택 참조는 `validateCard()`가 이미
 * 검증했다고 전제한다(참조 무결성은 여기서 다시 확인하지 않는다). 이 전제가 깨지면(예:
 * 참조하는 tier가 실제로 없음) 조용히 잘못된 결과를 내는 대신 throw한다.
 */

// ---------------------------------------------------------------------------
// 결과 타입 (이 파일 안에서만 export — `types/`에는 추가하지 않는다)
// ---------------------------------------------------------------------------

/** 소비 혜택 하나의 구조적 적격성 판정 결과. `eligibleSpend`는 eligible/not_applied 여부와
 * 무관하게 항상 계산되어 남는다(왜 그렇게 설계했는지는 `evaluateSpendingBenefit` 참고). */
export type SpendingBenefitEligibility =
  | {
      readonly status: "eligible";
      readonly benefit: SpendingBenefit;
      readonly eligibleSpend: Won;
    }
  | {
      readonly status: "not_applied";
      readonly benefit: SpendingBenefit;
      readonly eligibleSpend: Won;
      readonly reason: NotAppliedReason;
    };

/** 부가 혜택 하나의 구조적 적격성 판정 결과. `PerkBase`에는 tier 조건뿐이라 금액 관련
 * 필드가 없다 — `eligibleSpend`/`minMonthlySpend`/`exclusiveGroupId` 개념 자체가 없다. */
export type PerkEligibility =
  | { readonly status: "eligible"; readonly perk: PerkBenefit }
  | {
      readonly status: "not_applied";
      readonly perk: PerkBenefit;
      readonly reason: Extract<NotAppliedReason, { code: "TIER_NOT_MET" }>;
    };

export interface CardEligibility {
  readonly achievedTierId: PerformanceTierId | null;
  readonly previousMonthPerformance: Won;
  readonly spendingBenefits: readonly SpendingBenefitEligibility[];
  readonly perks: readonly PerkEligibility[];
}

// ---------------------------------------------------------------------------
// tier 조회 / 비교
// ---------------------------------------------------------------------------

const ZERO_WON = sumWon([]);

/** 카드 안에서 `PerformanceTierId` → `PerformanceTier` 조회. 배열 순서에 의존하지 않는다. */
function buildTierIndex(tiers: readonly PerformanceTier[]): ReadonlyMap<PerformanceTierId, PerformanceTier> {
  return new Map(tiers.map((tier) => [tier.id, tier]));
}

/**
 * `tierId`가 가리키는 `PerformanceTier`를 찾는다. `validateCard()`가 이미 참조 무결성을
 * 보장하므로 여기서 못 찾는 것은 이 파일이 기대하는 불변식 위반이다 — 조용히 넘어가지
 * 않고 throw한다.
 */
function requireTier(
  tierId: PerformanceTierId,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): PerformanceTier {
  const tier = tierIndex.get(tierId);
  if (!tier) {
    throw new Error(
      `eligibility: 불변식 위반 — requiredTierId가 카드의 performanceTiers에 없음(tierId="${tierId}"). validateCard()를 통과한 ValidatedCard여야 한다.`,
    );
  }
  return tier;
}

/**
 * 구간의 "높이"를 비교 가능한 숫자로 바꾼다. `null`(구간 조건 없음)은 모든 실제 구간보다
 * 낮게 취급한다(`benefit.ts`의 `exclusiveGroupId` 문서 그대로). 실제 구간 threshold는
 * 전부 0 이상이므로 `-1`은 항상 그보다 낮다.
 */
function tierRank(
  tierId: PerformanceTierId | null,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): number {
  if (tierId === null) return -1;
  return requireTier(tierId, tierIndex).minPreviousMonthSpend;
}

/**
 * `achievedTierId`가 `requiredTierId` 조건을 만족하는지. `requiredTierId`가 `null`이면
 * 항상 만족한다. 그 외에는 달성 구간의 `minPreviousMonthSpend`가 요구 구간의
 * `minPreviousMonthSpend` 이상이어야 한다(배열 순서가 아니라 금액 비교, `benefit.ts` 문서 그대로).
 */
function meetsRequiredTier(
  requiredTierId: PerformanceTierId | null,
  achievedTierId: PerformanceTierId | null,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): boolean {
  return tierRank(achievedTierId, tierIndex) >= tierRank(requiredTierId, tierIndex);
}

// ---------------------------------------------------------------------------
// achievedTier
// ---------------------------------------------------------------------------

function sumCategorySpending(spending: CategorySpending, categories: readonly SpendingCategory[]): Won {
  return sumWon(categories.map((category) => spending[category] ?? ZERO_WON));
}

/**
 * 전월실적 = `previousMonth` 합계에서 `performanceExcludedCategories`를 뺀 값.
 * (`performanceExcludedCategories`는 현재 `toDomainCard()`가 항상 `[]`로 채우는 알려진
 * 한계다 — 이 함수는 그 값을 그대로 신뢰하고 쓸 뿐, 여기서 다시 채우거나 바꾸지 않는다.)
 */
function computePreviousMonthPerformance(
  previousMonth: CategorySpending,
  excludedCategories: readonly SpendingCategory[],
): Won {
  const excluded = new Set<SpendingCategory>(excludedCategories);
  const included = SPENDING_CATEGORIES.filter((category) => !excluded.has(category));
  return sumCategorySpending(previousMonth, included);
}

/** 달성한 구간(`minPreviousMonthSpend` 이하 중 가장 큰 것). 배열 순서를 쓰지 않는다. */
function computeAchievedTierId(
  tiers: readonly PerformanceTier[],
  previousMonthPerformance: Won,
): PerformanceTierId | null {
  let achieved: PerformanceTier | null = null;
  for (const tier of tiers) {
    if (previousMonthPerformance < tier.minPreviousMonthSpend) continue;
    if (achieved === null || tier.minPreviousMonthSpend > achieved.minPreviousMonthSpend) {
      achieved = tier;
    }
  }
  return achieved?.id ?? null;
}

// ---------------------------------------------------------------------------
// SpendingBenefit
// ---------------------------------------------------------------------------

/** `CategoryTarget`을 실제 카테고리 목록으로 펼친다. `allExcept`는 21개 카테고리 전체에서 뺀다. */
function expandCategoryTarget(target: CategoryTarget): readonly SpendingCategory[] {
  if (target.type === "categories") return target.categories;
  const excluded = new Set<SpendingCategory>(target.categories);
  return SPENDING_CATEGORIES.filter((category) => !excluded.has(category));
}

/**
 * 소비 혜택 하나를 개별적으로(배타 그룹 경쟁 이전 단계로) 판정한다. 확정된 순서:
 * 1) required tier 확인 → 실패하면 그 자리에서 `TIER_NOT_MET` (§2 minMonthlySpend는 보지 않는다)
 * 2) target 기준 eligibleSpend 계산
 * 3) minMonthlySpend 확인
 *
 * `eligibleSpend`는 tier 실패 여부와 무관하게 항상 계산해서 결과에 남긴다 — 이후 단계가
 * "실제로 얼마를 썼는지"를 tier 실패 케이스에서도 참고할 수 있어야 하기 때문이다. tier
 * 확인이 minMonthlySpend 확인보다 먼저라는 것은 "둘 다 실패해도 사유는 tier 쪽을 report
 * 한다"는 뜻이지, eligibleSpend 계산 자체를 건너뛴다는 뜻이 아니다.
 */
function evaluateSpendingBenefit(
  benefit: SpendingBenefit,
  achievedTierId: PerformanceTierId | null,
  previousMonthPerformance: Won,
  currentMonth: CategorySpending,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): SpendingBenefitEligibility {
  const eligibleSpend = sumCategorySpending(currentMonth, expandCategoryTarget(benefit.target));

  if (!meetsRequiredTier(benefit.requiredTierId, achievedTierId, tierIndex)) {
    // requiredTierId가 null이면 meetsRequiredTier가 항상 true이므로, 여기 도달했다는 것은
    // requiredTierId가 실제로 존재한다는 뜻이다(non-null assertion이 아니라 논리적 귀결).
    const requiredTierId = benefit.requiredTierId as PerformanceTierId;
    return {
      status: "not_applied",
      benefit,
      eligibleSpend,
      reason: {
        code: "TIER_NOT_MET",
        requiredTierId,
        previousMonthPerformance,
        requiredSpend: requireTier(requiredTierId, tierIndex).minPreviousMonthSpend,
      },
    };
  }

  if (benefit.minMonthlySpend === null) {
    if (eligibleSpend === ZERO_WON) {
      return { status: "not_applied", benefit, eligibleSpend, reason: { code: "NO_ELIGIBLE_SPEND" } };
    }
  } else if (eligibleSpend < benefit.minMonthlySpend) {
    return {
      status: "not_applied",
      benefit,
      eligibleSpend,
      reason: { code: "MIN_MONTHLY_SPEND_NOT_MET", required: benefit.minMonthlySpend, actual: eligibleSpend },
    };
  }

  return { status: "eligible", benefit, eligibleSpend };
}

/**
 * 배타 그룹 승자 결정. `benefit.ts`(`SpendingBenefitBase.exclusiveGroupId`)에 이미 정의된
 * 규칙을 그대로 구현한다 — 새 규칙을 추가하지 않는다:
 * 1) eligible 조건을 모두 통과한 혜택만 후보
 * 2) requiredTierId 구간이 더 높은 혜택 우선(`minPreviousMonthSpend` 비교, 배열 순서 아님)
 * 3) 같은 구간이면 priority가 낮은 혜택 우선
 * 4) priority까지 같으면 id 오름차순
 * 승자가 아닌 후보는 `SUPERSEDED_IN_EXCLUSIVE_GROUP`으로 재분류된다.
 */
function resolveExclusiveGroups(
  evaluations: readonly SpendingBenefitEligibility[],
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): readonly SpendingBenefitEligibility[] {
  const groups = new Map<string, SpendingBenefitEligibility[]>();
  for (const evaluation of evaluations) {
    if (evaluation.status !== "eligible") continue;
    const groupId = evaluation.benefit.exclusiveGroupId;
    if (groupId === null) continue;
    const members = groups.get(groupId) ?? [];
    members.push(evaluation);
    groups.set(groupId, members);
  }

  const superseded = new Map<string, SpendingBenefitEligibility>(); // benefitId -> 대체된 결과

  for (const members of groups.values()) {
    if (members.length < 2) continue; // 단독 멤버는 경쟁 상대가 없으므로 그대로 eligible

    const winner = members.reduce((best, candidate) => {
      const bestTier = tierRank(best.benefit.requiredTierId, tierIndex);
      const candidateTier = tierRank(candidate.benefit.requiredTierId, tierIndex);
      if (candidateTier !== bestTier) return candidateTier > bestTier ? candidate : best;
      if (candidate.benefit.priority !== best.benefit.priority) {
        return candidate.benefit.priority < best.benefit.priority ? candidate : best;
      }
      return candidate.benefit.id < best.benefit.id ? candidate : best;
    });

    for (const member of members) {
      if (member.benefit.id === winner.benefit.id) continue;
      const groupId = member.benefit.exclusiveGroupId;
      if (groupId === null) continue; // 이 분기에 도달할 수 없지만 타입 좁히기용
      superseded.set(member.benefit.id, {
        status: "not_applied",
        benefit: member.benefit,
        eligibleSpend: member.status === "eligible" ? member.eligibleSpend : ZERO_WON,
        reason: { code: "SUPERSEDED_IN_EXCLUSIVE_GROUP", groupId, supersededBy: winner.benefit.id },
      });
    }
  }

  return evaluations.map((evaluation) => superseded.get(evaluation.benefit.id) ?? evaluation);
}

// ---------------------------------------------------------------------------
// PerkBenefit
// ---------------------------------------------------------------------------

/** 부가 혜택은 tier 조건뿐이다(§4). 금전적 가치는 계산하지 않는다. */
function evaluatePerk(
  perk: PerkBenefit,
  achievedTierId: PerformanceTierId | null,
  previousMonthPerformance: Won,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): PerkEligibility {
  if (!meetsRequiredTier(perk.requiredTierId, achievedTierId, tierIndex)) {
    const requiredTierId = perk.requiredTierId as PerformanceTierId;
    return {
      status: "not_applied",
      perk,
      reason: {
        code: "TIER_NOT_MET",
        requiredTierId,
        previousMonthPerformance,
        requiredSpend: requireTier(requiredTierId, tierIndex).minPreviousMonthSpend,
      },
    };
  }
  return { status: "eligible", perk };
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export function evaluateCardEligibility(card: ValidatedCard, spending: MonthlySpending): CardEligibility {
  const tierIndex = buildTierIndex(card.performanceTiers);
  const previousMonthPerformance = computePreviousMonthPerformance(
    spending.previousMonth,
    card.performanceExcludedCategories,
  );
  const achievedTierId = computeAchievedTierId(card.performanceTiers, previousMonthPerformance);

  const individuallyEvaluated = card.spendingBenefits.map((benefit) =>
    evaluateSpendingBenefit(benefit, achievedTierId, previousMonthPerformance, spending.currentMonth, tierIndex),
  );
  const spendingBenefits = resolveExclusiveGroups(individuallyEvaluated, tierIndex);

  const perks = card.perks.map((perk) => evaluatePerk(perk, achievedTierId, previousMonthPerformance, tierIndex));

  return { achievedTierId, previousMonthPerformance, spendingBenefits, perks };
}
