import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCard } from "./validation";
import { calculateCardValue } from "./calculator";
import type {
  BasisPoints,
  BenefitId,
  Card,
  CardId,
  CardType,
  CategoryTarget,
  MonthlySpending,
  PerformanceTierId,
  RateBenefit,
  SpendingCategory,
  Won,
} from "./types";
import type { CalculationAssumptions } from "./types/calculation";

/**
 * 포인트/마일리지 "X원당 Y개"(`RewardUnit`) 수량 계산이 `eligibility.ts → rewards.ts →
 * calculator.ts` 경로를 거쳐 원화 환산 없이 정확하게 계산되고, `benefitCalculations`
 * (원화 합산)와 절대 섞이지 않는지 검증한다. `calculator.test.ts`와 같은 이유로
 * `node:test`/`node:assert`만 사용하고(새 dependency 없음), `validateCard()` →
 * `calculateCardValue()`라는 실제 public domain API를 그대로 거친다.
 */

const ASSUMPTIONS: CalculationAssumptions = {
  roundingPolicy: "floor_per_benefit",
  annualizationMonths: 12,
  perkValuation: "exclude_perks",
};

const ALL_SPENDING: CategoryTarget = { type: "allExcept", categories: [] };

function baseBenefit(overrides: Partial<RateBenefit>): RateBenefit {
  return {
    id: "test-benefit" as BenefitId,
    name: "테스트 혜택",
    priority: 0,
    requiredTierId: null,
    target: ALL_SPENDING,
    minMonthlySpend: null,
    limits: { monthlyRewardCap: null, monthlyEligibleSpendCap: null },
    sharedCapId: null,
    exclusiveGroupId: null,
    kind: "rate",
    rateBps: 0 as BasisPoints,
    currency: { type: "won", form: "discount" },
    ...overrides,
  };
}

function buildValidatedCard(benefits: readonly RateBenefit[]) {
  const card: Card = {
    id: "test-card" as CardId,
    issuer: "테스트카드사",
    name: "테스트 카드",
    cardType: "credit" as CardType,
    annualFee: { amount: 0 as Won, firstYearWaived: false },
    performanceTiers: [],
    performanceExcludedCategories: [],
    sharedCaps: [],
    spendingBenefits: benefits,
    perks: [],
    source: { sourceUrl: "https://example.com/test-card", verifiedAt: null },
    unverifiedConditions: [],
  };

  const validation = validateCard(card);
  assert.equal(
    validation.valid,
    true,
    `테스트 카드 자체가 유효하지 않음: ${JSON.stringify("errors" in validation ? validation.errors : [])}`,
  );
  assert.ok(validation.valid);
  return validation.value;
}

function spending(currentMonth: Partial<Record<SpendingCategory, number>>): MonthlySpending {
  return {
    previousMonth: {},
    currentMonth: currentMonth as MonthlySpending["currentMonth"],
  };
}

