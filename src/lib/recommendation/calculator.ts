import type {
  AppliedBenefitCalculation,
  BenefitCalculation,
  BenefitId,
  CalculationAssumptions,
  CalculationStep,
  CalculationWarning,
  MonthlySpending,
  NotAppliedBenefitCalculation,
  NotAppliedReason,
  PerformanceTier,
  PerformanceTierId,
  SharedCap,
  SharedCapId,
  SharedCapTierLimit,
  SpendingBenefit,
  Won,
} from "./types";
import type { CardValueResult } from "./types/result";
import type { ValidatedCard } from "./types/validation";
import { evaluateCardEligibility, type SpendingBenefitEligibility } from "./eligibility";
import { computeSpendingBenefitReward } from "./rewards";
import { multiplyWon, subtractWon, sumWon } from "./rounding";

/**
 * `ValidatedCard` + `MonthlySpending` → 카드 1장의 `CardValueResult`.
 *
 * 이 파일이 하는 일: `eligibility.ts`(구조적 적격성) → `rewards.ts`(개별 혜택 금액) 결과를
 * 받아 SharedCap 통합 한도를 배분하고, 월 합계를 연간으로 환산하고, 연회비를 뺀다.
 * 적격성 판정과 개별 혜택 금액 계산 자체는 다시 하지 않는다(각각의 파일 책임).
 *
 * 이번 범위에서 확정한 정책:
 * - `SHARED_CAP_EXHAUSTED`: SharedCap 배분 차례에 남은 한도가 정확히 0이면 그 혜택을
 *   `not_applied`로 재분류한다. 남은 한도가 0보다 크지만 원래 금액보다 작으면 `applied`를
 *   유지하되 `SHARED_CAP_APPLIED` step을 추가하고 `finalAmount`를 남은 한도로 줄인다.
 *   남은 한도가 원래 금액 이상이면 그대로 둔다.
 * - `annualizationMonths`는 이 파일 안에 기본값을 두지 않는다. 반드시 `assumptions`로 받는다.
 * - `PerkBenefit`의 금전적 가치는 이번 범위에서 계산하지 않는다(실현 입력이 아직 없음).
 *   `annualPerkValue`/`firstYearOnlyPerkValue`는 0, `perkCalculations`는 빈 배열이다.
 * - `card.unverifiedConditions`는 각각 `CalculationWarning.UNVERIFIED_CONDITION`으로
 *   그대로 옮긴다. `FIRST_YEAR_FEE_WAIVED`는 `card.annualFee.firstYearWaived`가 참일 때만
 *   추가한다(연회비 차감 자체는 항상 `card.annualFee.amount` 전액으로 한다).
 *   `POINT_VALUATION_UNVERIFIED`는 발동 조건이 코드에 정의돼 있지 않으므로 이번에 추가하지 않는다.
 *
 * `SharedCap`, ranking, `index.ts` 오케스트레이션은 이 파일의 책임이 아니다.
 */

const ZERO_WON = sumWon([]);

// ---------------------------------------------------------------------------
// tier 조회 (eligibility.ts와 같은 패턴이지만, SharedCap.tierLimits 선택에 쓰이는 별도 복사본이다 —
// eligibility.ts는 이 헬퍼를 export하지 않으므로 여기서 다시 만든다)
// ---------------------------------------------------------------------------

function buildTierIndex(tiers: readonly PerformanceTier[]): ReadonlyMap<PerformanceTierId, PerformanceTier> {
  return new Map(tiers.map((tier) => [tier.id, tier]));
}

/** `null`은 모든 실제 구간보다 낮게 취급한다(`benefit.ts` 문서 그대로, eligibility.ts와 동일 규칙). */
function tierRank(
  tierId: PerformanceTierId | null,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): number {
  if (tierId === null) return -1;
  const tier = tierIndex.get(tierId);
  if (!tier) {
    throw new Error(
      `calculator: 불변식 위반 — tierId가 카드의 performanceTiers에 없음(tierId="${tierId}"). validateCard()를 통과한 ValidatedCard여야 한다.`,
    );
  }
  return tier.minPreviousMonthSpend;
}

