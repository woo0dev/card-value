-- CardValue v1 minimum schema.
--
-- Stores exactly the Domain `Card` shape from src/lib/recommendation/types/card.ts and
-- src/lib/recommendation/types/benefit.ts, plus two independent raw-snapshot audit tables
-- (AGENTS.md domain decision 11: "원본 raw 데이터는... 도메인 모델에는 포함하지 않는다").
--
-- This migration does not add any Domain concept that does not already exist in
-- src/lib/recommendation/types/*. `shared_caps` is intentionally excluded here — current
-- ingestion (toDomainCard.ts) always produces an empty array, so there is nothing to store
-- yet. Add it in a later migration when the parser actually populates it.
--
-- No application code in this repository reads or writes these tables yet. The DB -> Domain
-- `Card` mapper, the CSV ingestion script and RLS-bypassing service-role usage are separate,
-- later steps.

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
-- One row per Domain `Card`. `id` is the same string toDomainCard() casts from
-- CardIdentity.cardAdId (Card.id = CardId), reused directly as primary key per the earlier
-- ID-strategy analysis: it is already the stable external identifier the ingestion pipeline
-- keys on for re-ingestion, and Domain never treats it as anything but an opaque id.
create table public.cards (
  id text primary key,
  issuer text not null,
  name text not null,
  -- Card.cardType: "credit" | "check" | "unknown". "unknown" is not a placeholder default —
  -- it is the explicit, current state of every ingested card (see types/card.ts doc comment).
  card_type text not null check (card_type in ('credit', 'check', 'unknown')),
  -- Card.annualFee (Won is a non-negative integer KRW; AnnualFee.firstYearWaived is a plain bool).
  annual_fee_amount integer not null check (annual_fee_amount >= 0),
  annual_fee_first_year_waived boolean not null,
  -- Card.performanceExcludedCategories: SpendingCategory[]. Always [] today (toDomainCard.ts
  -- known limitation — the parser does not read this column yet); stored as jsonb because it
  -- is only ever read/written as a whole array, never queried by element.
  performance_excluded_categories jsonb not null default '[]'::jsonb,
  -- Card.unverifiedConditions: { field: CoreConditionField; benefitId: string | null }[].
  -- benefitId, when non-null, must reference spending_benefits.id or perks.id (see that
  -- invariant note on spending_benefits/perks below) — not enforced at the DB level here,
  -- same as Domain's own validateCard() being the sole enforcer today.
  unverified_conditions jsonb not null default '[]'::jsonb,
  -- Card.source: CardSource.
  source_url text not null,
  verified_at timestamptz,
  -- Not a Domain `Card` field. Kept only as raw display/reference metadata from
  -- RawCardRecord.cardCode (card-data/types.ts) — never interpreted by recommendation domain.
  card_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cards is
  'Domain Card (src/lib/recommendation/types/card.ts). One row per successfully toDomainCard()-ed card.';
comment on column public.cards.id is 'Card.id — the same string as CardIdentity.cardAdId, reused as external identifier and PK.';
comment on column public.cards.card_code is 'Raw display metadata only (RawCardRecord.cardCode) — not part of Domain Card.';

-- ---------------------------------------------------------------------------
-- performance_tiers
-- ---------------------------------------------------------------------------
create table public.performance_tiers (
  id text primary key,
  card_id text not null references public.cards (id) on delete cascade,
  name text not null,
  min_previous_month_spend integer not null check (min_previous_month_spend >= 0),
  -- validation.ts DUPLICATE_TIER_THRESHOLD: a card's tiers must not repeat the same threshold.
  unique (card_id, min_previous_month_spend)
);

comment on table public.performance_tiers is 'Card.performanceTiers[] (src/lib/recommendation/types/benefit.ts PerformanceTier).';

-- ---------------------------------------------------------------------------
-- spending_benefits
-- ---------------------------------------------------------------------------
-- One row per final, already-decided Domain `SpendingBenefit` (RateBenefit | FixedBenefit) —
-- i.e. one piece, matching the flat shape Card.spendingBenefits already has. D-decomposition
-- (multi-tier) and cross-row duplicate collapsing (createDuplicateGroupId) both already happen
-- in toDomainCard.ts before this table is ever written to; this table does not re-decide any
-- of that, it only stores the result.
create table public.spending_benefits (
  id text primary key,
  card_id text not null references public.cards (id) on delete cascade,
  -- Provenance only (NormalizationProvenance), not read by recommendation domain. Kept so a
  -- row can be traced back to the raw CSV row it came from without re-parsing the id string
  -- (id.ts explicitly says the id itself is not meant to be parsed back).
  source_benefit_order integer not null,
  piece_index integer not null,
  name text not null,
  -- SpendingBenefitBase.priority: a plain finite number, decimals and negatives both allowed
  -- (validation.ts validatePriority) — not an integer type.
  priority double precision not null,
  required_tier_id text references public.performance_tiers (id),
  -- CategoryTarget: { type: "categories" | "allExcept"; categories: SpendingCategory[] }.
  -- Always read/written as a whole value by eligibility.ts, never queried by element.
  target jsonb not null,
  min_monthly_spend integer check (min_monthly_spend is null or min_monthly_spend >= 0),
  -- BenefitLimits, flattened into two columns (no union, no nesting — normalizing these two
  -- nullable integers directly is simpler than wrapping them in jsonb).
  monthly_reward_cap integer check (monthly_reward_cap is null or monthly_reward_cap >= 0),
  monthly_eligible_spend_cap integer check (monthly_eligible_spend_cap is null or monthly_eligible_spend_cap >= 0),
  -- No FK yet: shared_caps table does not exist in this migration (see file header). Always
  -- null today in practice, since toDomainCard.ts never populates SharedCap grouping.
  shared_cap_id text,
  -- Opaque grouping tag (id.ts createExclusiveGroupId / createDuplicateGroupId). Not a foreign
  -- key to any table — there is no separate "exclusive group" entity in Domain, rows sharing
  -- the same string value simply compete in eligibility.ts's resolveExclusiveGroups().
  exclusive_group_id text,
  kind text not null check (kind in ('rate', 'fixed')),
  rate_bps integer check (rate_bps is null or rate_bps >= 0),
  monthly_amount integer check (monthly_amount is null or monthly_amount >= 0),
  -- RewardCurrency: only present for kind = 'rate' (FixedBenefit has no currency field at all).
  currency jsonb,
  original_condition_text text,
  extracted_at timestamptz not null,
  -- Enforces the RateBenefit | FixedBenefit discriminated union shape at the DB level, so a
  -- row can never mix rate_bps/currency with monthly_amount or leave the kind's own required
  -- field null.
  constraint spending_benefits_kind_shape check (
    (kind = 'rate' and rate_bps is not null and currency is not null and monthly_amount is null)
    or
    (kind = 'fixed' and monthly_amount is not null and rate_bps is null and currency is null)
  )
);

comment on table public.spending_benefits is
  'Card.spendingBenefits[] (SpendingBenefit = RateBenefit | FixedBenefit). One row per final Domain piece.';
comment on column public.spending_benefits.exclusive_group_id is
  'Opaque grouping tag only — no FK target table exists for this in Domain.';

create index spending_benefits_card_id_idx on public.spending_benefits (card_id);

-- ---------------------------------------------------------------------------
-- perks
-- ---------------------------------------------------------------------------
-- One row per Domain `PerkBenefit` (VoucherOrGiftPerk | LoungePerk | SignupBonusPerk).
create table public.perks (
  id text primary key,
  card_id text not null references public.cards (id) on delete cascade,
  source_benefit_order integer not null,
  piece_index integer not null,
  name text not null,
  required_tier_id text references public.performance_tiers (id),
  kind text not null check (kind in ('voucher', 'gift', 'lounge', 'signupBonus')),
  -- voucher/gift/signupBonus only.
  value integer check (value is null or value >= 0),
  -- voucher/gift only (PerkFrequency).
  frequency text check (frequency is null or frequency in ('monthly', 'yearly', 'once')),
  -- lounge only.
  visits_per_year integer check (visits_per_year is null or visits_per_year >= 0),
  value_per_visit integer check (value_per_visit is null or value_per_visit >= 0),
  -- signupBonus only: { minSpend: Won; withinMonths: number } | null. A SQL null here is only
  -- meaningful when kind = 'signupBonus' — it then means the Domain value null (no additional
  -- requirement), not "field not applicable".
  requirement jsonb,
  original_condition_text text,
  extracted_at timestamptz not null,
  constraint perks_kind_shape check (
    (kind in ('voucher', 'gift') and value is not null and frequency is not null
      and visits_per_year is null and value_per_visit is null and requirement is null)
    or
    (kind = 'lounge' and visits_per_year is not null and value_per_visit is not null
      and value is null and frequency is null and requirement is null)
    or
    (kind = 'signupBonus' and value is not null
      and frequency is null and visits_per_year is null and value_per_visit is null)
  )
);

comment on table public.perks is
  'Card.perks[] (PerkBenefit = VoucherOrGiftPerk | LoungePerk | SignupBonusPerk).';

create index perks_card_id_idx on public.perks (card_id);

-- ---------------------------------------------------------------------------
-- raw_card_snapshots / raw_benefit_snapshots
-- ---------------------------------------------------------------------------
-- Independent audit trail of the original CSV rows (AGENTS.md decision 11). Deliberately
-- carry no foreign key to `cards`: a snapshot may be ingested before the corresponding card
-- row exists (or after a card has since been removed), and recommendation calculation never
-- reads these tables directly — only a future re-ingestion job would.
create table public.raw_card_snapshots (
  card_ad_id text not null,
  ingested_at timestamptz not null default now(),
  raw jsonb not null,
  primary key (card_ad_id, ingested_at)
);

comment on table public.raw_card_snapshots is
  'Untouched RawCardRecord.raw snapshots (card_value_cards.csv rows) per ingestion run, for audit/re-processing only.';

create table public.raw_benefit_snapshots (
  card_ad_id text not null,
  benefit_order integer not null,
  ingested_at timestamptz not null default now(),
  raw jsonb not null,
  primary key (card_ad_id, benefit_order, ingested_at)
);

comment on table public.raw_benefit_snapshots is
  'Untouched RawBenefitRecord.raw snapshots (card_value_benefits.csv rows) per ingestion run, for audit/re-processing only.';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- This is a public card-comparison catalog: the four Domain tables are safe to read with the
-- anon key, but nothing should be writable through the public API (ingestion writes with the
-- service role key, which bypasses RLS entirely — see AGENTS.md principle 8).
alter table public.cards enable row level security;
alter table public.performance_tiers enable row level security;
alter table public.spending_benefits enable row level security;
alter table public.perks enable row level security;

create policy "cards are publicly readable" on public.cards for select using (true);
create policy "performance_tiers are publicly readable" on public.performance_tiers for select using (true);
create policy "spending_benefits are publicly readable" on public.spending_benefits for select using (true);
create policy "perks are publicly readable" on public.perks for select using (true);

-- Raw snapshots are internal ingestion/audit data, not part of the public catalog. RLS is
-- enabled with no policies at all, so anon/authenticated roles get zero access (service role
-- still bypasses RLS for the ingestion job).
alter table public.raw_card_snapshots enable row level security;
alter table public.raw_benefit_snapshots enable row level security;
