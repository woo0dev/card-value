import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BenefitCalculation,
  BenefitId,
  CalculationWarning,
  CardId,
  CardValueResult,
  Won,
} from "../../lib/recommendation/types";
import { deriveBenefitState } from "./benefitState";

const ZERO = 0 as Won;

function appliedCalc(id: string): BenefitCalculation {
  return {
    status: "applied",
    benefitId: id as BenefitId,
    eligibleSpend: ZERO,
    rawAmount: ZERO,
    finalAmount: ZERO,
    steps: [],
  };
}

function notAppliedCalc(id: string): BenefitCalculation {
  return {
    status: "not_applied",
    benefitId: id as BenefitId,
    eligibleSpend: ZERO,
    rawAmount: ZERO,
    finalAmount: ZERO,
    steps: [],
    reason: { code: "NO_ELIGIBLE_SPEND" },
  };
}

function resultWith(
  benefitCalculations: readonly BenefitCalculation[],
  warnings: readonly CalculationWarning[],
): CardValueResult {
  return {
    cardId: "card-1" as CardId,
    achievedTierId: null,
    previousMonthPerformance: ZERO,
    monthlyBenefit: ZERO,
    annualSpendingBenefit: ZERO,
    annualPerkValue: ZERO,
    annualBenefit: ZERO,
    annualFee: ZERO,
    netAnnualValue: ZERO,
    firstYearOnlyPerkValue: ZERO,
    benefitCalculations,
    perkCalculations: [],
    rewardCalculations: [],
    rewardsByProgram: [],
    warnings,
  };
}

const UNVERIFIED: CalculationWarning = { code: "UNVERIFIED_CONDITION", field: "rate", benefitId: null };
const FEE_WAIVED: CalculationWarning = { code: "FIRST_YEAR_FEE_WAIVED" };
const PERFORMANCE_ASSUMED: CalculationWarning = { code: "PREVIOUS_MONTH_PERFORMANCE_ASSUMED" };
const POINT_VALUATION: CalculationWarning = {
  code: "POINT_VALUATION_UNVERIFIED",
  benefitId: "b1" as BenefitId,
};

describe("deriveBenefitState", () => {
  it("applied만 있음 → applied", () => {
    assert.equal(deriveBenefitState(resultWith([appliedCalc("b1")], [])), "applied");
  });

  it("applied + UNVERIFIED_CONDITION → applied", () => {
    assert.equal(deriveBenefitState(resultWith([appliedCalc("b1")], [UNVERIFIED])), "applied");
  });

  it("applied와 not_applied가 섞여 있으면 → applied", () => {
    assert.equal(deriveBenefitState(resultWith([notAppliedCalc("b1"), appliedCalc("b2")], [])), "applied");
  });

  it("not_applied만 있음 + 경고 없음 → not_applied", () => {
    assert.equal(deriveBenefitState(resultWith([notAppliedCalc("b1")], [])), "not_applied");
  });

  it("not_applied만 있음 + UNVERIFIED_CONDITION → not_applied", () => {
    assert.equal(deriveBenefitState(resultWith([notAppliedCalc("b1")], [UNVERIFIED])), "not_applied");
  });

  it("계산 결과 없음 + UNVERIFIED_CONDITION → unverified", () => {
    assert.equal(deriveBenefitState(resultWith([], [UNVERIFIED])), "unverified");
  });

  it("계산 결과 없음 + UNVERIFIED_CONDITION이 여러 개여도 → unverified", () => {
    assert.equal(deriveBenefitState(resultWith([], [UNVERIFIED, UNVERIFIED, FEE_WAIVED])), "unverified");
  });

  it("계산 결과 없음 + 경고 없음 → unknown", () => {
    assert.equal(deriveBenefitState(resultWith([], [])), "unknown");
  });

  it("계산 결과 없음 + FIRST_YEAR_FEE_WAIVED만 있음 → unknown", () => {
    assert.equal(deriveBenefitState(resultWith([], [FEE_WAIVED])), "unknown");
  });

  it("계산 결과 없음 + PREVIOUS_MONTH_PERFORMANCE_ASSUMED만 있음 → unknown", () => {
    assert.equal(deriveBenefitState(resultWith([], [PERFORMANCE_ASSUMED])), "unknown");
  });

  it("계산 결과 없음 + POINT_VALUATION_UNVERIFIED만 있음 → unknown", () => {
    assert.equal(deriveBenefitState(resultWith([], [POINT_VALUATION])), "unknown");
  });

  it("계산 결과 없음 + UNVERIFIED_CONDITION 외 경고가 모두 함께 있어도 → unknown", () => {
    assert.equal(deriveBenefitState(resultWith([], [FEE_WAIVED, PERFORMANCE_ASSUMED, POINT_VALUATION])), "unknown");
  });
});