/**
 * `SharedCap`에 적용할 실제 한도. `tierLimits` 중 달성한 구간(`achievedTierId` 이하)의 것
 * 가운데 `minPreviousMonthSpend`가 가장 큰 구간의 `monthlyRewardCap`을 쓰고, 해당하는
 * 구간이 없으면 `defaultMonthlyRewardCap`을 쓴다(`benefit.ts`의 `SharedCap` 문서 그대로,
 * 배열 순서에 의존하지 않는다).
 */
function resolveSharedCapLimit(
  sharedCap: SharedCap,
  achievedTierId: PerformanceTierId | null,
  tierIndex: ReadonlyMap<PerformanceTierId, PerformanceTier>,
): Won {
  const achievedRank = tierRank(achievedTierId, tierIndex);

  let selected: SharedCapTierLimit | null = null;
  let selectedRank = -1;
  for (const tierLimit of sharedCap.tierLimits) {
    const rank = tierRank(tierLimit.tierId, tierIndex);
    if (rank > achievedRank) continue; // 아직 달성하지 못한 구간
    if (selected === null || rank > selectedRank) {
      selected = tierLimit;
      selectedRank = rank;
    }
  }

  return selected?.monthlyRewardCap ?? sharedCap.defaultMonthlyRewardCap;
}

// ---------------------------------------------------------------------------
// BenefitCalculation 통합
// ---------------------------------------------------------------------------

/**
 * eligibility.ts가 `not_applied`로 판정한 결과를 `NotAppliedBenefitCalculation`으로 직접
 * 조립한다. `rewards.ts`는 호출하지 않는다(적용 대상이 아니므로 금액을 계산할 필요가 없다).
 * `steps`의 마지막 원소가 `reason`과 정확히 같아야 한다는 `calculation.ts`의 제약을 지키기
 * 위해 같은 객체 참조를 그대로 재사용한다.
 */
function buildNotAppliedFromEligibility(
  evaluation: Extract<SpendingBenefitEligibility, { status: "not_applied" }>,
): NotAppliedBenefitCalculation {
  const steps: CalculationStep[] = [
    { code: "ELIGIBLE_SPEND_COMPUTED", eligibleSpend: evaluation.eligibleSpend },
    evaluation.reason,
  ];
  return {
    status: "not_applied",
    benefitId: evaluation.benefit.id,
    eligibleSpend: evaluation.eligibleSpend,
    rawAmount: ZERO_WON,
    finalAmount: ZERO_WON,
    reason: evaluation.reason,
    steps,
  };
}

interface EligibleReward {
  benefit: SpendingBenefit;
  calculation: AppliedBenefitCalculation;
}

/**
 * 같은 `sharedCapId`를 가진 applied 결과들에 통합 한도를 배분한다. 원본 `AppliedBenefitCalculation`
 * 객체는 mutate하지 않고 항상 새 결과를 만든다.
 *
 * 배분 순서: `priority` 오름차순 → 같으면 `benefit.id` 오름차순(문자열 코드 유닛 순).
 * 총 배분량은 항상 `min(cap, 개별 finalAmount 합)`이 되며, 순서는 어느 혜택이 한도를
 * 먼저 쓴 것으로 표시되는지(귀속)만 바꾼다.
 */
