-- Grant-only migration. Does not touch table structure, columns, or RLS policies from
-- 20260928081633_create_card_domain_schema.sql.
--
-- The previous migration created these 6 tables but never explicitly GRANTed DML privileges
-- to any Data API role. `information_schema.role_table_grants` confirmed `service_role` only
-- had REFERENCES/TRIGGER/TRUNCATE on all 6 tables (no SELECT/INSERT/UPDATE/DELETE) — this is
-- a plain Postgres permission gap, not an RLS policy gap (RLS remains enabled and unchanged;
-- `service_role` bypasses RLS once it actually has the underlying table privilege).
--
-- `anon`/`authenticated` are intentionally left untouched here — they already have their own
-- public SELECT policies (RLS) on the 4 catalog tables from the previous migration, and no
-- DML access is granted to them by this migration (ingestion only ever uses service_role).
grant select, insert, update, delete on table public.cards to service_role;
grant select, insert, update, delete on table public.performance_tiers to service_role;
grant select, insert, update, delete on table public.spending_benefits to service_role;
grant select, insert, update, delete on table public.perks to service_role;
grant select, insert, update, delete on table public.raw_card_snapshots to service_role;
grant select, insert, update, delete on table public.raw_benefit_snapshots to service_role;
