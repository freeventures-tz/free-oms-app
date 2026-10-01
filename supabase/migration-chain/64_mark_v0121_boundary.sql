-- Issue #82 · Migration chain, step 64: the released v0.12.1 database, and nothing after it
--
-- Runs against a database reset to `20261005000100_imprest_stock_receipt_link` — the 54th and last
-- released migration, which is what hosted Supabase holds today. The phase then builds the v0.11.0
-- phase's ground (steps 11 to 61), so the report migration meets a database carrying every kind of
-- record production can hold, a delivered report among them.
--
-- It pins, exactly, the one released function the report migration replaces. The preservation
-- query leaves it out of its digests, so its released form is required here and its replacement in
-- step 65:
--
--   `private.report_content(date)`   now reads the imprest section from its own function
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 54
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261005000100' then
    raise exception
      'the database is not at the v0.12.1 boundary: expected 54 migrations ending at 20261005000100. '
      'Reset to version 20261005000100 before running this fixture';
  end if;

  if to_regclass('public.stock_receipt_imprest_links') is null then
    raise exception 'the database is not at the v0.12.1 boundary: the stock receipt link is missing';
  end if;

  if to_regprocedure('private.report_imprest_section(date)') is not null then
    raise exception
      'the database is already past v0.12.1: the report imprest section exists. Reset to version '
      '20261005000100 before running this fixture, or it proves nothing';
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.report_content(date)'::regprocedure)
     is distinct from '5e886af7d67824935b7a6b7999455d70' then
    raise exception 'the released function the report migration replaces is not the v0.12.1 one';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261005000100');

commit;

\echo 'migration-chain: the database is the released v0.12.1 shape'
