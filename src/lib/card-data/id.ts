import type { Won } from "../recommendation/types";

/**
 * 정규화 ID 생성 함수.
 *
 * 여기서 만드는 문자열은 `validateCard()`가 신뢰하는 brand 타입(`BenefitId` 등)이 아니라
 * 평범한 `string`이다. 이 함수들은 의미를 해석하지 않는다 — 이미 정해진 값(카드 ad id,
 * benefit row 순번, 분해 조각 번호, 실적 threshold 금액)을 정해진 규칙으로 조합할 뿐이다.
 *
 * 이 문자열은 오직 유일한 식별자로만 쓰고, 다른 코드가 이 문자열을 파싱해서 원래 값을
 * 역으로 복원하지 않는다 — 출처가 필요하면 항상 `NormalizationProvenance`를 통해 조회한다.
 */

export function createBenefitId(cardAdId: string, benefitOrder: number, pieceIndex: number): string {
  return `${cardAdId}-b${benefitOrder}-${pieceIndex}`;
}

export function createPerformanceTierId(cardAdId: string, thresholdWon: Won): string {
  return `${cardAdId}-t${thresholdWon}`;
}

export function createSharedCapId(cardAdId: string, index: number): string {
  return `${cardAdId}-cap${index}`;
}
