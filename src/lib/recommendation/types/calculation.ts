import type { BasisPoints, Won } from "./money";
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
  | { code: "POINT_VALUATION_UNVERIFIED"; benefitId: BenefitId };