describe("포인트/마일리지 RewardUnit 수량 계산 — 원화 환산 없이 unit 기반으로 정확하게 계산된다", () => {
  it("1) 3,999원 / 1,500원당1마일 → 2마일 (비례식 근사였다면 틀렸을 값)", () => {
    const benefit = baseBenefit({
      id: "miles-benefit" as BenefitId,
      currency: { type: "miles", programName: "대한항공", valuation: null, unit: { unitAmount: 1500 as Won, quantityPerUnit: 1 } },
    });
    const validated = buildValidatedCard([benefit]);

    const result = calculateCardValue(validated, spending({ dining: 3999 }), ASSUMPTIONS);

    assert.equal(result.rewardCalculations.length, 1);
    const calc = result.rewardCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.currencyType, "miles");
    assert.equal(calc.programName, "대한항공");
    assert.equal(calc.quantity, 2, "floor(3999/1500)=2 이어야 함");
  });

  it("2) 2,999원 / 1,500원당1마일 → 1마일 (경계값 — 근사식이면 2로 틀렸을 값)", () => {
    const benefit = baseBenefit({
      id: "miles-benefit" as BenefitId,
      currency: { type: "miles", programName: "대한항공", valuation: null, unit: { unitAmount: 1500 as Won, quantityPerUnit: 1 } },
    });
    const validated = buildValidatedCard([benefit]);

    const result = calculateCardValue(validated, spending({ dining: 2999 }), ASSUMPTIONS);

    const calc = result.rewardCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.quantity, 1, "floor(2999/1500)=1 이어야 함");
  });

  it("3) 1,000원당5포인트 — 배수로 정확히 나눠떨어지는 경우도 unit 기반으로 계산된다", () => {
    const benefit = baseBenefit({
      id: "points-benefit" as BenefitId,
      currency: { type: "points", programName: "포인트리", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 5 } },
    });
    const validated = buildValidatedCard([benefit]);

    const result = calculateCardValue(validated, spending({ dining: 12000 }), ASSUMPTIONS);

    const calc = result.rewardCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.quantity, 60, "floor(12000/1000)*5 = 60 이어야 함");
  });

  it("4) 포인트 전용 카드 — benefitCalculations는 비고 monthlyBenefit/netAnnualValue는 포인트를 반영하지 않는다", () => {
    const benefit = baseBenefit({
      id: "points-benefit" as BenefitId,
      currency: { type: "points", programName: "포인트리", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 5 } },
    });
    const validated = buildValidatedCard([benefit]);

    const result = calculateCardValue(validated, spending({ dining: 100000 }), ASSUMPTIONS);

    assert.equal(result.benefitCalculations.length, 0, "포인트 혜택은 benefitCalculations에 나타나면 안 됨");
    assert.equal(result.monthlyBenefit, 0);
    assert.equal(result.netAnnualValue, 0);
    assert.equal(result.rewardCalculations.length, 1);
    assert.equal(result.rewardCalculations[0]!.quantity, 500);
  });

  it("5) 원화+포인트 혼합 카드 — netAnnualValue는 원화만 반영하고 포인트는 rewardCalculations에만 나타난다", () => {
    const wonBenefit = baseBenefit({
      id: "won-benefit" as BenefitId,
      rateBps: 100 as BasisPoints, // 1%
      currency: { type: "won", form: "discount" },
    });
    const pointsBenefit = baseBenefit({
      id: "points-benefit" as BenefitId,
      currency: { type: "points", programName: "포인트리", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 5 } },
    });
    const validated = buildValidatedCard([wonBenefit, pointsBenefit]);

    const result = calculateCardValue(validated, spending({ dining: 100000 }), ASSUMPTIONS);

    assert.equal(result.benefitCalculations.length, 1, "원화 혜택만 benefitCalculations에 있어야 함");
    assert.equal(result.monthlyBenefit, 1000, "100,000원 × 1% = 1,000원 (포인트는 섞이지 않음)");
    assert.equal(result.netAnnualValue, 12000, "1,000원 × 12개월, 연회비 0원");

    assert.equal(result.rewardCalculations.length, 1);
    assert.equal(result.rewardCalculations[0]!.quantity, 500, "floor(100000/1000)*5 = 500");
  });

  it("6) 같은 프로그램의 기본 적립 + 추가 적립 — rewardsByProgram에서 합산된다", () => {
    const base = baseBenefit({
      id: "points-base" as BenefitId,
      target: { type: "categories", categories: ["dining"] },
      currency: { type: "points", programName: "OK캐쉬백", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 1 } },
    });
    const bonus = baseBenefit({
      id: "points-bonus" as BenefitId,
      target: { type: "categories", categories: ["dining"] },
      currency: { type: "points", programName: "OK캐쉬백", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 2 } },
    });
    const validated = buildValidatedCard([base, bonus]);

    const result = calculateCardValue(validated, spending({ dining: 10000 }), ASSUMPTIONS);

    assert.equal(result.rewardCalculations.length, 2);
    assert.equal(result.rewardsByProgram.length, 1);
    const program = result.rewardsByProgram[0]!;
    assert.equal(program.currencyType, "points");
    assert.equal(program.programName, "OK캐쉬백");
    assert.equal(program.totalQuantity, 30, "기본 10P + 추가 20P = 30P");
  });

  it("7) tier 미충족으로 not_applied — rewardCalculations에 quantity 0으로 기록되고 benefitCalculations에는 없다", () => {
    const tierId = "tier-high" as PerformanceTierId;
    const benefit = baseBenefit({
      id: "points-benefit" as BenefitId,
      requiredTierId: tierId,
      currency: { type: "points", programName: "포인트리", valuation: null, unit: { unitAmount: 1000 as Won, quantityPerUnit: 5 } },
    });
    const card: Card = {
      id: "test-card" as CardId,
      issuer: "테스트카드사",
      name: "테스트 카드",
      cardType: "credit" as CardType,
      annualFee: { amount: 0 as Won, firstYearWaived: false },
      performanceTiers: [
        { id: tierId, name: "우수", minPreviousMonthSpend: 1000000 as Won },
      ],
      performanceExcludedCategories: [],
      sharedCaps: [],
      spendingBenefits: [benefit],
      perks: [],
      source: { sourceUrl: "https://example.com/test-card", verifiedAt: null },
      unverifiedConditions: [],
    };
    const validation = validateCard(card);
    assert.ok(validation.valid);
    const validated = validation.value;

    const result = calculateCardValue(
      validated,
      {
        previousMonth: { dining: 0 } as MonthlySpending["currentMonth"],
        currentMonth: { dining: 100000 } as MonthlySpending["currentMonth"],
      },
      ASSUMPTIONS,
    );

    assert.equal(result.benefitCalculations.length, 0);
    assert.equal(result.rewardCalculations.length, 1);
    const calc = result.rewardCalculations[0]!;
    assert.equal(calc.status, "not_applied");
    assert.equal(calc.quantity, 0);
    assert.equal(result.rewardsByProgram.length, 0, "not_applied만 있으면 프로그램 합산에 나타나지 않아야 함");
  });
});
