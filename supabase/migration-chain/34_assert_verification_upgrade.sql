-- Issue #64 · Migration chain, step 34: what the verification migrations added to a populated
-- v0.4.0 database, and proof that they work against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the five objects this release replaces. This file checks the other half: what arrived,
-- exactly how the five changed, and that the Manager verifies the fixture's own settlements, with
-- and without a remainder, all the way to committed postings.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the five replaced ones
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_shape text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 46
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260928000200' then
    raise exception 'expected the 44 released migrations and the two verification ones, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  select string_agg(t, ', ') into v_bad
    from unnest(array['imprest_verifications', 'imprest_postings']) t
   where to_regclass('public.' || t) is null
      or not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass);
  if v_bad is not null then
    raise exception 'missing or without row-level security: %', v_bad;
  end if;

  if (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
       where enumtypid = 'public.imprest_disbursement_status'::regtype)
     is distinct from 'proposed,approved,handed_out,settled,verified,rejected,withdrawn,cancelled' then
    raise exception 'the disbursement statuses are not the released seven plus verified after settled';
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
    raise exception 'the approval shape is not the released one plus verified: %', v_shape;
  end if;

  if pg_get_function_result('api.staff_imprest_spending_position()'::regprocedure)
     is distinct from
     'TABLE(fund_id uuid, posted_funding_tzs bigint, posted_balance_tzs bigint, set_aside_tzs bigint, '
     'free_to_approve_tzs bigint, awaiting_verification_tzs bigint)' then
    raise exception 'the spending position does not add the posted balance beside posted funding';
  end if;

  if pg_get_function_result('private.imprest_spending_figures(uuid)'::regprocedure)
     is distinct from
     'TABLE(posted_funding_tzs bigint, posted_balance_tzs bigint, set_aside_tzs bigint, '
     'free_to_approve_tzs bigint)' then
    raise exception 'the spending figures do not calculate a posted balance';
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.guard_imprest_disbursement_progress()'::regprocedure)
     = 'e1faddc243519f10d3791dfb25bb33de' then
    raise exception 'the progress guard still stops at settled';
  end if;

  -- Application roles read and never write the new tables; the secret key and anon reach nothing.
  select string_agg(g.table_name || ' ' || g.grantee || ' ' || g.privilege_type, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('imprest_verifications', 'imprest_postings')
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or (g.grantee = 'fv_definer_owner' and g.privilege_type not in ('SELECT', 'INSERT'))
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'a role holds more than it should: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_verify_imprest_disbursement', 'staff_imprest_spending_position'))
       or (n.nspname = 'private'
           and p.proname in ('impl_staff_verify_imprest_disbursement',
                             'check_imprest_verification_target',
                             'check_imprest_verification_complete',
                             'guard_imprest_disbursement_progress', 'imprest_spending_figures')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'verification functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Nothing was verified or posted by the migrations themselves.
  if exists (select 1 from public.imprest_verifications)
     or exists (select 1 from public.imprest_postings)
     or exists (select 1 from public.imprest_disbursements where status = 'verified') then
    raise exception 'the migrations verified or posted something on their own';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The same figures, now read through the new position: posted balance equals posted funding
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
  if v is distinct from '95000/95000/49000/46000/37000' then
    raise exception 'the upgraded position should read 95000/95000/49000/46000/37000, found %', v;
  end if;
end
$$;
commit;

-- ---------------------------------------------------------------------------
-- 3. The Manager verifies B (with a remainder) and G (exact), committed
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.expect(api.staff_verify_imprest_disbursement(
  migration_chain.did('h'), 3,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('b')),
  'chain-dsb-h-v'), 'not_settled', 'verifying a handed-out disbursement');
select migration_chain.spend('b.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('b'), 4,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('b')),
  'chain-dsb-b-v'), 'verified');
select migration_chain.spend('g.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('g'), 4,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('g')),
  'chain-dsb-g-v'), 'verified');
-- Committed, so the deferred check that each verification carries its postings really runs.
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select string_agg(kind::text || ':' || amount_tzs || ':' || needs_director_decision, ',' order by kind)
    into v from public.imprest_postings where disbursement_id = migration_chain.did('b');
  if v is distinct from 'expense:17000:false,unexplained_loss:1000:true' then
    raise exception 'B should post a 17000 expense and a 1000 loss, found %', v;
  end if;

  select string_agg(kind::text || ':' || amount_tzs, ',')
    into v from public.imprest_postings where disbursement_id = migration_chain.did('g');
  if v is distinct from 'expense:15000' then
    raise exception 'G should post a 15000 expense and nothing else, found %', v;
  end if;

  -- 95,000 − 17,000 − 1,000 − 15,000 = 62,000 posted; F and H still set aside; free rises by the
  -- 2,000 B returned and nothing else.
  select posted_funding_tzs || '/' || posted_balance_tzs || '/' || set_aside_tzs || '/'
         || free_to_approve_tzs || '/' || awaiting_verification_tzs
    into v from api.staff_imprest_spending_position();
  if v is distinct from '95000/62000/14000/48000/4000' then
    raise exception 'after verifying B and G the position should read 95000/62000/14000/48000/4000, found %', v;
  end if;
end
$$;

-- The rest still work as they did in v0.4.0: F cancels, H settles.
select migration_chain.spend('f.cancelled', api.staff_cancel_imprest_disbursement(
  migration_chain.did('f'), 2, 'Workers not needed', 'chain-dsb-f-c'), 'cancelled');
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('h.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('h'), 3,
  jsonb_build_array(jsonb_build_object('amount_tzs', 4000, 'purpose', 'Levy', 'receipt_id', null,
                                       'no_receipt_reason', 'vendor_did_not_issue',
                                       'no_receipt_note', null)),
  0, null, 'chain-dsb-h-s'), 'settled');
commit;

-- A verified disbursement is final, even to the table's owner.
do $$
begin
  begin
    update public.imprest_disbursements set status = 'settled', version = version + 1
     where id = migration_chain.did('b');
    raise exception 'a verified disbursement went back to settled';
  exception when restrict_violation then
    null;
  end;
  begin
    delete from public.imprest_postings where disbursement_id = migration_chain.did('b');
    raise exception 'a posting was deleted';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the verification migrations upgraded a populated v0.4.0 database and work on it'
