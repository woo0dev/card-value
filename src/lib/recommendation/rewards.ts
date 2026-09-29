import type {
  AppliedBenefitCalculation,
  AppliedRewardCalculation,
  CalculationStep,
  FixedBenefit,
  RateBenefit,
  SpendingBenefit,
  Won,
} from "./types";
import { applyBasisPoints, applyUnitReward } from "./rounding";

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
 * `rate` 혜택 중 원화(`won`) 혜택의 금액을 `applyBasisPoints`로 계산한다.
 * 포인트/마일리지(`points`/`miles`)는 원화 합산에 절대 섞지 않으므로(`benefitCalculations`는
 * 원화 전용) 이 함수가 아니라 `computeSpendingBenefitRewardQuantity`가 계산하며, 호출자
 * (`calculator.ts`)가 통화 종류로 미리 분기해 이 함수에는 원화 혜택만 넘긴다. 그럼에도
 * 다른 통화가 들어오면 조용히 잘못된 원화 금액을 만드는 대신 즉시 실패한다.
 *
 * `monthlyEligibleSpendCap`은 소비 기준(`rate`)에서만 의미가 있으므로 여기서만 적용한다.
 */
function computeRateBenefit(benefit: RateBenefit, eligibleSpend: Won): AppliedBenefitCalculation {
  if (benefit.currency.type !== "won") {
    throw new Error(
      `rewards: 불변식 위반 — computeSpendingBenefitReward()는 currency.type이 "won"인 rate 혜택만 받는다` +
        `(benefitId="${benefit.id}", currency.type="${benefit.currency.type}"). points/miles는 computeSpendingBenefitRewardQuantity()를 써야 한다.`,
    );
  }

  const steps: CalculationStep[] = [{ code: "ELIGIBLE_SPEND_COMPUTED", eligibleSpend }];

  const spendForReward = applyEligibleSpendCap(benefit, eligibleSpend, steps);

  const rawAmount = applyBasisPoints(spendForReward, benefit.rateBps);
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

/**
 * 포인트/마일리지(`points`/`miles`) `rate` 혜택의 적립 수량을 계산한다. `computeSpendingBenefitReward`와
 * 마찬가지로 자격 판정은 이미 끝난 것으로 가정하며(`eligibility.ts` 책임), 여기서는 금액이 아니라
 * `RewardUnit`(`currency.unit`) 기반 정확한 수량만 계산한다.
 *
 * 원화 환산(`currency.valuation`)은 이 함수가 다루지 않는다 — 결과는 항상 원화 환산 없는
 * `quantity`다. `monthlyRewardCap`(원화 단위 한도)은 수량과 단위가 맞지 않아 적용하지 않는다
 * (`monthlyEligibleSpendCap`은 원화 소비액 상한이므로 계산 전에는 그대로 적용한다).
 */
export function computeSpendingBenefitRewardQuantity(
  benefit: RateBenefit,
  eligibleSpend: Won,
): AppliedRewardCalculation {
  if (benefit.currency.type !== "points" && benefit.currency.type !== "miles") {
    throw new Error(
      `rewards: 불변식 위반 — computeSpendingBenefitRewardQuantity()는 currency.type이 "points" 또는 ` +
        `"miles"인 rate 혜택만 받는다(benefitId="${benefit.id}", currency.type="${benefit.currency.type}").`,
    );
  }
  const { currency } = benefit;

  const steps: CalculationStep[] = [{ code: "ELIGIBLE_SPEND_COMPUTED", eligibleSpend }];

  const spendForReward = applyEligibleSpendCap(benefit, eligibleSpend, steps);

  const quantity = applyUnitReward(spendForReward, currency.unit.unitAmount, currency.unit.quantityPerUnit);
  steps.push({ code: "REWARD_QUANTITY_COMPUTED", quantity });

  return {
    status: "applied",
    benefitId: benefit.id,
    currencyType: currency.type,
    programName: currency.programName,
    eligibleSpend,
    quantity,
    steps,
  };
}
