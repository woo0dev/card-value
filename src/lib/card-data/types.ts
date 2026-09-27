/**
 * "Raw" 계층의 타입 정의.
 *
 * 이 파일은 `card_value_cards.csv` / `card_value_benefits.csv`의 한 row를 CSV 문법 수준에서
 * 그대로 옮겨 담는 구조만 정의한다. 값의 의미를 해석하지 않는다:
 *
 * - 금액 문자열("300000")을 숫자나 `Won`으로 바꾸지 않는다.
 * - 날짜 문자열을 `Date`로 바꾸지 않는다.
 * - `"무제한"`, `"없음"` 같은 문구를 `null`로 바꾸지 않는다 (CSV 필드가 빈 문자열일 때만 `null`이다).
 * - "10% 할인", "30만원 이상" 같은 한국어 문장을 파싱하지 않는다.
 *
 * 이런 해석은 다음 단계(normalization: `NormalizedCard`, `Card` 변환)의 책임이다.
 * 이 경계를 지키기 위해 `src/lib/recommendation/types/`의 `CardId`, `Won`, `BasisPoints`,
 * `Card`, `Benefit` 등을 이 파일에서 재사용하지 않는다. CSV 원본 표현과 도메인 표현은
 * 서로 다른 타입 집합으로 분리한다.
 */

/**
 * `card_value_cards.csv`의 한 row.
 *
 * `cardAdId`, `cardName`, `issuerName`은 실제 CSV에서 빈 값이 없는 필수 식별/표시 정보라서
 * 원본 문자열 그대로(`string`)로 둔다. 나머지는 실제로 빈 값이 존재해서 `string | null`이다.
 * `raw`에는 이 row의 모든 CSV 컬럼이 원래 헤더 이름 그대로 보존된다.
 */
export interface RawCardRecord {
  readonly cardAdId: string;
  readonly cardCode: string | null;
  readonly cardName: string;
  readonly issuerCode: string | null;
  readonly issuerName: string;

  readonly sourceUrl: string | null;
  readonly issuerCardUrl: string | null;

  readonly annualFeeDomestic: string | null;
  readonly annualFeeInternational: string | null;
  readonly annualFeeFamily: string | null;
  readonly annualFeeDescription: string | null;

  readonly minimumSpendFrom: string | null;
  readonly minimumSpendTo: string | null;
  readonly minimumSpendUnit: string | null;
  readonly minimumSpendPeriod: string | null;
  readonly minimumSpendMethod: string | null;
  readonly minimumSpendDescription: string | null;

  readonly titleDescription: string | null;
  readonly alertDescription: string | null;
  /** 카드 단위 혜택 요약(자유 텍스트). benefits.csv 행의 `benefitSummary`와는 다른 컬럼이다. */
  readonly benefitSummary: string | null;
  readonly newMemberBenefit: string | null;
  readonly releaseDate: string | null;
  readonly benefitCount: string | null;

  /** 아래 4개는 CSV 셀 안에 JSON 문자열이 들어 있는 컬럼이다. 이 단계에서는 파싱하지 않는다. */
  readonly annualBrandFeesJson: string | null;
  readonly benefitNoticesJson: string | null;
  readonly extraDescJson: string | null;
  readonly rateNoticesJson: string | null;

  /** 이 row의 모든 컬럼을 원본 CSV 헤더 이름 → 원본 문자열로 보존한 것. */
  readonly raw: Readonly<Record<string, string | null>>;
}

/**
 * `card_value_benefits.csv`의 한 row.
 *
 * `cardAdId`, `benefitOrder`는 항상 값이 있는 필수 필드라 `string`으로 둔다.
 * `benefitOrder`는 문자열 그대로 보존하며 숫자 변환은 다음 단계의 책임이다.
 */
export interface RawBenefitRecord {
  readonly cardAdId: string;
  readonly cardName: string | null;
  readonly issuerCode: string | null;
  readonly issuerName: string | null;

  readonly benefitOrder: string;
  readonly benefitCategory: string | null;
  readonly benefitCategoryId: string | null;
  readonly benefitSummary: string | null;

  /** JSON 문자열이 담긴 컬럼. 이 단계에서는 `JSON.parse`하지 않는다. */
  readonly benefitValuesJson: string | null;
  /** JSON 문자열이 담긴 컬럼. 이 단계에서는 `JSON.parse`하지 않는다. */
  readonly benefitDescriptionsJson: string | null;
  readonly benefitDescription: string | null;
  readonly benefitIcon: string | null;

  /** 이 row의 모든 컬럼을 원본 CSV 헤더 이름 → 원본 문자열로 보존한 것. */
  readonly raw: Readonly<Record<string, string | null>>;
}

export interface RawCardDataset {
  readonly cards: readonly RawCardRecord[];
}

export interface RawBenefitDataset {
  readonly benefits: readonly RawBenefitRecord[];
}
