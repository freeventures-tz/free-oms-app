-- Issue #72 · Migration chain, step 56: the released v0.10.0 database, and nothing after it
--
-- Runs against a database reset to `20261003000100_imprest_reversal` — the 52nd and last released
-- migration, which is what hosted Supabase holds today. The phase then builds the v0.9.0 phase's
-- ground (steps 11 to 53) and reversals (step 57), so the retirement migration meets a database
-- carrying every kind of record production can hold.
--
-- It pins, exactly, the five released functions the retirement migration replaces. The preservation
-- query leaves them out of its digests, so their released form is required here and their
-- replacement in step 58:
--
--   `private.imprest_spending_figures`                     an opening balance is part of the balance
--   `private.imprest_first_count_day`                      a carried fund starts after the closing count
--   `private.imprest_count_days`                           a retired fund's days end where the next begin
--   `api.staff_propose_imprest_disbursement`               waits for a retirement being approved
--   `api.staff_enter_imprest_count` (the six-argument one) waits for a retirement being approved
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 52
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261003000100' then
    raise exception
      'the database is not at the v0.10.0 boundary: expected 52 migrations ending at 20261003000100. '
      'Reset to version 20261003000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_posting_reversals') is null
     or to_regprocedure('api.admin_decide_imprest_reversal(uuid,integer,boolean,text,text)') is null then
    raise exception 'the database is not at the v0.10.0 boundary: reversals are missing';
  end if;

  if to_regclass('public.imprest_retirements') is not null
     or to_regclass('public.imprest_fund_openings') is not null
     or to_regtype('public.imprest_retirement_status') is not null
     or to_regprocedure('api.staff_submit_imprest_retirement(uuid,text,text)') is not null then
    raise exception
      'the database is already past v0.10.0: retirement objects exist. Reset to version '
      '20261003000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ','
                        order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('private.imprest_spending_figures(uuid)'::regprocedure,
                       'private.imprest_first_count_day(uuid)'::regprocedure,
                       'private.imprest_count_days(uuid)'::regprocedure,
                       'api.staff_propose_imprest_disbursement(bigint,text,text,text)'::regprocedure,
                       'api.staff_enter_imprest_count(date,uuid,bigint,text,text,text)'::regprocedure))
     is distinct from
       'api.staff_enter_imprest_count(date,uuid,bigint,text,text,text)=aa1438bbd4f9e93b9e5c20e78a3d2956,'
       'api.staff_propose_imprest_disbursement(bigint,text,text,text)=148c3c9134e364ce1ac7f8489f3dd605,'
       'private.imprest_count_days(uuid)=3d08e8a1415d73a7608deeb8b1062ea0,'
       'private.imprest_first_count_day(uuid)=0f0eba99cdb6d6493724c6136c02033c,'
       'private.imprest_spending_figures(uuid)=c4d9235463686615794c3a8d76ad17ff' then
    raise exception 'the released functions the retirement migration replaces are not the v0.10.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261003000100');

commit;

\echo 'migration-chain: the database is the released v0.10.0 shape'
