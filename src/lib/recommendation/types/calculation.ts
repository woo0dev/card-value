import type { BasisPoints, RewardQuantity, Won } from "./money";
import type {
  BenefitId,
  ExclusiveGroupId,
  PerformanceTierId,
  PerkBenefit,
  PerkRecurrence,
  SharedCapId,
} from "./benefit";
import type { CoreConditionField } from "./card";

/**
 * 소비 혜택이 최종적으로 적용되지 않은 사유. 구조화된 데이터를 함께 남기며,
 * 사용자에게 보여줄 문구는 UI 계층에서 생성한다.
 */
export type NotAppliedReason =
  | {
      code: "TIER_NOT_MET";
      requiredTierId: PerformanceTierId;
      previousMonthPerformance: Won;
      requiredSpend: Won;
    }
  | { code: "NO_ELIGIBLE_SPEND" }
  | { code: "MIN_MONTHLY_SPEND_NOT_MET"; required: Won; actual: Won }
  | {
      code: "SUPERSEDED_IN_EXCLUSIVE_GROUP";
      groupId: ExclusiveGroupId;
      supersededBy: BenefitId;
    }
  | { code: "SHARED_CAP_EXHAUSTED"; sharedCapId: SharedCapId };

export type NotAppliedReasonCode = NotAppliedReason["code"];

/** 계산 과정의 진행 기록. 최종 미적용 사유와 달리 결과 상태를 결정하지 않는다. */
export type CalculationProgressStep =
  | { code: "TIER_MET"; tierId: PerformanceTierId }
  | { code: "ELIGIBLE_SPEND_COMPUTED"; eligibleSpend: Won }
  | { code: "ELIGIBLE_SPEND_CAPPED"; cap: Won; before: Won; after: Won }
  | { code: "REWARD_COMPUTED"; rawAmount: Won }
  | { code: "REWARD_QUANTITY_COMPUTED"; quantity: RewardQuantity }
  | { code: "BENEFIT_CAP_APPLIED"; cap: Won; before: Won; after: Won }
  | {
      code: "SHARED_CAP_APPLIED";
      sharedCapId: SharedCapId;
      /** 실적 구간을 반영해 결정된 실제 적용 한도. */
      cap: Won;
      before: Won;
      after: Won;
    }
  | { code: "PERK_NOT_SELECTED" }
  | { code: "PERK_VALUE_REALIZED"; realizationBps: BasisPoints };

/**
 * 계산 trace 한 단계. 진행 기록과 미적용 사유를 모두 담아 과정을 순서대로 보존한다.
 * 미적용 혜택의 최종 사유는 `BenefitCalculation.reason`에서 직접 확인한다.
 */
export type CalculationStep = CalculationProgressStep | NotAppliedReason;

export type CalculationStepCode = CalculationStep["code"];

interface BenefitCalculationBase {
  benefitId: BenefitId;
  eligibleSpend: Won;
  /** 한도 적용 전 금액. */
  rawAmount: Won;
  /** 한도와 중복 규칙을 모두 적용한 월 혜택 금액. 미적용이면 0. */
  finalAmount: Won;
  steps: readonly CalculationStep[];
}

export interface AppliedBenefitCalculation extends BenefitCalculationBase {
  status: "applied";
}

export interface NotAppliedBenefitCalculation extends BenefitCalculationBase {
  status: "not_applied";
  /** 미적용 사유. `steps`의 마지막 단계와 일치한다. */
  reason: NotAppliedReason;
}

/** 소비 혜택 1개의 계산 결과와 trace. */
export type BenefitCalculation =
  | AppliedBenefitCalculation
  | NotAppliedBenefitCalculation;

interface RewardCalculationBase {
  benefitId: BenefitId;
  currencyType: "points" | "miles";
  programName: string;
  eligibleSpend: Won;
  /** 원화 환산 없이 적립된 수량. 미적용이면 0. */
  quantity: RewardQuantity;
  steps: readonly CalculationStep[];
}

export interface AppliedRewardCalculation extends RewardCalculationBase {
  status: "applied";
}

export interface NotAppliedRewardCalculation extends RewardCalculationBase {
  status: "not_applied";
  /** 미적용 사유. `steps`의 마지막 단계와 일치한다. */
  reason: NotAppliedReason;
}

/**
 * 포인트/마일리지 혜택 1개의 계산 결과와 trace. `BenefitCalculation`과 구조를 의도적으로
 * 대칭시키되, 원화 금액(`rawAmount`/`finalAmount`) 대신 원화 환산 없는 `quantity`를 담는다.
 * `benefitCalculations`(원화 합산)와 절대 섞이지 않으며, `netAnnualValue` 계산에도 관여하지 않는다.
 */
export type RewardCalculation = AppliedRewardCalculation | NotAppliedRewardCalculation;

/**
 * 같은 프로그램(`currencyType` + `programName`)의 `RewardCalculation`을 합산한 결과.
 * 기본 적립 + 추가 적립처럼 혜택이 여러 개로 나뉘어 있어도 프로그램 단위로 확인할 수 있도록
 * 미리 집계해 둔다(`monthlyBenefit`이 `benefitCalculations`의 편의 합산인 것과 같은 위치).
 */
export interface RewardProgramTotal {
  currencyType: "points" | "miles";
  programName: string;
  totalQuantity: RewardQuantity;
}

/** 부가 혜택 1개의 계산 trace. 일반 소비 혜택과 분리해서 표현한다. */
export interface PerkCalculation {
  perkId: BenefitId;
  kind: PerkBenefit["kind"];
  /** `first_year_only`는 연간 반복 가치에 포함하지 않고 별도로 집계한다. */
  recurrence: PerkRecurrence;
  /**
   * 표기상 가치. `recurring`이면 연간 환산 가치, `first_year_only`이면 1회 가치.
   */
  nominalValue: Won;
  /** 실현 비율. 사용자가 선택하기 전에는 0이다. */
  realizationBps: BasisPoints;
  realizedValue: Won;
  steps: readonly CalculationStep[];
}

export type RoundingPolicy = "floor_per_benefit";

export type PerkValuationPolicy = "exclude_perks" | "user_selected_realization";

/**
 * 한 번의 추천 실행에 공통으로 적용된 계산 가정.
 * `RecommendationResult.assumptions`에만 기록하고 카드별 결과에는 중복 저장하지 않는다.
 */
export interface CalculationAssumptions {
  roundingPolicy: RoundingPolicy;
  /** 월 혜택을 연간으로 환산할 때 곱하는 개월 수. 기본값은 12. */
  annualizationMonths: number;
  perkValuation: PerkValuationPolicy;
}

export type CalculationWarning =
  | { code: "UNVERIFIED_CONDITION"; field: CoreConditionField; benefitId: BenefitId | null }
  | { code: "FIRST_YEAR_FEE_WAIVED" }
  | { code: "POINT_VALUATION_UNVERIFIED"; benefitId: BenefitId }
  | { code: "PREVIOUS_MONTH_PERFORMANCE_ASSUMED" };
