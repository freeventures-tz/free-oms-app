-- Issue #64 · Migration chain, step 32: the released v0.4.0 database, and nothing after it
--
-- Runs against a database reset to `20260927000200_imprest_settlement` — the 44th and last
-- released migration, which is what hosted Supabase holds today. The phase then builds the v0.0.5
-- ground (step 11), imprest funding (step 15), a real report (step 23), disbursements in every
-- part-1 status (step 29) and hand-outs and settlements with and without a remainder (step 33), so
-- the verification migrations meet a database carrying every kind of record production can hold.
--
-- It pins, exactly, the FIVE released objects the verification migrations replace. The preservation
-- query leaves them out of its digests, so their released form is required here and their new form
-- in step 34:
--
--   the `imprest_disbursement_status` labels         `verified` is added after `settled`
--   `disbursement_approval_shape`                    a verified row keeps its approver
--   `private.guard_imprest_disbursement_progress`    settled may go to verified, and no further
--   `private.imprest_spending_figures`               a posted balance, net of verified postings
--   `api.staff_imprest_spending_position`            a posted balance column
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
declare
  v_shape text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 44
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260927000200' then
    raise exception
      'the database is not at the v0.4.0 boundary: expected 44 migrations ending at 20260927000200. '
      'Reset to version 20260927000200 before running this fixture';
  end if;

  if to_regclass('public.imprest_settlements') is null then
    raise exception 'the database is not at the v0.4.0 boundary: settlements are missing';
  end if;

  if to_regclass('public.imprest_verifications') is not null
     or to_regclass('public.imprest_postings') is not null
     or to_regtype('public.imprest_posting_kind') is not null then
    raise exception
      'the database is already past v0.4.0: verification objects exist. Reset to version '
      '20260927000200 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,handed_out,settled,rejected,withdrawn,cancelled' then
    raise exception 'the released disbursement statuses are not the v0.4.0 ones';
  end if;

  select pg_get_constraintdef(c.oid) into v_shape
    from pg_constraint c
   where c.conrelid = 'public.imprest_disbursements'::regclass
     and c.conname = 'disbursement_approval_shape';
  if v_shape is distinct from
     'CHECK ((((status = ANY (ARRAY[''approved''::imprest_disbursement_status, '
     '''handed_out''::imprest_disbursement_status, ''settled''::imprest_disbursement_status, '
     '''cancelled''::imprest_disbursement_status])) = (approved_by IS NOT NULL)) AND '
     '((approved_by IS NULL) = (approved_at IS NULL))))' then
    raise exception 'the released approval shape is not the v0.4.0 one: %', v_shape;
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_spending_figures(uuid)'::regprocedure)
     is distinct from 'feeb945390659587c4a7c4c05d2e5d83'
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
          where p.oid = 'private.guard_imprest_disbursement_progress()'::regprocedure)
     is distinct from 'e1faddc243519f10d3791dfb25bb33de'
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
          where p.oid = 'api.staff_imprest_spending_position()'::regprocedure)
     is distinct from '330753b153d6de31e3509217067d4662'
     or pg_get_function_result('api.staff_imprest_spending_position()'::regprocedure)
        is distinct from
        'TABLE(fund_id uuid, posted_funding_tzs bigint, set_aside_tzs bigint, free_to_approve_tzs bigint, '
        'awaiting_verification_tzs bigint)'
  then
    raise exception 'the released spending figures or progress guard are not the v0.4.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260927000200');

commit;

\echo 'migration-chain: the database is the released v0.4.0 shape'
