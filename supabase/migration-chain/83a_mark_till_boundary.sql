-- Issue #83 · Migration chain, step 83a: the released v0.12.1 database, and nothing after it
--
-- Runs against a database reset to `20261005000100_imprest_stock_receipt_link` — the 54th and last
-- released migration (v0.12.0; v0.12.1 added none), which is what hosted Supabase holds today. The
-- phase then builds the v0.11.0 phase's ground (steps 11 to 61) and a delivery paid from imprest
-- (step 83b), so the till count migration meets a database carrying every kind of record
-- production can hold, payments of every method and a reversal among them.
--
-- The till migration replaces and drops nothing, so no released function is pinned here: the
-- preservation query compares every released object whole.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 54
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261005000100' then
    raise exception
      'the database is not at the v0.12.1 boundary: expected 54 migrations ending at 20261005000100. '
      'Reset to version 20261005000100 before running this fixture';
  end if;

  if to_regclass('public.stock_receipt_imprest_links') is null
     or to_regprocedure('api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,uuid,text)') is null then
    raise exception 'the database is not at the v0.12.1 boundary: the receipt link is missing';
  end if;

  if to_regclass('public.reconciliations') is not null
     or to_regprocedure('api.staff_enter_till_count(date,uuid,jsonb,text,text,text)') is not null then
    raise exception
      'the database is already past v0.12.1: till count objects exist. Reset to version '
      '20261005000100 before running this fixture, or it proves nothing';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261005000100');

commit;

\echo 'migration-chain: the database is the released v0.12.1 shape'
