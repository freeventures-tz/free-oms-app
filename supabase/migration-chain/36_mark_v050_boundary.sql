-- Issue #65 · Migration chain, step 36: the released v0.5.0 database, and nothing after it
--
-- Runs against a database reset to `20260928000200_imprest_verification` — the 46th and last
-- released migration, which is what hosted Supabase holds today. The phase then builds the v0.0.5
-- ground (step 11), imprest funding (step 15), a real report (step 23), disbursements in every
-- part-1 status (step 29), hand-outs and settlements (step 33) and a real verification with an
-- unexplained loss (step 37), so the send-back migrations meet a database carrying every kind of
-- record production can hold.
--
-- It pins, exactly, the ELEVEN released objects the send-back migrations replace. The preservation
-- query leaves them out of its digests, so their released form is required here and their new form
-- in step 38:
--
--   the `imprest_disbursement_status` labels          `sent_back` is added after `settled`
--   `disbursement_approval_shape`                     a sent-back row keeps its approver
--   the storage policy `imprest_evidence_insert`      admits an upload while sent back
--   `private.guard_imprest_disbursement_progress`     settled to sent back to settled
--   `private.imprest_spending_figures`                sent back stays set aside
--   `private.imprest_awaiting_verification_tzs`       sent back stays awaiting, at its latest cycle
--   `private.check_imprest_settlement_target`         a later cycle after a returned one
--   `private.check_imprest_verification_target`       never a returned cycle
--   `private.guard_imprest_evidence_object`           admits an upload while sent back
--   `private.impl_staff_register_imprest_receipt`     files a receipt while sent back
--   `private.impl_staff_settle_imprest_disbursement`  settles the next cycle while sent back
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
declare
  v_shape text;
  v_bad   text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 46
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260928000200' then
    raise exception
      'the database is not at the v0.5.0 boundary: expected 46 migrations ending at 20260928000200. '
      'Reset to version 20260928000200 before running this fixture';
  end if;

  if to_regclass('public.imprest_verifications') is null then
    raise exception 'the database is not at the v0.5.0 boundary: verifications are missing';
  end if;

  if to_regclass('public.imprest_settlement_returns') is not null
     or to_regprocedure('api.staff_send_back_imprest_settlement(uuid,integer,uuid,text,text)') is not null then
    raise exception
      'the database is already past v0.5.0: send-back objects exist. Reset to version '
      '20260928000200 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,handed_out,settled,verified,rejected,withdrawn,cancelled' then
    raise exception 'the released disbursement statuses are not the v0.5.0 ones';
  end if;

  select pg_get_constraintdef(c.oid) into v_shape
    from pg_constraint c
   where c.conrelid = 'public.imprest_disbursements'::regclass
     and c.conname = 'disbursement_approval_shape';
  if v_shape is distinct from
     'CHECK ((((status = ANY (ARRAY[''approved''::imprest_disbursement_status, '
     '''handed_out''::imprest_disbursement_status, ''settled''::imprest_disbursement_status, '
     '''verified''::imprest_disbursement_status, ''cancelled''::imprest_disbursement_status])) = '
     '(approved_by IS NOT NULL)) AND ((approved_by IS NULL) = (approved_at IS NULL))))' then
    raise exception 'the released approval shape is not the v0.5.0 one: %', v_shape;
  end if;

  if (select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies
       where schemaname = 'storage' and policyname = 'imprest_evidence_insert')
     is distinct from '8e9f79b79a544f964e96b3e094319a98' then
    raise exception 'the released receipt upload policy is not the v0.5.0 one';
  end if;

  select string_agg(r.sig, ', ') into v_bad
    from (values
      ('private.guard_imprest_disbursement_progress()', '65484ff458f245495d274dcb80df2126'),
      ('private.imprest_spending_figures(uuid)', '966684d45596644a995e2058634dccb6'),
      ('private.imprest_awaiting_verification_tzs(uuid)', '1970b3eeb9dffea9bde7151a66de093c'),
      ('private.check_imprest_settlement_target()', 'b3550618e24c77523ac54c53c596ad97'),
      ('private.check_imprest_verification_target()', '356e75b79b4073081cb07bff42270cd9'),
      ('private.guard_imprest_evidence_object()', 'c6f74a53310288501a0ee2579445ce63'),
      ('private.impl_staff_register_imprest_receipt(uuid,text,text,bigint,text)',
       'fa82ec3f457551336bd43e07c8933a5c'),
      ('private.impl_staff_settle_imprest_disbursement(uuid,integer,jsonb,bigint,text,text)',
       '6fb8bd8c3f3f5a450dabc4eadd2ccd71')) r(sig, digest)
   where (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
           where p.oid = r.sig::regprocedure) is distinct from r.digest;
  if v_bad is not null then
    raise exception 'released functions are not the v0.5.0 ones: %', v_bad;
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260928000200');

commit;

\echo 'migration-chain: the database is the released v0.5.0 shape'
