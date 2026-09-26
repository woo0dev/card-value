import type { Brand } from "./money";
import type { Card } from "./card";

/**
 * 데이터 검증(validation) 결과 타입.
 * 계산 trace(`CalculationStep`, `NotAppliedReason`)나 `CalculationWarning`과는 별개의 이름공간이다.
 * 검증 이슈는 카드 데이터를 다루는 쪽을 위한 것이며, 사용자에게 보여줄 문구는 UI 계층에서 만든다.
 */

/** 이슈 위치. 예: `["spendingBenefits", 2, "limits", "monthlyRewardCap"]`. */
export type ValidationPath = readonly (string | number)[];

export type ValidationSeverity = "error" | "warning";

/** 계산 불가로 판단되어 추천 대상에서 제외해야 하는 데이터 오류. */
export type ValidationErrorCode =
  // 값
  | "NOT_SAFE_INTEGER"
  | "NEGATIVE_VALUE"
  | "NOT_POSITIVE"
  | "OUT_OF_RANGE"
  | "NOT_FINITE"
  | "EMPTY_STRING"
  | "MISSING_FIELD"
  | "UNKNOWN_SPENDING_CATEGORY"
  // 유일성
  | "DUPLICATE_TIER_ID"
  | "DUPLICATE_TIER_THRESHOLD"
  | "DUPLICATE_TIER_LIMIT"
  | "DUPLICATE_SHARED_CAP_ID"
  | "DUPLICATE_BENEFIT_ID"
  // 참조
  | "INVALID_TIER_REFERENCE"
  | "INVALID_SHARED_CAP_REFERENCE"
  | "INVALID_UNVERIFIED_BENEFIT_REFERENCE";

/** 계산은 가능하지만 데이터 작성 의도를 확인해야 하는 이슈. */
export type ValidationWarningCode =
  | "EXCLUSIVE_GROUP_SINGLE_MEMBER"
  | "EXCLUSIVE_GROUP_AMBIGUOUS_ORDER";

export type ValidationIssueCode = ValidationErrorCode | ValidationWarningCode;

export interface ValidationIssueContext {
  id?: string;
  value?: number | string;
}

interface ValidationIssueBase {
  path: ValidationPath;
  context?: ValidationIssueContext;
}

/**
 * `severity`는 `code`에 의해 타입 수준에서 결정된다.
 * 오류 코드는 항상 `"error"`, 경고 코드는 항상 `"warning"`이며 임의로 섞을 수 없다.
 */
export type ValidationIssue =
  | (ValidationIssueBase & { code: ValidationErrorCode; severity: "error" })
  | (ValidationIssueBase & { code: ValidationWarningCode; severity: "warning" });

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/**
 * 검증 결과. `error`가 하나라도 있으면 반드시 `valid: false`이며, 이때 `errors`는 최소 1개다.
 * `valid: true`이면 `error`가 없다.
 */
export type ValidationResult<T> =
  | {
      valid: true;
      value: T;
      warnings: readonly ValidationIssue[];
    }
  | {
      valid: false;
      errors: NonEmptyReadonlyArray<ValidationIssue>;
      warnings: readonly ValidationIssue[];
    };

/**
 * `validateCard()`를 통과한 카드. 구조, 값, 참조 무결성이 검증되었음을 나타낸다.
 * 생성은 `validation.ts`의 `validateCard()` 성공 분기 한 곳에서만 한다.
 */
export type ValidatedCard = Brand<Card, "ValidatedCard">;
