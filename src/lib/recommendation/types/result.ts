import type { Won } from "./money";
import type { PerformanceTierId } from "./benefit";
import type { CardId, UnverifiedCondition } from "./card";
import type { MonthlySpending } from "./spending";
import type {
  BenefitCalculation,
  CalculationAssumptions,
  CalculationWarning,
  PerkCalculation,
  RewardCalculation,
  RewardProgramTotal,
} from "./calculation";
import type { NonEmptyReadonlyArray, ValidationErrorCode } from "./validation";

/**
 * 카드 1장의 계산 결과. 순혜택이 음수여도 유효한 결과다.
 * 계산 가정(`assumptions`)은 추천 실행 단위이므로 `RecommendationResult`에 있다.
 */
export interface CardValueResult {
  cardId: CardId;
  /** 전월실적 산정 후 도달한 구간. 어느 구간에도 도달하지 못하면 `null`. */
  achievedTierId: PerformanceTierId | null;
  previousMonthPerformance: Won;
  monthlyBenefit: Won;
  /** `monthlyBenefit * annualizationMonths`. */
  annualSpendingBenefit: Won;
  /** 매년 반복되는(`recurring`) 부가 혜택의 실현 가치 합계. */
  annualPerkValue: Won;
  /** `annualSpendingBenefit + annualPerkValue`. 첫해성 혜택은 포함하지 않는다. */
  annualBenefit: Won;
  annualFee: Won;
  /** `annualBenefit - annualFee`. 반복 가능한 연간 기준이며 음수 가능. */
  netAnnualValue: Won;
  /** 첫해에만 얻는(`first_year_only`) 부가 혜택의 실현 가치 합계. `netAnnualValue`에 포함하지 않는다. */
  firstYearOnlyPerkValue: Won;
  benefitCalculations: readonly BenefitCalculation[];
  perkCalculations: readonly PerkCalculation[];
  /** 포인트/마일리지 혜택의 계산 결과. 원화 환산이 없으며 `netAnnualValue`에 포함되지 않는다. */
  rewardCalculations: readonly RewardCalculation[];
  /** `rewardCalculations`를 프로그램 단위로 합산한 결과. */
  rewardsByProgram: readonly RewardProgramTotal[];
  warnings: readonly CalculationWarning[];
}

export type ExclusionReason =
  | { code: "UNVERIFIED_CORE_CONDITION"; conditions: readonly UnverifiedCondition[] }
  | {
      code: "FILTERED_BY_USER_PREFERENCE";
      preference: "maxAnnualFee" | "issuer" | "cardType";
    }
  | {
      code: "VALIDATION_FAILED";
      /**
       * `validateCard()` 실패 사유의 code만 옮긴다. `ValidationIssue`(`path`/`context` 포함)를
       * 그대로 노출하지 않는다 — validation.ts의 내부 진단 구조가 recommendation 결과 계층에
       * 강하게 결합되지 않도록 하기 위함이다.
       */
      errors: NonEmptyReadonlyArray<ValidationErrorCode>;
    };

/** 추천 대상에서 제외된 카드와 그 사유. */
export interface ExcludedCard {
  cardId: CardId;
  reasons: readonly ExclusionReason[];
}

export interface RankedCard {
  /** 1부터 시작하는 순위. */
  rank: number;
  result: CardValueResult;
}

export interface RecommendationResult {
  /** 계산에 사용한 입력의 스냅샷. */
  input: MonthlySpending;
  /** `netAnnualValue` 기준 정렬 결과. */
  ranked: readonly RankedCard[];
  excluded: readonly ExcludedCard[];
  /** 이 추천 실행의 모든 카드에 공통으로 적용된 계산 가정. */
  assumptions: CalculationAssumptions;
}
