import type { Brand, Won } from "./money";
import type { SpendingCategory } from "./category";
import type {
  BenefitId,
  PerkBenefit,
  PerformanceTier,
  SharedCap,
  SpendingBenefit,
} from "./benefit";

export type CardId = Brand<string, "CardId">;

/**
 * `"unknown"`은 임의의 기본값이 아니다 — 현재 데이터로 credit/check 여부를 판별할
 * 근거가 없다는 사실을 명시적으로 표현하는 상태다. credit/check를 확인할 수 있는
 * 데이터가 생기면 그때 실제 값으로 채운다. `"unknown"`이라고 해서 "credit으로
 * 간주해도 됨" 같은 암묵적 의미를 가지지 않는다.
 */
export type CardType = "credit" | "check" | "unknown";

export interface AnnualFee {
  amount: Won;
  /** 첫해 연회비 면제 여부. 반영 방식은 계산 엔진이 결정한다. */
  firstYearWaived: boolean;
}

/** 카드 데이터의 출처. 원본 raw 데이터는 DB 저장 영역에서 관리한다. */
export interface CardSource {
  sourceUrl: string;
  /** ISO 8601. 검증된 적이 없으면 `null`. */
  verifiedAt: string | null;
}

/** 결과의 신뢰성에 영향을 주는 핵심 카드 조건 항목. */
export type CoreConditionField =
  | "annualFee"
  | "performanceTiers"
  | "target"
  | "rate"
  | "limits"
  | "minSpend"
  | "pointValuation";

/**
 * 검증되지 않은 핵심 조건.
 *
 * - `benefitId`가 `null`인 경우 둘 중 하나다: (1) `annualFee`처럼 애초에 특정 benefit에
 *   속하지 않는 카드 전체 조건이거나, (2) 원문/정규화 단계의 특정 piece에서 비롯된
 *   조건이지만 그 piece가 fully parsed되지 않아 Domain `spendingBenefits`/`perks`로
 *   만들어지지 않은 경우다. 두 경우 모두 "가리킬 실제 benefit이 없다"는 점은 같다.
 * - `benefitId`가 `null`이 아니면 반드시 같은 `Card`의 `spendingBenefits[].id` 또는
 *   `perks[].id`에 실제로 존재하는 benefit만 가리킨다 (`validateCard()`가 이 참조를
 *   검증한다). 존재하지 않는 piece를 가리키는 값을 넣지 않는다.
 */
export interface UnverifiedCondition {
  field: CoreConditionField;
  benefitId: BenefitId | null;
}

/** 카드 상품 정의(정적 데이터). 계산 결과는 포함하지 않는다. */
export interface Card {
  id: CardId;
  issuer: string;
  name: string;
  cardType: CardType;
  annualFee: AnnualFee;
  /** 전월실적 구간. 실적 오름차순. */
  performanceTiers: readonly PerformanceTier[];
  /** 전월실적 산정에서 제외되는 카테고리. */
  performanceExcludedCategories: readonly SpendingCategory[];
  sharedCaps: readonly SharedCap[];
  spendingBenefits: readonly SpendingBenefit[];
  perks: readonly PerkBenefit[];
  source: CardSource;
  unverifiedConditions: readonly UnverifiedCondition[];
}
