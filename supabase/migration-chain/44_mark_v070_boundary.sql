-- Issue #69 · Migration chain, step 44: the released v0.7.0 database, and nothing after it
--
-- Runs against a database reset to `20260930000100_imprest_daily_count` — the 49th and last released
-- migration, which is what hosted Supabase holds today. The phase then builds the v0.6.0 phase's
-- ground (steps 11 to 41) and a day's counts, counted two days ago (step 45), so the Not counted
-- migration meets a database carrying every kind of record production can hold.
--
-- It pins, exactly, the FOUR released objects the Not counted migration replaces. The preservation
-- query leaves them out of its digests, so their released form is required here and their
-- replacement in step 46:
--
--   `private.check_imprest_count_entry`                 a count may be late, for a past day
--   `private.impl_staff_enter_imprest_count`, 5 args    dropped for the form with a late reason
--   `api.staff_enter_imprest_count`, 5 args             now enters today's count through that form
--   `api.staff_imprest_counts`                          returns the late reason; entry order
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 49
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260930000100' then
    raise exception
      'the database is not at the v0.7.0 boundary: expected 49 migrations ending at 20260930000100. '
      'Reset to version 20260930000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_counts') is null then
    raise exception 'the database is not at the v0.7.0 boundary: the daily count is missing';
  end if;

  if to_regprocedure('private.imprest_count_days(uuid)') is not null
     or to_regprocedure('api.staff_imprest_open_count_days(integer,integer)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'imprest_counts'
                   and column_name = 'late_reason') then
    raise exception
      'the database is already past v0.7.0: Not counted objects exist. Reset to version '
      '20260930000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ','
                        order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('private.check_imprest_count_entry()'::regprocedure,
                       'private.impl_staff_enter_imprest_count(date,uuid,bigint,text,text)'::regprocedure,
                       'api.staff_enter_imprest_count(date,uuid,bigint,text,text)'::regprocedure,
                       'api.staff_imprest_counts(integer,integer)'::regprocedure))
     is distinct from
       'api.staff_enter_imprest_count(date,uuid,bigint,text,text)=11278055e61c80c14c32ed73d8268023,'
       'api.staff_imprest_counts(integer,integer)=f24777f04eb4197ec01888efba1628ba,'
       'private.check_imprest_count_entry()=700070aaa1d72331dac9c3e1c803d200,'
       'private.impl_staff_enter_imprest_count(date,uuid,bigint,text,text)=360404a8ba4c746f277d3108026630ed' then
    raise exception 'the released count functions are not the v0.7.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260930000100');

commit;

\echo 'migration-chain: the database is the released v0.7.0 shape'
