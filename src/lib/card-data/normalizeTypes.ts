import type {
  AnnualFee,
  BasisPoints,
  BenefitLimits,
  CategoryTarget,
  PerkFrequency,
  RewardCurrency,
  Won,
} from "../recommendation/types";

/**
 * Normalization 계층의 타입 정의.
 *
 * 파이프라인에서의 위치:
 *
 * ```text
 * RawCardRecord / RawBenefitRecord (types.ts, parseCsv.ts)
 *   ↓
 * Normalization types (이 파일)     ← 이번 단계는 타입만, 실행 코드 없음
 *   ↓
 * (다음 단계) normalization 구현 → NormalizedCard
 *   ↓
 * (다음 단계) toDomainCard() → Card
 *   ↓
 * validateCard()
 * ```
 *
 * 이 파일에는 문장을 해석하거나 값을 만들어내는 함수가 없다. 타입만 정의한다.
 *
 * 핵심 원칙: 부분적으로만 해석된 값을 최종 Domain `SpendingBenefit | PerkBenefit`로
 * 만들지 않는다. 그래서 이 파일의 타입들은 최종 Domain object를 직접 담지 않고,
 * 각 필드의 파싱 상태(`parsed` / `unverified` / `unsupported`)를 개별적으로 표현한다.
 * 모든 필드가 `parsed`일 때만 다음 단계가 실제 `SpendingBenefit`/`PerkBenefit`을 만들 수 있다.
 *
 * ID 경계: `CardId`/`BenefitId`/`PerformanceTierId`/`SharedCapId`/`ExclusiveGroupId`처럼
 * `validateCard()`가 신뢰하는 brand 타입은 아직 만들지 않는다. 이 값들은 파싱된 "내용"이
 * 아니라 정규화 단계가 조합해서 부여하는 식별자이므로, 이 계층에서는 평범한 `string`으로
 * 남겨 두고 실제 brand 타입으로의 변환은 `toDomainCard()`가 담당한다(ID 생성 함수 자체는
 * 다음 단계에서 별도 파일로 만든다. 이 파일은 그 함수가 채울 자리의 타입만 정의한다).
 *
 * 값 타입(`Won`, `BasisPoints`, `AnnualFee`, `CategoryTarget`, `BenefitLimits`,
 * `RewardCurrency`, `PerkFrequency`)은 recommendation domain의 기존 타입을
 * 그대로 재사용한다. 이 값들은 ID와 달리 "파싱해서 만들어내는 결과물" 자체이므로,
 * `status: "parsed"`일 때 그 값이 실제로 도메인이 기대하는 형태와 같아야 하기 때문이다.
 */

// ---------------------------------------------------------------------------
// NormalizationOutcome / Provenance
// ---------------------------------------------------------------------------

/**
 * Normalization에서 얻어진 값 하나의 상태.
 *
 * - `parsed`: 값을 확실하게 추출했다. `confidence: "approximated"`는 값 자체는 있지만
 *   (예: 단위 기반 포인트 적립을 `rateBps`로 근사) 원문의 정확한 의미와 완전히 같지는
 *   않음을 표시한다.
 * - `unverified`: 원문 조건은 있지만 수치/구조를 신뢰 있게 추출하지 못했다.
 * - `unsupported`: 조건 자체는 이해했지만 현재 입력 모델/Domain으로 계산할 수 없다.
 *
 * `unverified`에는 자유 문자열 `reason`을 두지 않고 `UnverifiedReasonCode`만 쓴다.
 * `null`은 오직 도메인 타입이 실제로 "제한/조건 없음"을 의미하는 자리(예: `Won | null`의
 * `null`)에서만 다음 단계가 사용하며, 이 타입 자체에서 "모르는 값"의 의미로 쓰이지 않는다.
 */
export type NormalizationOutcome<T> =
  | {
      readonly status: "parsed";
      readonly value: T;
      readonly confidence: "exact" | "approximated";
      readonly provenance: NormalizationProvenance;
    }
  | {
      readonly status: "unverified";
      readonly reasonCode: UnverifiedReasonCode;
      readonly provenance: NormalizationProvenance;
    }
  | {
      readonly status: "unsupported";
      readonly code: UnsupportedConditionCode;
      readonly provenance: NormalizationProvenance;
    };

