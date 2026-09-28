-- Issue #68 · Migration chain, step 40: the released v0.6.0 database, and nothing after it
--
-- Runs against a database reset to `20260929000200_imprest_send_back` — the 48th and last released
-- migration, which is what hosted Supabase holds today. The phase then builds the v0.0.5 ground
-- (step 11), imprest funding (step 15), a real report (step 23), disbursements in every part-1
-- status (step 29), hand-outs and settlements (step 33), a verification with an unexplained loss
-- (step 37) and a settlement sent back to the Cashier (step 41), so the daily count migration meets
-- a database carrying every kind of record production can hold.
--
-- It pins, exactly, the ONE released object the count migration replaces. The preservation query
-- leaves it out of its digests, so its released form is required here and its new form in step 42:
--
--   `private.imprest_spending_figures`   the posted balance counts confirmed count postings
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 48
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260929000200' then
    raise exception
      'the database is not at the v0.6.0 boundary: expected 48 migrations ending at 20260929000200. '
      'Reset to version 20260929000200 before running this fixture';
  end if;

  if to_regclass('public.imprest_settlement_returns') is null then
    raise exception 'the database is not at the v0.6.0 boundary: send-back returns are missing';
  end if;

  if to_regclass('public.imprest_counts') is not null
     or to_regprocedure('api.staff_enter_imprest_count(date,uuid,bigint,text,text)') is not null then
    raise exception
      'the database is already past v0.6.0: daily count objects exist. Reset to version '
      '20260929000200 before running this fixture, or it proves nothing';
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_spending_figures(uuid)'::regprocedure)
     is distinct from '4df056dbd8ecc751a61140393b81c672' then
    raise exception 'the released spending figures are not the v0.6.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260929000200');

commit;

\echo 'migration-chain: the database is the released v0.6.0 shape'
