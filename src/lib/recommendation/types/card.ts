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

export type CardType = "credit" | "check";

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

/** 검증되지 않은 핵심 조건. `benefitId`가 `null`이면 카드 전체 조건이다. */
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
