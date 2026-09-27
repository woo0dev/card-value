import { validateCard } from "./validation";
import { calculateCardValue } from "./calculator";
import { rankCards } from "./ranking";
import type { Card } from "./types/card";
import type { MonthlySpending } from "./types/spending";
import type { CalculationAssumptions } from "./types/calculation";
import type { CardValueResult, ExcludedCard, RecommendationResult } from "./types/result";
import type { ValidationErrorCode, ValidationIssue } from "./types/validation";

/**
 * recommendation domain의 orchestration 진입점. 계산하지 않는다 — `validateCard()`
 * (validation.ts), `calculateCardValue()`(calculator.ts), `rankCards()`(ranking.ts)를
 * 순서대로 호출해 결과를 모을 뿐이다.
 *
 * 흐름:
 * 1) 카드마다 `validateCard()`를 호출한다. 실패한 카드는 `calculateCardValue()`로
 *    넘기지 않고 `ExcludedCard`(`VALIDATION_FAILED`)로 담는다 — validation 실패 카드가
 *    `calculator.ts`/`ranking.ts`에 전달되는 경로는 없다.
 * 2) 검증에 성공한 카드마다 `calculateCardValue()`를 호출해 `CardValueResult`를 얻는다.
 *    `UNVERIFIED_CORE_CONDITION`/`FILTERED_BY_USER_PREFERENCE` 기반 제외는 트리거 조건과
 *    사용자 선호 입력 타입이 아직 정해지지 않았으므로 이 구현에서는 적용하지 않는다 —
 *    계산에 성공한 카드는 전부 3)의 랭킹 대상이 된다.
 * 3) 계산된 `CardValueResult[]`를 `rankCards()`에 그대로 넘긴다.
 * 4) `{ input, ranked, excluded, assumptions }`을 조립해 반환한다.
 *
 * `excluded` 배열의 정렬 순서나 입력 카드의 중복 `cardId` 처리에 대한 규칙은 AGENTS.md와
 * 타입 어디에도 없다. 이 파일은 그런 규칙을 임의로 새로 만들지 않고, 입력 `cards` 배열의
 * 순서를 그대로 따른다(정렬하거나 중복을 제거하지 않는다).
 *
 * `assumptions`는 필수 인자다. `CalculationAssumptions`의 모든 필드는 현재 타입상 필수이고,
 * 그중 `perkValuation`은 기본값이나 의미가 코드/AGENTS.md 어디에도 정의돼 있지 않다(
 * `calculator.ts`도 이 필드를 참조하지 않는다). 이 파일은 `roundingPolicy`/
 * `annualizationMonths`처럼 근거가 있는 필드까지 포함해 어떤 `CalculationAssumptions`도
 * 대신 만들지 않는다 — 호출자가 전달한 값을 그대로 각 카드 계산과
 * `RecommendationResult.assumptions`에 동일하게 쓴다.
 */

/**
 * `ValidationIssue`는 `severity`로 판별되는 유니온이라 `code`의 타입이 자동으로
 * `ValidationErrorCode`로 좁혀지지 않는다. `validateCard()`의 `errors` 배열은 항상
 * `severity:"error"`만 담는다는 것이 `validation.ts`(`splitIssues`)의 불변식이므로, 이를
 * 신뢰하되 깨졌을 때는 조용히 잘못된 값을 쓰는 대신 throw한다(`eligibility.ts`의
 * `requireTier`와 같은 패턴).
 */
function requireErrorCode(issue: ValidationIssue): ValidationErrorCode {
  if (issue.severity !== "error") {
    throw new Error(
      "index: 불변식 위반 — validateCard()의 errors 배열에 severity가 error가 아닌 항목이 있음.",
    );
  }
  return issue.code;
}

export function recommendCards(
  cards: readonly Card[],
  spending: MonthlySpending,
  assumptions: CalculationAssumptions,
): RecommendationResult {
  const results: CardValueResult[] = [];
  const excluded: ExcludedCard[] = [];

  for (const card of cards) {
    const validation = validateCard(card);

    if (!validation.valid) {
      const [firstIssue, ...restIssues] = validation.errors;
      excluded.push({
        cardId: card.id,
        reasons: [
          {
            code: "VALIDATION_FAILED",
            errors: [requireErrorCode(firstIssue), ...restIssues.map(requireErrorCode)],
          },
        ],
      });
      continue;
    }

    results.push(calculateCardValue(validation.value, spending, assumptions));
  }

  return {
    input: spending,
    ranked: rankCards(results),
    excluded,
    assumptions,
  };
}
