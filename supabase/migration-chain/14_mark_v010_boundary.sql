-- Issue #51 · Migration chain, step 14: the released v0.1.0 database, and nothing after it
--
-- Runs against a database reset to `20260921000300_imprest_receipt_handover_integrity` — the 39th
-- and last released migration, which is exactly what hosted Supabase holds today. The v0.1.0 phase
-- then builds the v0.0.5 fixture's ground on it (step 11) and adds imprest funding (step 15), so
-- the reporting migrations meet a database carrying every kind of record production can hold.
--
-- It asserts the boundary before writing the marker that step 11 reads, so the marker can only
-- ever exist on the database it names.

begin;

do $$
begin
  if to_regclass('public.imprest_fundings') is null
     or to_regclass('public.imprest_funding_handovers') is null then
    raise exception
      'the database is not at the v0.1.0 boundary: imprest funding is missing. Reset to version '
      '20260921000300 before running this fixture';
  end if;

  if to_regclass('public.report_schedules') is not null
     or to_regclass('public.report_runs') is not null then
    raise exception
      'the database is already past v0.1.0: the report tables exist. Reset to version '
      '20260921000300 before running this fixture, or it proves nothing';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is already installed on the v0.1.0 database, which v0.1.0 never did';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260921000300');

commit;

\echo 'migration-chain: the database is the released v0.1.0 shape'
