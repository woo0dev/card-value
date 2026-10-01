import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCalculationAssumptions } from "./validation";
import type { CalculationAssumptions } from "./types/calculation";

/**
 * `validateCalculationAssumptions()`를 검증한다. `calculator.test.ts`/`normalizeCard.test.ts`와
 * 같은 이유로 `node:test`/`node:assert`만 사용한다(새 dependency 없음).
 *
 * 배경: `POST /api/recommendations`가 `assumptions`를 검증 없이 타입 캐스팅만 해서
 * `recommendCards()`에 넘기던 중, `assumptions`가 없거나 구조가 잘못되면 `calculator.ts`의
 * `multiplyWon(monthlyBenefit, assumptions.annualizationMonths)`에서 런타임 예외가 나
 * 400이 아닌 500으로 응답하는 문제가 실사용자 관점 테스트에서 발견됐다. 이 테스트는 그
 * 문제를 막는 `validateCalculationAssumptions()`가 모든 경계 케이스를 올바르게
 * `invalid`(+ 정확한 reason code)로 보고하는지, 정상 입력은 그대로 통과시키는지 고정한다.
 */

const VALID: CalculationAssumptions = {
  roundingPolicy: "floor_per_benefit",
  annualizationMonths: 12,
  perkValuation: "exclude_perks",
};

function errorCodes(result: ReturnType<typeof validateCalculationAssumptions>): readonly string[] {
  assert.equal(result.valid, false);
  if (result.valid) throw new Error("unreachable");
  return result.errors.map((issue) => issue.code);
}

describe("validateCalculationAssumptions()", () => {
  it("정상 입력(회귀 테스트) — 기존 정상 요청과 동일한 값은 그대로 통과한다", () => {
    const result = validateCalculationAssumptions(VALID);
    assert.equal(result.valid, true);
    if (!result.valid) throw new Error("unreachable");
    assert.deepEqual(result.value, VALID);
    assert.deepEqual(result.warnings, []);
  });

  it("perkValuation이 다른 허용값(user_selected_realization)이어도 통과한다", () => {
    const result = validateCalculationAssumptions({ ...VALID, perkValuation: "user_selected_realization" });
    assert.equal(result.valid, true);
  });

  it("assumptions 필드 누락(undefined) — MISSING_FIELD(루트)", () => {
    const result = validateCalculationAssumptions(undefined);
    assert.deepEqual(errorCodes(result), ["MISSING_FIELD"]);
  });

  it("assumptions: null — MISSING_FIELD(루트, undefined와 동일하게 처리)", () => {
    const result = validateCalculationAssumptions(null);
    assert.deepEqual(errorCodes(result), ["MISSING_FIELD"]);
  });

  it("빈 객체 — 3개 필드 모두 MISSING_FIELD", () => {
    const result = validateCalculationAssumptions({});
    const codes = errorCodes(result);
    assert.equal(codes.length, 3);
    assert.ok(codes.every((code) => code === "MISSING_FIELD"));
    assert.equal(result.valid, false);
    if (result.valid) throw new Error("unreachable");
    assert.deepEqual(
      result.errors.map((issue) => issue.path),
      [["annualizationMonths"], ["perkValuation"], ["roundingPolicy"]],
    );
  });

  it("필수 필드 일부만 누락(perkValuation만 없음) — 그 필드만 MISSING_FIELD", () => {
    const rest = { roundingPolicy: VALID.roundingPolicy, annualizationMonths: VALID.annualizationMonths };
    const result = validateCalculationAssumptions(rest);
    assert.equal(result.valid, false);
    if (result.valid) throw new Error("unreachable");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.code, "MISSING_FIELD");
    assert.deepEqual(result.errors[0]?.path, ["perkValuation"]);
  });

  it("잘못된 자료형(annualizationMonths가 문자열) — NOT_SAFE_INTEGER", () => {
    const result = validateCalculationAssumptions({ ...VALID, annualizationMonths: "12" });
    assert.deepEqual(errorCodes(result), ["NOT_SAFE_INTEGER"]);
  });

  it("잘못된 자료형(roundingPolicy가 숫자) — INVALID_ENUM_VALUE", () => {
    const result = validateCalculationAssumptions({ ...VALID, roundingPolicy: 123 });
    assert.deepEqual(errorCodes(result), ["INVALID_ENUM_VALUE"]);
  });

  it("허용 범위를 벗어난 숫자(annualizationMonths: 0) — OUT_OF_RANGE", () => {
    const result = validateCalculationAssumptions({ ...VALID, annualizationMonths: 0 });
    assert.deepEqual(errorCodes(result), ["OUT_OF_RANGE"]);
  });

  it("허용 범위를 벗어난 숫자(annualizationMonths: 13) — OUT_OF_RANGE", () => {
    const result = validateCalculationAssumptions({ ...VALID, annualizationMonths: 13 });
    assert.deepEqual(errorCodes(result), ["OUT_OF_RANGE"]);
  });

  it("허용 범위를 벗어난 숫자(annualizationMonths: 음수) — OUT_OF_RANGE", () => {
    const result = validateCalculationAssumptions({ ...VALID, annualizationMonths: -1 });
    assert.deepEqual(errorCodes(result), ["OUT_OF_RANGE"]);
  });

  it("annualizationMonths가 안전하지 않은 정수(소수) — NOT_SAFE_INTEGER", () => {
    const result = validateCalculationAssumptions({ ...VALID, annualizationMonths: 1.5 });
    assert.deepEqual(errorCodes(result), ["NOT_SAFE_INTEGER"]);
  });

  it("알 수 없는 enum 값(roundingPolicy: 'ceil_per_benefit') — INVALID_ENUM_VALUE", () => {
    const result = validateCalculationAssumptions({ ...VALID, roundingPolicy: "ceil_per_benefit" });
    assert.deepEqual(errorCodes(result), ["INVALID_ENUM_VALUE"]);
  });

  it("알 수 없는 enum 값(perkValuation: 'garbage') — INVALID_ENUM_VALUE", () => {
    const result = validateCalculationAssumptions({ ...VALID, perkValuation: "garbage" });
    assert.deepEqual(errorCodes(result), ["INVALID_ENUM_VALUE"]);
  });

  it("배열은 객체가 아니므로 MISSING_FIELD(루트)", () => {
    const result = validateCalculationAssumptions([VALID]);
    assert.deepEqual(errorCodes(result), ["MISSING_FIELD"]);
  });

  it("여러 필드가 동시에 잘못되면 각각 독립적으로 보고한다", () => {
    const result = validateCalculationAssumptions({
      roundingPolicy: "wrong",
      annualizationMonths: -5,
      // perkValuation 누락
    });
    const codes = [...errorCodes(result)].sort();
    assert.deepEqual(codes, ["INVALID_ENUM_VALUE", "MISSING_FIELD", "OUT_OF_RANGE"]);
  });
});