function allocateSharedCap(
  sharedCapId: SharedCapId,
  limit: Won,
  members: readonly EligibleReward[],
): readonly BenefitCalculation[] {
  const sorted = [...members].sort((a, b) => {
    if (a.benefit.priority !== b.benefit.priority) return a.benefit.priority - b.benefit.priority;
    if (a.benefit.id < b.benefit.id) return -1;
    if (a.benefit.id > b.benefit.id) return 1;
    return 0;
  });

  const results: BenefitCalculation[] = [];
  let remaining = limit;

  for (const member of sorted) {
    const reward = member.calculation.finalAmount;

    if (remaining >= reward) {
      results.push(member.calculation);
      remaining = subtractWon(remaining, reward);
      continue;
    }

    if (remaining > ZERO_WON) {
      const step: CalculationStep = {
        code: "SHARED_CAP_APPLIED",
        sharedCapId,
        cap: limit,
        before: reward,
        after: remaining,
      };
      results.push({
        status: "applied",
        benefitId: member.calculation.benefitId,
        eligibleSpend: member.calculation.eligibleSpend,
        rawAmount: member.calculation.rawAmount,
        finalAmount: remaining,
        steps: [...member.calculation.steps, step],
      });
      remaining = ZERO_WON;
      continue;
    }

    // remaining === 0: 이 혜택 차례가 됐을 때 통합 한도가 이미 소진됨.
    const reason: NotAppliedReason = { code: "SHARED_CAP_EXHAUSTED", sharedCapId };
    results.push({
      status: "not_applied",
      benefitId: member.calculation.benefitId,
      eligibleSpend: member.calculation.eligibleSpend,
      rawAmount: member.calculation.rawAmount,
      finalAmount: ZERO_WON,
      reason,
      steps: [...member.calculation.steps, reason],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export function calculateCardValue(
  card: ValidatedCard,
  spending: MonthlySpending,
  assumptions: CalculationAssumptions,
): CardValueResult {
  const eligibility = evaluateCardEligibility(card, spending);
  const tierIndex = buildTierIndex(card.performanceTiers);
  const sharedCapIndex = new Map<SharedCapId, SharedCap>(card.sharedCaps.map((cap) => [cap.id, cap]));

  const calculationsByBenefitId = new Map<BenefitId, BenefitCalculation>();
  const sharedCapGroups = new Map<SharedCapId, EligibleReward[]>();

  for (const evaluation of eligibility.spendingBenefits) {
    if (evaluation.status === "not_applied") {
      calculationsByBenefitId.set(evaluation.benefit.id, buildNotAppliedFromEligibility(evaluation));
      continue;
    }

    const calculation = computeSpendingBenefitReward(evaluation.benefit, evaluation.eligibleSpend);
    const sharedCapId = evaluation.benefit.sharedCapId;

    if (sharedCapId === null) {
      calculationsByBenefitId.set(evaluation.benefit.id, calculation);
      continue;
    }

    const group = sharedCapGroups.get(sharedCapId) ?? [];
    group.push({ benefit: evaluation.benefit, calculation });
    sharedCapGroups.set(sharedCapId, group);
  }

  for (const [sharedCapId, members] of sharedCapGroups) {
    const sharedCap = sharedCapIndex.get(sharedCapId);
    if (!sharedCap) {
      throw new Error(
        `calculator: 불변식 위반 — sharedCapId가 카드의 sharedCaps에 없음(sharedCapId="${sharedCapId}"). validateCard()를 통과한 ValidatedCard여야 한다.`,
      );
    }
    const limit = resolveSharedCapLimit(sharedCap, eligibility.achievedTierId, tierIndex);
    const allocated = allocateSharedCap(sharedCapId, limit, members);
    for (const calc of allocated) {
      calculationsByBenefitId.set(calc.benefitId, calc);
    }
  }

  const benefitCalculations = card.spendingBenefits.map((benefit) => {
    const calculation = calculationsByBenefitId.get(benefit.id);
    if (!calculation) {
      throw new Error(`calculator: 불변식 위반 — benefitId="${benefit.id}"에 대한 계산 결과가 없음.`);
    }
    return calculation;
  });

  const monthlyBenefit = sumWon(
    benefitCalculations
      .filter((calc): calc is AppliedBenefitCalculation => calc.status === "applied")
      .map((calc) => calc.finalAmount),
  );
  const annualSpendingBenefit = multiplyWon(monthlyBenefit, assumptions.annualizationMonths);

  // Perk 금전 가치는 이번 범위에서 계산하지 않는다 (파일 상단 정책 참고).
  const annualPerkValue = ZERO_WON;
  const firstYearOnlyPerkValue = ZERO_WON;

  const annualBenefit = sumWon([annualSpendingBenefit, annualPerkValue]);
  const annualFee = card.annualFee.amount;
  const netAnnualValue = subtractWon(annualBenefit, annualFee);

  const warnings: CalculationWarning[] = [
    ...card.unverifiedConditions.map(
      (condition): CalculationWarning => ({
        code: "UNVERIFIED_CONDITION",
        field: condition.field,
        benefitId: condition.benefitId,
      }),
    ),
    ...(card.annualFee.firstYearWaived ? [{ code: "FIRST_YEAR_FEE_WAIVED" } as const] : []),
  ];

  return {
    cardId: card.id,
    achievedTierId: eligibility.achievedTierId,
    previousMonthPerformance: eligibility.previousMonthPerformance,
    monthlyBenefit,
    annualSpendingBenefit,
    annualPerkValue,
    annualBenefit,
    annualFee,
    netAnnualValue,
    firstYearOnlyPerkValue,
    benefitCalculations,
    perkCalculations: [],
    warnings,
  };
}
