import type { BasisPoints, Brand, Won } from "./money";
import type { SpendingCategory } from "./category";

export type BenefitId = Brand<string, "BenefitId">;
export type PerformanceTierId = Brand<string, "PerformanceTierId">;
export type SharedCapId = Brand<string, "SharedCapId">;
export type ExclusiveGroupId = Brand<string, "ExclusiveGroupId">;

/**
 * 전월실적 구간. 카드의 `performanceTiers`에 실적 오름차순으로 나열한다.
 *
 * 구간의 높고 낮음은 배열 순서가 아니라 `minPreviousMonthSpend` 크기로 판정한다.
 * 전월실적이 `minPreviousMonthSpend` 이상이면 그 구간에 도달한 것이며,
 * `requiredTierId`처럼 구간을 참조하는 조건은 "해당 구간 이상"을 뜻한다.
 */
export interface PerformanceTier {
  id: PerformanceTierId;
  name: string;
  /** 이 구간에 도달하기 위한 전월실적 하한 (이상). */
  minPreviousMonthSpend: Won;
}

/** 특정 실적 구간에 도달했을 때의 통합 한도 (예: 70만 이상 → 20,000원). */
export interface SharedCapTierLimit {
  tierId: PerformanceTierId;
  monthlyRewardCap: Won;
}

/**
 * 여러 혜택이 함께 소진하는 월 통합 한도. 실적 구간별로 한도가 달라질 수 있다.
 *
 * 적용 한도: `tierLimits` 중 도달한 구간의 것 가운데 `minPreviousMonthSpend`가 가장 큰
 * 구간의 `monthlyRewardCap`을 쓰고, 해당하는 구간이 없으면 `defaultMonthlyRewardCap`을 쓴다.
 * 예) 기본 0원, 30만 이상 10,000원, 70만 이상 20,000원.
 */
export interface SharedCap {
  id: SharedCapId;
  name: string;
  defaultMonthlyRewardCap: Won;
  tierLimits: readonly SharedCapTierLimit[];
}

/** 포인트/마일리지의 원화 환산. 임의의 `1P = 1원` 기본값은 두지 않는다. */
export interface PointValuation {
  /** 1,000 포인트의 원화 가치. 정수 유지를 위해 1포인트 단가 대신 사용한다. */
  wonPerThousandPoints: Won;
  sourceUrl: string;
  /** ISO 8601. 검증된 적이 없으면 `null`. */
  verifiedAt: string | null;
}

export type RewardCurrency =
  | { type: "won"; form: "discount" | "cashback" }
  | { type: "points"; programName: string; valuation: PointValuation };

/** 혜택이 적용되는 소비 카테고리. 제외 카테고리는 `allExcept`로 표현한다. */
export type CategoryTarget =
  | { type: "categories"; categories: readonly SpendingCategory[] }
  | { type: "allExcept"; categories: readonly SpendingCategory[] };

export interface BenefitLimits {
  /** 월 혜택(할인/적립) 금액 상한. */
  monthlyRewardCap: Won | null;
  /** 월 혜택 적용 대상 소비액 상한. */
  monthlyEligibleSpendCap: Won | null;
}

/**
 * 소비 혜택 공통 필드.
 *
 * 현재 소비 입력은 카테고리별 월 합계뿐이므로 건당 최소 결제 금액, 결제 횟수 조건,
 * 단위당(리터당 등) 혜택, 결제수단 조건, 특정 가맹점 조건은 표현하지 않는다.
 * 이들은 입력 모델 확장이 선행되어야 하는 범위 밖 조건이다 (`spending.ts` 참고).
 */
interface SpendingBenefitBase {
  id: BenefitId;
  name: string;
  /**
   * 낮을수록 먼저 적용한다. 통합 한도 소진 순서와 배타 그룹의 승자를 결정한다.
   * 값이 같으면 `id` 오름차순(문자열 코드 유닛 순, 로케일 비의존)으로 먼저 적용한다.
   * 따라서 `priority`가 유일할 필요는 없고, 같은 입력은 항상 같은 결과를 만든다.
   */
  priority: number;
  /** 필요한 최소 전월실적 구간. 조건이 없으면 `null`. */
  requiredTierId: PerformanceTierId | null;
  target: CategoryTarget;
  /** 대상 소비액 월 합계의 최소 조건. 없으면 `null`. */
  minMonthlySpend: Won | null;
  limits: BenefitLimits;
  sharedCapId: SharedCapId | null;
  /**
   * 같은 그룹에서는 조건을 충족한 혜택 중 `priority`가 가장 낮은 하나만 적용한다.
   * 실적 구간별로 요율이 달라지는 혜택을 별도 혜택으로 나열할 때 사용한다.
   */
  exclusiveGroupId: ExclusiveGroupId | null;
}

export interface RateBenefit extends SpendingBenefitBase {
  kind: "rate";
  rateBps: BasisPoints;
  currency: RewardCurrency;
}

export interface FixedBenefit extends SpendingBenefitBase {
  kind: "fixed";
  /** 조건 충족 시 매월 제공되는 정액 혜택. */
  monthlyAmount: Won;
}

/** 소비 금액에 연동되는 혜택. */
export type SpendingBenefit = RateBenefit | FixedBenefit;

/**
 * 부가 혜택의 제공 주기. 연간 가치에 반복 반영되는지가 달라진다.
 * - `monthly`: 매월 제공. 연간 가치는 월 가치 × 환산 개월 수. (`recurring`)
 * - `yearly`: 매년 제공. 연간 가치는 1회 가치. (`recurring`)
 * - `once`: 카드 사용 기간 전체에서 1회만 제공. 반복되지 않는 첫해성 혜택이다. (`first_year_only`)
 */
export type PerkFrequency = "monthly" | "yearly" | "once";

/**
 * 부가 혜택이 연간 가치에 반영되는 방식.
 * - `recurring`: 매년 반복되는 혜택. 일반적인 연간 가치에 포함한다.
 * - `first_year_only`: 첫해에만 얻는 혜택 (`once` 주기, 가입 보너스). 반복 가능한 연간 가치와
 *   구분해서 기록하며, 반복 혜택인 것처럼 매년 더하지 않는다.
 */
export type PerkRecurrence = "recurring" | "first_year_only";

interface PerkBase {
  id: BenefitId;
  name: string;
  requiredTierId: PerformanceTierId | null;
}

/** 바우처/기프트. 구조가 같으므로 `kind`로만 구분한다 (UI 표시용). */
export interface VoucherOrGiftPerk extends PerkBase {
  kind: "voucher" | "gift";
  /** 제공 1회당 가치. */
  value: Won;
  frequency: PerkFrequency;
}

export interface LoungePerk extends PerkBase {
  kind: "lounge";
  visitsPerYear: number;
  valuePerVisit: Won;
}

/** 가입 보너스. 항상 `first_year_only`로 취급하며 반복 혜택으로 환산하지 않는다. */
export interface SignupBonusPerk extends PerkBase {
  kind: "signupBonus";
  value: Won;
  /** 발급 후 일정 기간 내 최소 사용 조건. 없으면 `null`. */
  requirement: { minSpend: Won; withinMonths: number } | null;
}

/** 소비와 무관한 부가 혜택. 일반 소비 혜택 계산과 분리해서 다룬다. */
export type PerkBenefit = VoucherOrGiftPerk | LoungePerk | SignupBonusPerk;

export type Benefit = SpendingBenefit | PerkBenefit;
