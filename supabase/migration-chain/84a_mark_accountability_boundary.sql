-- Issue #84 · Migration chain, step 84a: the released v0.13.0 database, and nothing after it
--
-- Runs against a database reset to `20261007000100_till_count` — the 56th and last released
-- migration (v0.13.0), which is what hosted Supabase holds today. The phase then builds the v0.12.2
-- phase's ground (steps 11 to 61 and 83b), so the accountability
-- migration meets a database carrying every kind of record production can hold, unexplained losses,
-- a reversed loss, a replacement and confirmed count shortages among them.
--
-- It pins, exactly, the one released function the accountability migration replaces. The
-- preservation query leaves it out of its digests, so its released form is required here and its
-- replacement in step 84b:
--
--   `private.imprest_fund_unresolved(uuid)`   no longer lists a decided loss or shortage
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 56
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261007000100' then
    raise exception
      'the database is not at the v0.13.0 boundary: expected 56 migrations ending at 20261007000100. '
      'Reset to version 20261007000100 before running this fixture';
  end if;

  if to_regclass('public.reconciliations') is null then
    raise exception 'the database is not at the v0.13.0 boundary: the till count is missing';
  end if;

  if to_regclass('public.accountability_decisions') is not null
     or to_regprocedure('api.admin_accountability_queue()') is not null then
    raise exception
      'the database is already past v0.13.0: accountability objects exist. Reset to version '
      '20261007000100 before running this fixture, or it proves nothing';
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_fund_unresolved(uuid)'::regprocedure)
     is distinct from '5a02b4b18d59213d2fce47b51a25f202' then
    raise exception 'the released function the accountability migration replaces is not the v0.13.0 one';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261007000100');

commit;

\echo 'migration-chain: the database is the released v0.13.0 shape'
