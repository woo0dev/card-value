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
  SpendingCategory,
  Won,
} from "./types";
import type { CalculationAssumptions } from "./types/calculation";

/**
 * `allExcept` target(범용 가맹점 scope)이 `eligibility.ts → rewards.ts → calculator.ts`
 * 경로를 거쳐 실제로 올바른 금액을 계산하는지 검증한다. `normalizeCard.ts`가 만든 target
 * 값을 계산 엔진이 어떻게 소비하는지 고정하는 것이 목적이며, 계산 엔진 자체(`eligibility.ts`
 * / `rewards.ts` / `calculator.ts` / `ranking.ts`)는 수정하지 않는다.
 *
 * `normalizeCard.test.ts`와 같은 이유로 `node:test`/`node:assert`만 사용한다(새 dependency
 * 없음). 이 파일은 `calculator.ts`와 같은 디렉터리에 둔다 — `normalizeCard.test.ts`가
 * `normalizeCard.ts`와 같은 위치에 있는 것과 동일한 관례다.
 *
 * `expandCategoryTarget()`(`eligibility.ts`의 비공개 함수) 같은 내부 함수를 직접 부르지
 * 않는다 — `validateCard()` → `calculateCardValue()`라는 실제 public domain API를 그대로
 * 거쳐서, `normalizeCard.ts`가 만든 target 값이 최종 계산 결과(`eligibleSpend`/
 * `monthlyBenefit`)에 정확히 반영되는지까지 확인한다.
 */

const ASSUMPTIONS: CalculationAssumptions = {
  roundingPolicy: "floor_per_benefit",
  annualizationMonths: 12,
  perkValuation: "exclude_perks",
};

/** 카드 1장(소비 혜택 1개)을 만들어 `validateCard()`를 통과시킨다. */
function buildValidatedCardWithOneBenefit(target: CategoryTarget, rateBps: number) {
  const card: Card = {
    id: "test-card" as CardId,
    issuer: "테스트카드사",
    name: "테스트 카드",
    cardType: "credit" as CardType,
    annualFee: { amount: 0 as Won, firstYearWaived: false },
    performanceTiers: [],
    performanceExcludedCategories: [],
    sharedCaps: [],
    spendingBenefits: [
      {
        id: "test-benefit" as BenefitId,
        name: "테스트 혜택",
        priority: 0,
        requiredTierId: null,
        target,
        minMonthlySpend: null,
        limits: { monthlyRewardCap: null, monthlyEligibleSpendCap: null },
        sharedCapId: null,
        exclusiveGroupId: null,
        kind: "rate",
        rateBps: rateBps as BasisPoints,
        currency: { type: "won", form: "discount" },
      },
    ],
    perks: [],
    source: { sourceUrl: "https://example.com/test-card", verifiedAt: null },
    unverifiedConditions: [],
  };

  const validation = validateCard(card);
  assert.equal(validation.valid, true, `테스트 카드 자체가 유효하지 않음: ${JSON.stringify("errors" in validation ? validation.errors : [])}`);
  assert.ok(validation.valid);
  return validation.value;
}

function spending(currentMonth: Partial<Record<SpendingCategory, number>>): MonthlySpending {
  return {
    previousMonth: {},
    currentMonth: currentMonth as MonthlySpending["currentMonth"],
  };
}

describe("calculateCardValue() — allExcept target이 실제 계산까지 정확히 전달되는지", () => {
  it("1) allExcept:['overseas'] (국내 전용) — 해외 소비는 대상에서 제외된다", () => {
    const target: CategoryTarget = { type: "allExcept", categories: ["overseas"] };
    const validated = buildValidatedCardWithOneBenefit(target, 100); // 1%

    const result = calculateCardValue(
      validated,
      spending({ dining: 100000, overseas: 100000 }),
      ASSUMPTIONS,
    );

    assert.equal(result.benefitCalculations.length, 1);
    const calc = result.benefitCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.eligibleSpend, 100000, "해외 소비 100,000원은 제외되고 국내(dining) 100,000원만 대상액이어야 함");
    assert.equal(calc.finalAmount, 1000, "100,000원 × 1% = 1,000원");
    assert.equal(result.monthlyBenefit, 1000);
  });

  it("2) allExcept:[] (국내+해외 전체) — 해외 소비도 대상에 포함된다", () => {
    const target: CategoryTarget = { type: "allExcept", categories: [] };
    const validated = buildValidatedCardWithOneBenefit(target, 100); // 1%

    const result = calculateCardValue(
      validated,
      spending({ dining: 100000, overseas: 100000 }),
      ASSUMPTIONS,
    );

    const calc = result.benefitCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.eligibleSpend, 200000, "국내(dining) 100,000원 + 해외 100,000원 = 200,000원이 모두 대상이어야 함");
    assert.equal(calc.finalAmount, 2000, "200,000원 × 1% = 2,000원");
    assert.equal(result.monthlyBenefit, 2000);
  });

  it("3) allExcept:['overseas'] — 해외만 제외되고 그 외 여러 국내 카테고리는 전부 합산된다", () => {
    const target: CategoryTarget = { type: "allExcept", categories: ["overseas"] };
    const validated = buildValidatedCardWithOneBenefit(target, 100); // 1%

    const result = calculateCardValue(
      validated,
      spending({
        dining: 100000,
        offline_shopping: 200000,
        public_transport: 100000,
        overseas: 100000,
      }),
      ASSUMPTIONS,
    );

    const calc = result.benefitCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(
      calc.eligibleSpend,
      400000,
      "dining(100,000) + offline_shopping(200,000) + public_transport(100,000) = 400,000원, overseas(100,000)는 제외",
    );
    assert.equal(calc.finalAmount, 4000, "400,000원 × 1% = 4,000원");
    assert.equal(result.monthlyBenefit, 4000);
  });

  it("4) 회귀 방지 — 기존 categories:['dining'] target은 allExcept 도입 전과 동일하게 계산된다", () => {
    const target: CategoryTarget = { type: "categories", categories: ["dining"] };
    const validated = buildValidatedCardWithOneBenefit(target, 100); // 1%

    const result = calculateCardValue(
      validated,
      // dining 외 카테고리(overseas 등)를 함께 소비해도 dining 대상 혜택 금액에는
      // 영향이 없어야 한다 — categories target이 지정한 카테고리만 정확히 본다.
      spending({ dining: 100000, offline_shopping: 200000, overseas: 100000 }),
      ASSUMPTIONS,
    );

    const calc = result.benefitCalculations[0]!;
    assert.equal(calc.status, "applied");
    assert.equal(calc.eligibleSpend, 100000, "dining 100,000원만 대상이어야 함(다른 카테고리 소비는 무관)");
    assert.equal(calc.finalAmount, 1000, "100,000원 × 1% = 1,000원");
    assert.equal(result.monthlyBenefit, 1000);
  });
});
