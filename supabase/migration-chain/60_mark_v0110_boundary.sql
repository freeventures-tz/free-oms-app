-- Issue #73 · Migration chain, step 60: the released v0.11.0 database, and nothing after it
--
-- Runs against a database reset to `20261004000100_imprest_retirement` — the 53rd and last released
-- migration, which is what hosted Supabase holds today. The phase then builds the v0.10.0 phase's
-- ground (steps 11 to 57) and deliveries (step 61), so the link migration meets a database carrying
-- every kind of record production can hold.
--
-- It pins, exactly, the two released functions the link migration replaces or drops. The
-- preservation query leaves them out of its digests, so their released form is required here and
-- their replacement in step 62:
--
--   `api.staff_enter_stock_receipt` (the six-argument one)          now calls the seven-argument one
--   `private.impl_staff_enter_stock_receipt` (the six-argument one) dropped for a seven-argument body
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 53
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261004000100' then
    raise exception
      'the database is not at the v0.11.0 boundary: expected 53 migrations ending at 20261004000100. '
      'Reset to version 20261004000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_retirements') is null
     or to_regprocedure('api.staff_submit_imprest_retirement(uuid,text,text)') is null then
    raise exception 'the database is not at the v0.11.0 boundary: retirement is missing';
  end if;

  if to_regclass('public.stock_receipt_imprest_links') is not null
     or to_regprocedure('api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,uuid,text)') is not null
     or to_regprocedure('api.staff_imprest_receipt_payment_options()') is not null then
    raise exception
      'the database is already past v0.11.0: link objects exist. Reset to version '
      '20261004000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ','
                        order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)'::regprocedure,
                       'private.impl_staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)'::regprocedure))
     is distinct from
       'api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)=e0b9a9640a1b752fa454d9c1373377c4,'
       'private.impl_staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)=fdb42985bb0471befb6741dfc3c35074' then
    raise exception 'the released functions the link migration replaces are not the v0.11.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261004000100');

commit;

\echo 'migration-chain: the database is the released v0.11.0 shape'
