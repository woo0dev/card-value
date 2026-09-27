import type { CardValueResult, RankedCard } from "./types/result";

/**
 * `calculator.ts`가 이미 계산한 `CardValueResult[]`를 정렬해 `RankedCard[]`를 만든다.
 *
 * 이 파일은 계산하지 않는다 — 혜택/reward/eligibility 판단, 연간 가치 재계산,
 * `CardValueResult` 내부 값 수정을 하지 않으며, `Card`/`ValidatedCard`/`MonthlySpending`에도
 * 접근하지 않는다. 제외 카드 판단(`ExcludedCard`, `UNVERIFIED_CORE_CONDITION`,
 * `FILTERED_BY_USER_PREFERENCE`, 사용자 선호 필터링)도 이 파일의 책임이 아니다 — 이 파일은
 * 이미 "포함하기로 정해진" `CardValueResult`만 받아서 정렬만 한다.
 *
 * 정렬 기준(고정된 정책):
 * 1) `netAnnualValue` 내림차순
 * 2) 같으면 `annualFee` 오름차순
 * 3) 그래도 같으면 `cardId` 오름차순(문자열 코드 유닛 순, 로케일 비의존)
 *
 * 이 세 기준만으로 항상 전순서(total order)가 만들어지므로, 입력 배열의 원래 순서와
 * 무관하게 항상 같은 결과가 나온다(동점 시 배열 순서에 기대는 안정 정렬에 의존하지 않는다).
 *
 * `rank`는 정렬된 배열의 `index + 1`이다. 공동 순위는 표현하지 않는다.
 */
function compareCardValueResults(a: CardValueResult, b: CardValueResult): number {
  if (a.netAnnualValue !== b.netAnnualValue) return a.netAnnualValue > b.netAnnualValue ? -1 : 1;
  if (a.annualFee !== b.annualFee) return a.annualFee < b.annualFee ? -1 : 1;
  if (a.cardId < b.cardId) return -1;
  if (a.cardId > b.cardId) return 1;
  return 0;
}

/**
 * 원본 `results` 배열과 그 원소는 mutate하지 않는다(`sort()` 전에 얕은 복사를 만든다).
 * 빈 배열이 들어오면 빈 배열을 반환한다.
 */
export function rankCards(results: readonly CardValueResult[]): readonly RankedCard[] {
  return [...results]
    .sort(compareCardValueResults)
    .map((result, index) => ({ rank: index + 1, result }));
}
