-- Issue #83 · Migration chain, step 83a: the released v0.12.2 database, and nothing after it
--
-- Runs against a database reset to `20261006000100_report_imprest_section` — the 55th and last
-- released migration (v0.12.2), which is what hosted Supabase holds once that release applies. The
-- phase then builds the v0.12.1 phase's ground (steps 11 to 61) and a delivery paid from imprest
-- (step 83b), so the till count migration meets a database carrying every kind of record
-- production can hold, payments of every method and a reversal among them.
--
-- The till migration replaces and drops nothing, so no released function is pinned here: the
-- preservation query compares every released object whole.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 55
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261006000100' then
    raise exception
      'the database is not at the v0.12.2 boundary: expected 55 migrations ending at 20261006000100. '
      'Reset to version 20261006000100 before running this fixture';
  end if;

  if to_regclass('public.stock_receipt_imprest_links') is null
     or to_regprocedure('private.report_imprest_section(date)') is null then
    raise exception 'the database is not at the v0.12.2 boundary: the receipt link or report section is missing';
  end if;

  if to_regclass('public.reconciliations') is not null
     or to_regprocedure('api.staff_enter_till_count(date,uuid,jsonb,text,text,text)') is not null then
    raise exception
      'the database is already past v0.12.2: till count objects exist. Reset to version '
      '20261006000100 before running this fixture, or it proves nothing';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261006000100');

commit;

\echo 'migration-chain: the database is the released v0.12.2 shape'