/**
 * 값 하나가 어느 CSV row, 어느 문장에서 왔는지 추적하기 위한 정보.
 *
 * `benefitOrder`/`pieceIndex`가 `null`이면 이 provenance는 카드 단위 값(연회비 등)의
 * 출처이며 특정 benefit row에 속하지 않는다는 뜻이다. 한 benefit row가 여러 조각으로
 * 분해되면 `pieceIndex`로 그 조각의 순번을 구분한다.
 *
 * `extractedAt`은 CSV의 crawl/검증 시각이 아니라 normalization을 실행한 시각이다.
 * `Card.source.verifiedAt`(사람이 검증한 시각)과 혼동하지 않는다.
 */
export interface NormalizationProvenance {
  readonly sourceUrl: string | null;
  readonly cardAdId: string;
  readonly benefitOrder: number | null;
  readonly pieceIndex: number | null;
  readonly originalCardText: string | null;
  readonly originalBenefitText: string | null;
  readonly originalConditionText: string;
  readonly extractedAt: string;
}

/**
 * `unverified`의 사유. 원문 조건이 있지만 수치/구조를 신뢰 있게 추출하지 못한 경우다.
 * 새 값이 필요해지면 실제 parser 구현 단계에서 검토 후 추가한다.
 */
export type UnverifiedReasonCode =
  | "NO_NUMERIC_VALUE_FOUND"
  | "AMBIGUOUS_TIER_VALUE"
  | "AMBIGUOUS_CAP_VALUE"
  | "MULTIPLE_CONFLICTING_VALUES"
  | "AMBIGUOUS_TARGET_CATEGORY";

/**
 * `unsupported`의 사유. 조건 자체는 이해했지만 현재 입력 모델(`MonthlySpending`)이나
 * Domain 타입으로 계산할 수 없는 경우다. 실제 CSV 분석에서 확인된 범위 밖 조건만 담는다.
 */
export type UnsupportedConditionCode =
  | "PER_TRANSACTION_MINIMUM"
  | "PER_TRANSACTION_TIERED_RATE"
  | "USAGE_COUNT_LIMIT"
  | "MERCHANT_SPECIFIC"
  | "PAYMENT_METHOD_RESTRICTED"
  | "DOMESTIC_OVERSEAS_COMBINATION"
  | "CARD_VARIANT_DEPENDENT"
  | "ANNIVERSARY_YEAR_CONDITION"
  | "NEW_MEMBER_EVENT"
  | "UNIT_BASED_REWARD_EXACT"
  | "PERK_CHOICE_GROUP"
  | "ANNUAL_USAGE_CONDITION";

// ---------------------------------------------------------------------------
// 카드 단위 값
// ---------------------------------------------------------------------------

/**
 * 카드의 식별/표시 정보. 현재 recommendation domain에는 이 조합에 대응하는 단독 타입이
 * 없어서(`Card`는 이 정보와 혜택·한도까지 모두 합친 최종 형태) 최소한의 중간 타입으로 둔다.
 *
 * `cardCode`/`sourceUrl`은 CSV의 구조화된 컬럼을 그대로 담는 필드라 해석이 필요 없고,
 * 항상 이 outcome의 `parsed` 값 안에 함께 들어간다.
 *
 * `cardType`은 여기 포함하지 않는다. 실제 CSV에는 `credit`/`check`를 판단할 명시적
 * 컬럼이 전혀 없어서 모든 카드에서 확인이 불가능한데, 억지로 이 값을 만들려고 하면
 * (a) `cardType`을 `CardIdentity`에 묶어 id/이름/발급사처럼 거의 항상 확실한 정보까지
 * 통째로 `unverified`로 만들거나, (b) `cardType`만 별도 필드로 두고도 실제로는 맞지
 * 않는 `UnverifiedReasonCode`(예: "숫자를 못 찾음")로 "데이터가 없음"을 위장하게 된다.
 * 둘 다 원하는 결과가 아니므로, 이번 단계는 `cardType`에 대한 `NormalizationOutcome`
 * 자체를 만들지 않는다. Domain `Card.cardType`이 필수 필드라 이 값은 결국 어딘가에서
 * 결정돼야 하지만, 그 결정(기본값 정책이든 새 reason code 설계든)은 `toDomainCard()`
 * 단계의 몫으로 명시적으로 남긴다.
 */
export interface CardIdentity {
  readonly cardAdId: string;
  readonly cardCode: string | null;
  readonly cardName: string;
  readonly issuerName: string;
  readonly sourceUrl: string | null;
}

/**
 * 구조화되지 않은 경고. 아직 warning code 체계를 확정하지 않으므로 `code`를 큰 union으로
 * 만들지 않고 `string`으로 둔다. 특정 benefit/provenance에 속하지 않는 카드 단위 경고는
 * `provenance: null`이다.
 */
