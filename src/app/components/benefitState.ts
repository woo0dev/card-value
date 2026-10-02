import type { CardValueResult } from "../../lib/recommendation/types";

/**
 * 카드 1장의 "혜택 계산 결과가 어떤 상태인가"를 표시용으로 나눈 값.
 *
 * - `applied`: 이번 입력으로 적용된 혜택이 하나 이상 있다.
 * - `not_applied`: 계산 대상 혜택은 있지만 이번 입력에서는 하나도 적용되지 않았다
 *   (전월실적 미달, 해당 카테고리 소비 없음 등 — 사유는 각 `BenefitCalculation.reason`에 있다).
 * - `unverified`: 계산된 혜택이 없고, 조건을 확인하지 못한 혜택 정보가 있다(`UNVERIFIED_CONDITION`).
 * - `unknown`: 계산된 혜택이 없고 미확인 조건 신호도 없다. "혜택이 없다"는 뜻이 아니다 —
 *   원본에 혜택이 없는 카드와 혜택을 읽지 못한 카드를 현재 응답만으로는 구분할 수 없다.
 *
 * `applied.length === 0`만으로 판단하지 않는다: 계산은 됐지만 적용되지 않은 카드(`not_applied`)를
 * "혜택 정보를 확인할 수 없는 카드"로 잘못 보여주지 않기 위해 `benefitCalculations.length`를 먼저 본다.
 * 현재 판정은 `benefitCalculations`만 기준으로 한다. `rewardCalculations`(포인트/마일리지)와
 * `perkCalculations`(부가 혜택)는 판정에 사용하지 않는다 — 포인트/마일리지나 perk 데이터가 실제로
 * 계산·적재되기 시작하면 이 판정(특히 `unknown`)을 다시 검토해야 한다.
 *
 * 판정에는 `UNVERIFIED_CONDITION`만 사용한다 — 다른 warning(`FIRST_YEAR_FEE_WAIVED`,
 * `PREVIOUS_MONTH_PERFORMANCE_ASSUMED`, `POINT_VALUATION_UNVERIFIED`)은 상태에 영향을 주지 않는다.
 *
 * 순수 함수이며 React/JSX에 의존하지 않는다. 사용자에게 보여줄 문구는 컴포넌트가 만든다.
 */
export type BenefitState = "applied" | "not_applied" | "unverified" | "unknown";

export function deriveBenefitState(result: CardValueResult): BenefitState {
  if (result.benefitCalculations.some((calc) => calc.status === "applied")) return "applied";
  if (result.benefitCalculations.length > 0) return "not_applied";
  if (result.warnings.some((warning) => warning.code === "UNVERIFIED_CONDITION")) return "unverified";
  return "unknown";
}
