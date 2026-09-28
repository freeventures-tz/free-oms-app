-- Issue #65 · Migration chain, step 38: what the send-back migrations added to a populated v0.5.0
-- database, and proof that they work against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the eleven objects this release replaces. This file checks the other half: what arrived,
-- exactly how the eleven changed, and that the fixture's own waiting settlement is sent back, gets
-- a new receipt uploaded while sent back, is settled again and verified at its second cycle, all
-- committed.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the eleven replaced ones
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_shape text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 48
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260929000200' then
    raise exception 'expected the 46 released migrations and the two send-back ones, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  if to_regclass('public.imprest_settlement_returns') is null
     or not (select relrowsecurity from pg_class
              where oid = 'public.imprest_settlement_returns'::regclass) then
    raise exception 'the returns table is missing or without row-level security';
  end if;

  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,handed_out,settled,sent_back,verified,rejected,withdrawn,cancelled' then
    raise exception 'the disbursement statuses are not the released eight plus sent_back after settled';
  end if;

  select pg_get_constraintdef(c.oid) into v_shape
    from pg_constraint c
   where c.conrelid = 'public.imprest_disbursements'::regclass
     and c.conname = 'disbursement_approval_shape';
  if v_shape is distinct from
     'CHECK ((((status = ANY (ARRAY[''approved''::imprest_disbursement_status, '
     '''handed_out''::imprest_disbursement_status, ''settled''::imprest_disbursement_status, '
     '''sent_back''::imprest_disbursement_status, ''verified''::imprest_disbursement_status, '
     '''cancelled''::imprest_disbursement_status])) = (approved_by IS NOT NULL)) AND '
     '((approved_by IS NULL) = (approved_at IS NULL))))' then
    raise exception 'the approval shape is not the released one plus sent_back: %', v_shape;
  end if;

  if (select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies
       where schemaname = 'storage' and policyname = 'imprest_evidence_insert')
     = '8e9f79b79a544f964e96b3e094319a98'
     or (select with_check from pg_policies
          where schemaname = 'storage' and policyname = 'imprest_evidence_insert')
        not like '%sent_back%' then
    raise exception 'the receipt upload policy does not admit a sent-back disbursement';
  end if;

  -- Every replaced function is replaced: none keeps its released body.
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
           where p.oid = r.sig::regprocedure) = r.digest;
  if v_bad is not null then
    raise exception 'released functions were not replaced: %', v_bad;
  end if;

  -- Application roles read and never write the new table; the secret key and anon reach nothing.
  select string_agg(g.grantee || ' ' || g.privilege_type, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name = 'imprest_settlement_returns'
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or (g.grantee = 'fv_definer_owner' and g.privilege_type not in ('SELECT', 'INSERT'))
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'a role holds more than it should on the returns: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api' and p.proname = 'staff_send_back_imprest_settlement')
       or (n.nspname = 'private'
           and p.proname in ('impl_staff_send_back_imprest_settlement', 'check_imprest_settlement_return',
                             'check_imprest_settlement_target', 'guard_imprest_disbursement_progress',
                             'check_imprest_verification_target', 'guard_imprest_evidence_object',
                             'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                             'impl_staff_register_imprest_receipt',
                             'impl_staff_settle_imprest_disbursement')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'send-back functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Nothing was sent back by the migrations themselves.
  if exists (select 1 from public.imprest_settlement_returns)
     or exists (select 1 from public.imprest_disbursements where status = 'sent_back') then
    raise exception 'the migrations sent something back on their own';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The same figures, read through the replaced functions
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select posted_funding_tzs || '/' || posted_balance_tzs || '/' || set_aside_tzs || '/'
         || free_to_approve_tzs || '/' || awaiting_verification_tzs
    into v from api.staff_imprest_spending_position();
  if v is distinct from '95000/77000/29000/48000/19000' then
    raise exception 'the upgraded position should read 95000/77000/29000/48000/19000, found %', v;
  end if;
end
$$;
commit;

-- ---------------------------------------------------------------------------
-- 3. The Manager sends G back, committed
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.expect(api.staff_send_back_imprest_settlement(
  migration_chain.did('b'), 5,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('b')),
  'Too late', 'chain-dsb-b-back'), 'not_settled', 'sending back a verified disbursement');
select migration_chain.spend('g.sent_back', api.staff_send_back_imprest_settlement(
  migration_chain.did('g'), 4,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('g')),
  'Which fuel station? Please add the receipt', 'chain-dsb-g-back'), 'sent_back');
-- Committed, so the deferred check that the return leaves G sent back really runs.
commit;

do $$
declare
  v text;
begin
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '77000/29000/48000/19000' then
    raise exception 'sending G back should move no figure, found %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The Cashier files and uploads a receipt while G is sent back, and settles again
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('g.receipt', api.staff_register_imprest_receipt(
  migration_chain.did('g'), 'station.jpg', 'image/jpeg', 350000, 'chain-dsb-g-r'), 'registered');

-- The file lands under the Cashier's own role and owner, as the Storage API writes it.
select set_config('migration_chain.receipt_path',
                  (select res -> 'receipt' ->> 'object_path' from migration_chain.disbursements
                    where name = 'g.receipt'), true);
set local role authenticated;
insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
values ('imprest-evidence', current_setting('migration_chain.receipt_path'),
        'c0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
        '{"size": 350028}');
reset role;

select migration_chain.spend('g.settled_again', api.staff_settle_imprest_disbursement(
  migration_chain.did('g'), 5,
  jsonb_build_array(
    jsonb_build_object('amount_tzs', 14000, 'purpose', 'Petrol, Puma Mbezi', 'no_receipt_reason', null,
                       'no_receipt_note', null,
                       'receipt_id', (select res -> 'receipt' ->> 'id' from migration_chain.disbursements
                                       where name = 'g.receipt'))),
  1000, null, 'chain-dsb-g-s2'), 'settled');
commit;

-- ---------------------------------------------------------------------------
-- 5. The Manager verifies G's second cycle, never its first, committed
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.expect(api.staff_verify_imprest_disbursement(
  migration_chain.did('g'), 6,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('g') and cycle = 1),
  'chain-dsb-g-v1'), 'settlement_not_latest', 'verifying G''s returned first cycle');
select migration_chain.spend('g.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('g'), 6,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('g') and cycle = 2),
  'chain-dsb-g-v2'), 'verified');

-- H still settles as it did in v0.5.0.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('h.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('h'), 3,
  jsonb_build_array(jsonb_build_object('amount_tzs', 4000, 'purpose', 'Levy', 'receipt_id', null,
                                       'no_receipt_reason', 'vendor_did_not_issue',
                                       'no_receipt_note', null)),
  0, null, 'chain-dsb-h-s'), 'settled');
commit;

do $$
declare
  v text;
begin
  if (select string_agg(cycle::text || ':' || used_tzs || '/' || returned_tzs, ',' order by cycle)
        from public.imprest_settlements where disbursement_id = migration_chain.did('g'))
     is distinct from '1:15000/0,2:14000/1000' then
    raise exception 'G should carry both cycles, the first unchanged';
  end if;

  select string_agg(kind::text || ':' || amount_tzs, ',')
    into v from public.imprest_postings where disbursement_id = migration_chain.did('g');
  if v is distinct from 'expense:14000' then
    raise exception 'G should post its second cycle''s 14000 expense and nothing else, found %', v;
  end if;

  -- 77,000 − 14,000 = 63,000 posted; F and H still set aside; G's 1,000 came back.
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '63000/14000/49000/4000' then
    raise exception 'after G''s second cycle is verified the figures should read 63000/14000/49000/4000, found %', v;
  end if;
end
$$;

-- A return is never changed, even by the table's owner.
do $$
begin
  begin
    update public.imprest_settlement_returns set reason = 'Rewritten';
    raise exception 'a return was rewritten';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the send-back migrations upgraded a populated v0.5.0 database and work on it'