export interface NormalizationWarning {
  readonly code: string;
  readonly message: string;
  readonly provenance: NormalizationProvenance | null;
}

// ---------------------------------------------------------------------------
// PerformanceTier / SharedCap
// ---------------------------------------------------------------------------

/**
 * 카드 전체 benefit 텍스트에서 도출된 전월실적 구간.
 *
 * 배열 순서는 구간의 의미로 쓰지 않는다(`recommendation`의 `PerformanceTier`와 동일한 원칙).
 * threshold 기준 정렬과 "구간 없음 = 실적 무관"의 처리는 다음 계산 단계의 책임이며,
 * 이 타입은 "성능 조건이 없다"는 이유로 0원 tier를 자동 생성하지 않는다 — 그런 카드는
 * `performanceTiers: []`로 남고, 개별 혜택은 `requiredTierId: {status:"parsed", value:null}`로
 * "구간 조건 없음"을 표현한다.
 *
 * `provenance`가 배열인 이유: 같은 threshold를 여러 benefit row가 독립적으로 언급할 수
 * 있으므로, 그 근거 문장들을 전부 보존한다.
 */
export interface NormalizedPerformanceTier {
  readonly tierId: string;
  readonly minPreviousMonthSpend: NormalizationOutcome<Won>;
  readonly provenance: readonly NormalizationProvenance[];
}

export interface NormalizedSharedCapTierLimit {
  readonly tierId: string;
  readonly monthlyRewardCap: NormalizationOutcome<Won>;
  readonly provenance: NormalizationProvenance;
}

/**
 * 여러 benefit이 함께 소진하는 통합 한도. 실제 grouping(원문 "…통합" 문구 매칭)은 다음
 * 단계에서 하며, 이 타입은 그 결과를 담을 자리만 정의한다.
 */
export interface NormalizedSharedCap {
  readonly sharedCapId: string;
  readonly defaultMonthlyRewardCap: NormalizationOutcome<Won>;
  readonly tierLimits: readonly NormalizedSharedCapTierLimit[];
  readonly provenance: readonly NormalizationProvenance[];
}

// ---------------------------------------------------------------------------
// Benefit — Reward
// ---------------------------------------------------------------------------

/**
 * 소비 혜택의 보상 형태. `RateBenefit`/`FixedBenefit`와 마찬가지로 `kind`가 형태를 가른다.
 * `kind` 자체은 outcome으로 감싸지 않는다 — 카드 텍스트에서 "%"인지 "원"인지는 구조적으로
 * 거의 항상 구분되므로(그렇지 않다면 benefit 자체를 만들지 않고 `unverified`로 남긴다),
 * 이 판단은 Piece를 만들지 여부의 문제이지 필드 값의 불확실성 문제가 아니다.
 * 그 안의 실제 수치(`rateBps`, `monthlyAmount`)와 통화 형태만 각각 outcome으로 감싼다.
 */
export type NormalizedReward =
  | {
      readonly kind: "rate";
      readonly rateBps: NormalizationOutcome<BasisPoints>;
      readonly currency: NormalizationOutcome<RewardCurrency>;
    }
  | {
      readonly kind: "fixed";
      readonly monthlyAmount: NormalizationOutcome<Won>;
    };

// ---------------------------------------------------------------------------
// Benefit — Piece
// ---------------------------------------------------------------------------

/**
 * CSV의 한 benefit row가 정규화 과정에서 대응하는 최종 조각 하나.
 * 최종 Domain object(`SpendingBenefit`/`PerkBenefit`) 자체가 아니라, 그것을 만들기 위한
 * 필드별 파싱 상태의 묶음이다. 모든 필드가 `parsed`여야 다음 단계가 실제 Domain object를
 * 만들 수 있다.
 *
 * Domain `SpendingBenefitBase`의 `priority`/`exclusiveGroupId`는 여기 없다. 이 두 값은
 * 혜택 텍스트 하나에서 "파싱"되는 값이 아니라, 같은 배타 그룹의 다른 혜택들과 비교해서
 * 결정되는 값이다(어느 혜택이 우선인지는 카드 전체의 그룹 구성을 알아야 정해진다).
 * 이 layer가 임의로 `priority: 0`, `exclusiveGroupId: null`을 채우면 원문에 없는 값을
 * `parsed`처럼 보이게 만들거나, 맞지 않는 `UnverifiedReasonCode`로 "결정 안 됨"을
 * 위장하게 된다. 이번 단계는 이 카드에서 배타 그룹 분해(구간별 요율 차등)를 만들지
 * 않으므로 이 필드들을 다루지 않으며, 실제 배타 그룹을 만드는 단계(다음 단계의
 * `toDomainCard()` 또는 그 전 단계)에서 명시적으로 결정한다.
 */
