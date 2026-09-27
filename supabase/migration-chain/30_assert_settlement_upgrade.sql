-- Issue #62 · Migration chain, step 30: what the settlement migrations added to a populated v0.3.3
-- database, and proof that they work against one
--
-- The preservation query has already required every released row, report, Cron job, grant, policy,
-- constraint, trigger, function body, enum, column, view and index to be identical, apart from the
-- four objects this release replaces. This file checks the other half: what arrived, exactly how
-- the four changed, and that the new commands run against the fixture's own disbursements, all
-- the way to a committed settlement.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the four replaced ones
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_shape text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 44
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260927000200' then
    raise exception 'expected the 42 released migrations and the two settlement ones, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  select string_agg(t, ', ') into v_bad
    from unnest(array['imprest_disbursement_handouts', 'imprest_receipts', 'imprest_settlements',
                      'imprest_settlement_lines']) t
   where to_regclass('public.' || t) is null
      or not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass);
  if v_bad is not null then
    raise exception 'missing or without row-level security: %', v_bad;
  end if;

  if not exists (select 1 from storage.buckets
                  where id = 'imprest-evidence' and not public and file_size_limit = 15728668
                    and allowed_mime_types = array['application/octet-stream']) then
    raise exception 'the private imprest-evidence bucket was not created as it should be';
  end if;

  -- The four replaced objects, exactly. Step 28 pinned their released form.
  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,handed_out,settled,rejected,withdrawn,cancelled' then
    raise exception 'the disbursement statuses are not the released five plus handed_out and settled';
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
    raise exception 'the approval shape is not the released one plus handed_out and settled: %', v_shape;
  end if;

  if pg_get_function_result('api.staff_imprest_spending_position()'::regprocedure)
     is distinct from
     'TABLE(fund_id uuid, posted_funding_tzs bigint, set_aside_tzs bigint, free_to_approve_tzs bigint, '
     'awaiting_verification_tzs bigint)' then
    raise exception 'the spending position does not add Awaiting verification as its fifth column';
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_spending_figures(uuid)'::regprocedure)
     = '9274015de14c8e36a8aff26993b1528c' then
    raise exception 'imprest_spending_figures still sets aside approved rows alone';
  end if;

  -- Application roles read and never write the new tables; the secret key and anon reach nothing.
  select string_agg(g.table_name || ' ' || g.grantee || ' ' || g.privilege_type, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('imprest_disbursement_handouts', 'imprest_receipts',
                          'imprest_settlements', 'imprest_settlement_lines')
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'an application role holds more than it should: %', v_bad;
  end if;
  if has_column_privilege('authenticated', 'public.imprest_receipts', 'encryption_key', 'select') then
    raise exception 'a signed-in client can read receipt keys';
  end if;

  -- Every new function belongs to the definer owner; only the four new commands and the replaced
  -- position are callable, and only by `authenticated`.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_hand_out_imprest_disbursement', 'staff_register_imprest_receipt',
                             'staff_open_imprest_receipt', 'staff_settle_imprest_disbursement',
                             'staff_imprest_spending_position'))
       or (n.nspname = 'private'
           and p.proname in ('impl_staff_hand_out_imprest_disbursement',
                             'impl_staff_register_imprest_receipt',
                             'impl_staff_settle_imprest_disbursement',
                             'refuse_imprest_settlement_edit', 'check_imprest_settlement_totals',
                             'check_imprest_settlement_target', 'guard_imprest_disbursement_progress',
                             'imprest_disbursement_visible', 'guard_imprest_evidence_object',
                             'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                             'imprest_own_disbursement_open', 'imprest_receipt_json')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'settlement functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Nothing was handed out, settled or moved by the migrations themselves.
  if exists (select 1 from public.imprest_disbursement_handouts)
     or exists (select 1 from public.imprest_settlements)
     or exists (select 1 from public.imprest_disbursements where status in ('handed_out', 'settled')) then
    raise exception 'the migrations handed out or settled something on their own';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The same figures, now read through the new position
-- ---------------------------------------------------------------------------
-- The acting session is a transaction-local setting, so every command below runs inside one.
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select posted_funding_tzs || '/' || set_aside_tzs || '/' || free_to_approve_tzs || '/'
         || awaiting_verification_tzs
    into v from api.staff_imprest_spending_position();
  if v is distinct from '95000/30000/65000/0' then
    raise exception 'the upgraded position should read 95000/30000/65000/0, found %', v;
  end if;
end
$$;
commit;

-- ---------------------------------------------------------------------------
-- 3. The fixture's approved trip allowance B, handed out and settled for real
-- ---------------------------------------------------------------------------
begin;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('b.handed_out', api.staff_hand_out_imprest_disbursement(
  migration_chain.did('b'), 2, 'Chain driver', 'chain-dsb-b-h'), 'handed_out');
select migration_chain.spend('b.receipt', api.staff_register_imprest_receipt(
  migration_chain.did('b'), 'fuel.jpg', 'image/jpeg', 2500000, 'chain-dsb-b-r'), 'registered');

-- The file lands under the Cashier's own role and owner, as the Storage API writes it. The path is
-- carried in a setting, because the Cashier's role cannot read this harness's schema.
select set_config('migration_chain.receipt_path',
                  (select res -> 'receipt' ->> 'object_path' from migration_chain.disbursements
                    where name = 'b.receipt'), true);
set local role authenticated;
insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
values ('imprest-evidence', current_setting('migration_chain.receipt_path'),
        'c0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
        '{"size": 2500028}');
reset role;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.expect(api.staff_cancel_imprest_disbursement(
  migration_chain.did('b'), 3, 'Trip called off', 'chain-dsb-b-cancel'), 'not_approved',
  'cancelling a handed-out disbursement');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('b.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('b'), 3,
  jsonb_build_array(
    jsonb_build_object('amount_tzs', 15000, 'purpose', 'Diesel', 'no_receipt_reason', null,
                       'no_receipt_note', null,
                       'receipt_id', (select res -> 'receipt' ->> 'id' from migration_chain.disbursements
                                       where name = 'b.receipt')),
    jsonb_build_object('amount_tzs', 2000, 'purpose', 'Parking', 'receipt_id', null,
                       'no_receipt_reason', 'transport_fare', 'no_receipt_note', null)),
  2000, 'Driver says he lost a thousand', 'chain-dsb-b-s'), 'settled');

-- Committed, so the deferred check that a settlement's totals match its lines really runs.
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select used_tzs || '/' || returned_tzs || '/' || unaccounted_tzs || '/' || no_receipt_lines
    into v from public.imprest_settlements where disbursement_id = migration_chain.did('b');
  if v is distinct from '17000/2000/1000/1' then
    raise exception 'the settlement of B should read 17000/2000/1000/1, found %', v;
  end if;

  -- Still set aside until the Manager verifies (part 2b); only what came back left Awaiting.
  select posted_funding_tzs || '/' || set_aside_tzs || '/' || free_to_approve_tzs || '/'
         || awaiting_verification_tzs
    into v from api.staff_imprest_spending_position();
  if v is distinct from '95000/30000/65000/18000' then
    raise exception 'after settling B the position should read 95000/30000/65000/18000, found %', v;
  end if;
end
$$;

-- The fixture's other approval, F, still cancels exactly as it did in v0.3.3.
select migration_chain.spend('f.cancelled', api.staff_cancel_imprest_disbursement(
  migration_chain.did('f'), 2, 'Workers not needed', 'chain-dsb-f-c'), 'cancelled');
commit;

\echo 'migration-chain: the settlement migrations upgraded a populated v0.3.3 database and work on it'
