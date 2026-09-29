-- Issue #70 · Migration chain, step 48: the released v0.8.0 database, and nothing after it
--
-- Runs against a database reset to `20261001000100_imprest_not_counted` — the 50th and last released
-- migration, which is what hosted Supabase holds today. The phase then builds the v0.7.0 phase's
-- ground (steps 11 to 45) and a missed day counted late (step 49), so the raised approval migration
-- meets a database carrying every kind of record production can hold.
--
-- It pins, exactly, the FOUR released objects the raised approval migration replaces. The
-- preservation query leaves them out of its digests, so their released form is required here and
-- their replacement in step 50:
--
--   `private.check_imprest_settlement_target`            a settlement is held to the raised amount
--   `private.imprest_spending_figures`                   a raise is set aside once it is raised
--   `private.imprest_awaiting_verification_tzs`          an extra counts once it is handed out
--   `private.impl_staff_settle_imprest_disbursement`     settles against the raised amount
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 50
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261001000100' then
    raise exception
      'the database is not at the v0.8.0 boundary: expected 50 migrations ending at 20261001000100. '
      'Reset to version 20261001000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_counts') is null
     or to_regprocedure('private.imprest_count_days(uuid)') is null then
    raise exception 'the database is not at the v0.8.0 boundary: Not counted is missing';
  end if;

  if to_regclass('public.imprest_approval_raises') is not null
     or to_regprocedure('private.imprest_approved_tzs(uuid)') is not null
     or to_regprocedure('api.staff_request_imprest_raise(uuid,integer,bigint,text,text)') is not null then
    raise exception
      'the database is already past v0.8.0: raised approval objects exist. Reset to version '
      '20261001000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ','
                        order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('private.check_imprest_settlement_target()'::regprocedure,
                       'private.imprest_spending_figures(uuid)'::regprocedure,
                       'private.imprest_awaiting_verification_tzs(uuid)'::regprocedure,
                       'private.impl_staff_settle_imprest_disbursement(uuid,integer,jsonb,bigint,text,text)'::regprocedure))
     is distinct from
       'private.check_imprest_settlement_target()=b0cbea711f6fc4516d524e51e11d75a0,'
       'private.impl_staff_settle_imprest_disbursement(uuid,integer,jsonb,bigint,text,text)=6df7024a46035b222d2bc910528c7dba,'
       'private.imprest_awaiting_verification_tzs(uuid)=cda5d99e5165c660f11c8d22fe4226a5,'
       'private.imprest_spending_figures(uuid)=aa04f6dd14e272904690b200b3bc0ae1' then
    raise exception 'the released disbursement functions are not the v0.8.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261001000100');

commit;

\echo 'migration-chain: the database is the released v0.8.0 shape'