export interface NormalizedSpendingBenefitPiece {
  readonly kind: "spendingBenefit";
  readonly benefitId: string;
  readonly name: NormalizationOutcome<string>;
  readonly requiredTierId: NormalizationOutcome<string | null>;
  readonly target: NormalizationOutcome<CategoryTarget>;
  readonly minMonthlySpend: NormalizationOutcome<Won | null>;
  readonly reward: NormalizationOutcome<NormalizedReward>;
  /**
   * `BenefitLimits`(Domain) 자체는 두 필드(`monthlyRewardCap`/`monthlyEligibleSpendCap`)가
   * 이미 각각 `Won | null`이라 "한도 없음"을 표현할 수 있다. 그래서 이 outcome은
   * `BenefitLimits | null`이 아니라 `BenefitLimits`만 감싼다 — 바깥쪽에 `null`을 또 두면
   * "한도 객체 자체가 없음"이라는, Domain에는 없는 의미가 새로 생겨 "모르는 값"과
   * "확인된 무제한"이 다시 뒤섞이게 된다.
   */
  readonly limits: NormalizationOutcome<BenefitLimits>;
  readonly sharedCapId: NormalizationOutcome<string | null>;
  readonly provenance: NormalizationProvenance;
}

interface NormalizedPerkPieceBase {
  readonly kind: "perk";
  readonly benefitId: string;
  readonly name: NormalizationOutcome<string>;
  readonly requiredTierId: NormalizationOutcome<string | null>;
  readonly provenance: NormalizationProvenance;
}

/**
 * `perkKind`는 `NormalizedReward.kind`와 같은 이유로 outcome으로 감싸지 않는다 — 어떤
 * 부가 혜택인지 구분이 안 되면 조각 자체를 만들지 않고 `unverified`로 남긴다.
 *
 * `VoucherOrGiftPerk`/`LoungePerk`/`SignupBonusPerk`의 실제 필드만 그대로 옮긴다.
 * `signupBonus`는 Domain에서 "항상 `first_year_only`로 취급"이 이미 계산 규칙으로
 * 정해져 있고 그 자체가 저장 필드가 아니므로, 여기서도 별도의 recurrence 필드를
 * 만들지 않는다 — 그렇게 하면 계산 규칙과 정규화 데이터가 서로 다른 값을 주장할 때
 * 충돌할 수 있는 자리가 새로 생긴다.
 */
export type NormalizedPerkPiece =
  | (NormalizedPerkPieceBase & {
      readonly perkKind: "voucher" | "gift";
      readonly value: NormalizationOutcome<Won>;
      readonly frequency: NormalizationOutcome<PerkFrequency>;
    })
  | (NormalizedPerkPieceBase & {
      readonly perkKind: "lounge";
      readonly visitsPerYear: NormalizationOutcome<number>;
      readonly valuePerVisit: NormalizationOutcome<Won>;
    })
  | (NormalizedPerkPieceBase & {
      readonly perkKind: "signupBonus";
      readonly value: NormalizationOutcome<Won>;
      readonly requirement: NormalizationOutcome<{ minSpend: Won; withinMonths: number } | null>;
    });

export type NormalizedBenefitPiece = NormalizedSpendingBenefitPiece | NormalizedPerkPiece;

/**
 * CSV benefit row 하나의 정규화 결과. row 하나가 조각 0개(완전히 unverified/unsupported로
 * 빠짐), 1개(분해 없음), 또는 여러 개(실적 구간별 분해 등)로 대응될 수 있다.
 */
export interface NormalizedBenefit {
  readonly sourceBenefitOrder: number;
  readonly pieces: readonly NormalizedBenefitPiece[];
}

// ---------------------------------------------------------------------------
// NormalizedCard
// ---------------------------------------------------------------------------

/** 카드 1장의 정규화 결과. `RawCardRecord` + 그 카드의 모든 `RawBenefitRecord`로부터 만들어진다. */
export interface NormalizedCard {
  readonly cardAdId: string;
  readonly card: NormalizationOutcome<CardIdentity>;
  readonly annualFee: NormalizationOutcome<AnnualFee>;
  readonly performanceTiers: readonly NormalizedPerformanceTier[];
  readonly sharedCaps: readonly NormalizedSharedCap[];
  readonly benefits: readonly NormalizedBenefit[];
  readonly cardLevelWarnings: readonly NormalizationWarning[];
}
