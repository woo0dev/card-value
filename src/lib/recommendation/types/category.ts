/**
 * 1차 버전의 소비 카테고리 (목록은 아직 확정되지 않았다). 가맹점 단위 혜택은 지원하지 않는다.
 * 하나의 소비 금액은 정확히 하나의 카테고리에만 속한다.
 *
 * `overseas`는 임시 카테고리다. 해외 여부는 본래 `dining + overseas`처럼 다른 카테고리와
 * 조합되는 직교 속성이므로, 이 값이 있으면 "해외 식당"과 "해외 쇼핑"을 구분할 수 없고
 * 해외 결제 전체를 한 덩어리로만 다룬다. 지역 속성이 필요해지면 소비 입력과 혜택 대상에
 * 별도 축(예: 국내/해외)을 추가하고 이 카테고리는 제거하는 방향으로 확장한다.
 */
export const SPENDING_CATEGORIES = [
  "dining",
  "cafe",
  "convenience_store",
  "grocery",
  "online_shopping",
  "offline_shopping",
  "public_transport",
  "taxi",
  "fuel",
  "telecom",
  "utilities",
  "medical",
  "education",
  "entertainment",
  "subscription",
  "travel",
  "overseas",
  "insurance",
  "tax",
  "gift_card",
  "other",
] as const;

export type SpendingCategory = (typeof SPENDING_CATEGORIES)[number];
