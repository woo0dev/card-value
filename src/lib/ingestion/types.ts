import type {
  CategoryTarget,
  RewardCurrency,
  SpendingCategory,
  UnverifiedCondition,
} from "../recommendation/types";

/**
 * Supabase 테이블 row 타입. `supabase/migrations/20260928081633_create_card_domain_schema.sql`의
 * 컬럼 이름/타입을 그대로 따른다 — 이 파일은 DB row 모양만 정의하고, Domain → row 변환은
 * `mapper.ts`가 담당한다.
 */

export interface CardRow {
  readonly id: string;
  readonly issuer: string;
  readonly name: string;
  readonly card_type: string;
  readonly annual_fee_amount: number;
  readonly annual_fee_first_year_waived: boolean;
  readonly performance_excluded_categories: readonly SpendingCategory[];
  readonly unverified_conditions: readonly UnverifiedCondition[];
  readonly source_url: string;
  readonly verified_at: string | null;
  /** Domain `Card`에는 없는 필드 — `RawCardRecord.cardCode`에서 직접 옮긴다. */
  readonly card_code: string | null;
  /** `created_at`은 포함하지 않는다 — DB `default now()`가 최초 삽입에만 적용되도록,
   * upsert 시 이 컬럼을 갱신 대상에서 제외한다(재수집 시 최초 생성 시각 보존). */
  readonly updated_at: string;
}

export interface PerformanceTierRow {
  readonly id: string;
  readonly card_id: string;
  readonly name: string;
  readonly min_previous_month_spend: number;
}

interface SpendingBenefitRowBase {
  readonly id: string;
  readonly card_id: string;
  readonly source_benefit_order: number;
  readonly piece_index: number;
  readonly name: string;
  readonly priority: number;
  readonly required_tier_id: string | null;
  readonly target: CategoryTarget;
  readonly min_monthly_spend: number | null;
  readonly monthly_reward_cap: number | null;
  readonly monthly_eligible_spend_cap: number | null;
  readonly shared_cap_id: string | null;
  readonly exclusive_group_id: string | null;
  readonly original_condition_text: string;
  readonly extracted_at: string;
}

export type SpendingBenefitRow =
  | (SpendingBenefitRowBase & {
      readonly kind: "rate";
      readonly rate_bps: number;
      readonly monthly_amount: null;
      readonly currency: RewardCurrency;
    })
  | (SpendingBenefitRowBase & {
      readonly kind: "fixed";
      readonly rate_bps: null;
      readonly monthly_amount: number;
      readonly currency: null;
    });

interface PerkRowBase {
  readonly id: string;
  readonly card_id: string;
  readonly source_benefit_order: number;
  readonly piece_index: number;
  readonly name: string;
  readonly required_tier_id: string | null;
  readonly original_condition_text: string;
  readonly extracted_at: string;
}

export type PerkRow =
  | (PerkRowBase & {
      readonly kind: "voucher" | "gift";
      readonly value: number;
      readonly frequency: "monthly" | "yearly" | "once";
      readonly visits_per_year: null;
      readonly value_per_visit: null;
      readonly requirement: null;
    })
  | (PerkRowBase & {
      readonly kind: "lounge";
      readonly value: null;
      readonly frequency: null;
      readonly visits_per_year: number;
      readonly value_per_visit: number;
      readonly requirement: null;
    })
  | (PerkRowBase & {
      readonly kind: "signupBonus";
      readonly value: number;
      readonly frequency: null;
      readonly visits_per_year: null;
      readonly value_per_visit: null;
      readonly requirement: { readonly minSpend: number; readonly withinMonths: number } | null;
    });

export interface RawCardSnapshotRow {
  readonly card_ad_id: string;
  readonly ingested_at: string;
  readonly raw: Readonly<Record<string, string | null>>;
}

export interface RawBenefitSnapshotRow {
  readonly card_ad_id: string;
  readonly benefit_order: number;
  readonly ingested_at: string;
  readonly raw: Readonly<Record<string, string | null>>;
}
