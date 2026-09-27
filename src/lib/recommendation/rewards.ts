import type {
  AppliedBenefitCalculation,
  CalculationStep,
  FixedBenefit,
  RateBenefit,
  SpendingBenefit,
  Won,
} from "./types";
import { applyBasisPoints, applyPointRateAsWon } from "./rounding";

/**
 * 혜택 하나(`SpendingBenefit`)와 그 혜택에 이미 계산된 `eligibleSpend`를 받아 reward 금액을
 * 계산한다. tier/minMonthlySpend 같은 자격 판정은 `eligibility.ts`의 책임이므로 여기서
 * 다시 하지 않는다 — 이 파일은 "적용 가능하다고 이미 확인된 혜택"의 금액만 계산한다.
 *
 * 따라서 이 파일이 반환하는 결과는 항상 `AppliedBenefitCalculation`이다. `NotAppliedReason`의
 * 다섯 가지 사유(`TIER_NOT_MET`, `NO_ELIGIBLE_SPEND`, `MIN_MONTHLY_SPEND_NOT_MET`,
 * `SUPERSEDED_IN_EXCLUSIVE_GROUP`) 판정은 `eligibility.ts`가 이미 끝냈고, 나머지 한 사유
 * (`SHARED_CAP_EXHAUSTED`)는 여러 혜택에 걸친 통합 한도 정보가 있어야 판정 가능해서 이
 * 파일의 범위 밖이다(`calculator.ts`의 책임). 개별 `monthlyRewardCap`이 금액을 0까지
 * 깎아도 이는 "적용됐지만 한도로 0원"이지 "미적용"이 아니므로 여전히 `applied`다.
 *
 * `SharedCap`, 연간 환산, 연회비, 카드 오케스트레이션, ranking은 이 파일의 책임이 아니다.
 * `PerkBenefit`의 금전적 가치도 이 파일이 계산하지 않는다(아래 문서 참고).
 */

function applyEligibleSpendCap(benefit: RateBenefit, eligibleSpend: Won, steps: CalculationStep[]): Won {
  const cap = benefit.limits.monthlyEligibleSpendCap;
  if (cap === null || eligibleSpend <= cap) return eligibleSpend;
  steps.push({ code: "ELIGIBLE_SPEND_CAPPED", cap, before: eligibleSpend, after: cap });
  return cap;
}

function applyBenefitRewardCap(benefit: SpendingBenefit, rawAmount: Won, steps: CalculationStep[]): Won {
  const cap = benefit.limits.monthlyRewardCap;
  if (cap === null || rawAmount <= cap) return rawAmount;
  steps.push({ code: "BENEFIT_CAP_APPLIED", cap, before: rawAmount, after: cap });
  return cap;
}

/**
 * `rate` 혜택. 원화(`won`)면 `applyBasisPoints`, 포인트(`points`)면 `applyPointRateAsWon`으로
 * 요율과 포인트 환산을 한 번에(중간에 정수화하지 않고) 처리한다 — 둘 다 `rounding.ts`가
 * 제공하는 유일한 계산 지점이며, 여기서 직접 곱셈/나눗셈을 하지 않는다.
 *
 * `monthlyEligibleSpendCap`은 소비 기준(`rate`)에서만 의미가 있으므로 여기서만 적용한다.
 */
function computeRateBenefit(benefit: RateBenefit, eligibleSpend: Won): AppliedBenefitCalculation {
  const steps: CalculationStep[] = [{ code: "ELIGIBLE_SPEND_COMPUTED", eligibleSpend }];

  const spendForReward = applyEligibleSpendCap(benefit, eligibleSpend, steps);

  const rawAmount =
    benefit.currency.type === "won"
      ? applyBasisPoints(spendForReward, benefit.rateBps)
      : applyPointRateAsWon(spendForReward, benefit.rateBps, benefit.currency.valuation.wonPerThousandPoints);
  steps.push({ code: "REWARD_COMPUTED", rawAmount });

  const finalAmount = applyBenefitRewardCap(benefit, rawAmount, steps);

  return { status: "applied", benefitId: benefit.id, eligibleSpend, rawAmount, finalAmount, steps };
}

/**
 * `fixed` 혜택. `monthlyAmount`는 소비액에 의존하지 않으므로 `eligibleSpend`는 trace에만
 * 기록하고 계산식에는 쓰지 않는다. 같은 이유로 `monthlyEligibleSpendCap`(소비액 상한)은
 * 이 혜택에 적용할 대상이 없어 step을 만들지 않는다 — 적용해도 결과가 달라지지 않는
 * 조건을 "적용됐다"고 기록하지 않는다.
 */
function computeFixedBenefit(benefit: FixedBenefit, eligibleSpend: Won): AppliedBenefitCalculation {
  const steps: CalculationStep[] = [{ code: "ELIGIBLE_SPEND_COMPUTED", eligibleSpend }];

  const rawAmount = benefit.monthlyAmount;
  steps.push({ code: "REWARD_COMPUTED", rawAmount });

  const finalAmount = applyBenefitRewardCap(benefit, rawAmount, steps);

  return { status: "applied", benefitId: benefit.id, eligibleSpend, rawAmount, finalAmount, steps };
}

/**
 * `SpendingBenefit` 하나의 reward를 계산한다. `benefit`은 이미 `eligibility.ts`를 통과한
 * 것으로 가정하며(호출자가 `eligible` 결과에서만 이 함수를 호출), 여기서 자격을 다시
 * 판정하지 않는다.
 *
 * `BENEFIT_CAP_APPLIED`/`ELIGIBLE_SPEND_CAPPED` step은 실제로 한도가 값을 바꿨을 때만
 * (`before !== after`) 기록한다 — 한도 필드가 존재해도 걸리지 않았으면(원 금액이 한도
 * 이하) 아무것도 바뀐 게 없으므로 step을 남기지 않는다. 한도 자체가 있었는지는
 * `benefitId`로 카드의 혜택 정의를 조회하면 알 수 있다.
 */
export function computeSpendingBenefitReward(benefit: SpendingBenefit, eligibleSpend: Won): AppliedBenefitCalculation {
  return benefit.kind === "rate" ? computeRateBenefit(benefit, eligibleSpend) : computeFixedBenefit(benefit, eligibleSpend);
}
