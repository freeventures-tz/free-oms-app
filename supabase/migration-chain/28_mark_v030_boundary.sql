-- Issue #62 · Migration chain, step 28: the released v0.3.3 database, and nothing after it
--
-- Runs against a database reset to `20260925000100_imprest_disbursements` — the 42nd and last
-- released migration. v0.3.0 to v0.3.3 carry it and no other, so this is what hosted Supabase
-- holds today. The phase then builds the v0.0.5 ground (step 11), imprest funding (step 15), a real
-- report (step 23) and disbursements in every released status (step 29), so the settlement
-- migrations meet a database carrying every kind of record production can hold.
--
-- It pins, exactly, the FOUR released objects the settlement migrations replace. The preservation
-- query leaves them out of its digests, so their released form is required here and their new
-- form in step 30:
--
--   the `imprest_disbursement_status` labels     two are added after `approved`
--   `disbursement_approval_shape`                handed out and settled keep their approver
--   `private.imprest_spending_figures`           handed out and settled stay set aside
--   `api.staff_imprest_spending_position`        a fourth column, Awaiting verification
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
declare
  v_shape text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 42
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260925000100' then
    raise exception
      'the database is not at the v0.3.3 boundary: expected 42 migrations ending at 20260925000100. '
      'Reset to version 20260925000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_disbursements') is null then
    raise exception 'the database is not at the v0.3.3 boundary: disbursements are missing';
  end if;

  if to_regclass('public.imprest_settlements') is not null
     or to_regclass('public.imprest_disbursement_handouts') is not null
     or to_regtype('public.imprest_no_receipt_reason') is not null
     or exists (select 1 from storage.buckets where id = 'imprest-evidence') then
    raise exception
      'the database is already past v0.3.3: settlement objects exist. Reset to version '
      '20260925000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,rejected,withdrawn,cancelled' then
    raise exception 'the released disbursement statuses are not the v0.3.3 ones';
  end if;

  select pg_get_constraintdef(c.oid) into v_shape
    from pg_constraint c
   where c.conrelid = 'public.imprest_disbursements'::regclass
     and c.conname = 'disbursement_approval_shape';
  if v_shape is distinct from
     'CHECK ((((status = ANY (ARRAY[''approved''::imprest_disbursement_status, '
     '''cancelled''::imprest_disbursement_status])) = (approved_by IS NOT NULL)) AND '
     '((approved_by IS NULL) = (approved_at IS NULL))))' then
    raise exception 'the released approval shape is not the v0.3.3 one: %', v_shape;
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_spending_figures(uuid)'::regprocedure)
     is distinct from '9274015de14c8e36a8aff26993b1528c'
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
          where p.oid = 'api.staff_imprest_spending_position()'::regprocedure)
     is distinct from 'fb527f9d7e9e5ccacabdb263be8332fb'
     or pg_get_function_result('api.staff_imprest_spending_position()'::regprocedure)
        is distinct from
        'TABLE(fund_id uuid, posted_funding_tzs bigint, set_aside_tzs bigint, free_to_approve_tzs bigint)'
  then
    raise exception 'the released spending figures are not the v0.3.3 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260925000100');

commit;

\echo 'migration-chain: the database is the released v0.3.3 shape'
