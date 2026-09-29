-- Issue #70 · Migration chain, step 50: what the raised approval migration added to a populated
-- v0.8.0 database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the four disbursement functions this release replaces and the table and enum it adds. This
-- file checks the other half: what arrived, that nothing already recorded changed its figures, and
-- that a payment handed out before the upgrade and one sent back before it are each asked for more,
-- raised, handed out, settled against the raised amount and verified, committed.
--
--   H  handed out 4,000 before the upgrade           -> raised by 2,000, settled at 6,000
--   G  sent back at cycle 1 (15,000) before it       -> raised by 1,000, settled again at 16,000

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the replaced functions
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 51
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261002000100' then
    raise exception 'expected the 50 released migrations and the raised approval one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The four released functions were replaced: none still has its v0.8.0 body.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where md5(replace(p.prosrc, E'\r', '')) in ('b0cbea711f6fc4516d524e51e11d75a0',
                                                '6df7024a46035b222d2bc910528c7dba',
                                                'cda5d99e5165c660f11c8d22fe4226a5',
                                                'aa04f6dd14e272904690b200b3bc0ae1');
  if v_bad is not null then
    raise exception 'released disbursement functions were not replaced: %', v_bad;
  end if;

  -- Nothing already recorded was given a raise, and the table holds none yet.
  if (select count(*) from public.imprest_approval_raises) <> 0 then
    raise exception 'the migration wrote a raise into a database that had none';
  end if;

  -- The table is written by the commands alone, and read by the readers of the disbursement.
  if has_table_privilege('authenticated', 'public.imprest_approval_raises', 'insert')
     or has_table_privilege('authenticated', 'public.imprest_approval_raises', 'update')
     or has_table_privilege('authenticated', 'public.imprest_approval_raises', 'delete')
     or not has_table_privilege('authenticated', 'public.imprest_approval_raises', 'select')
     or has_table_privilege('service_role', 'public.imprest_approval_raises', 'select')
     or has_table_privilege('anon', 'public.imprest_approval_raises', 'select') then
    raise exception 'the raises table has the wrong grants';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.imprest_approval_raises'::regclass) then
    raise exception 'the raises table has no row-level security';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_request_imprest_raise', 'staff_decide_imprest_raise',
                             'staff_hand_out_imprest_raise'))
       or (n.nspname = 'private'
           and p.proname in ('guard_imprest_approval_raise', 'check_imprest_approval_raise_target',
                             'imprest_approved_tzs', 'check_imprest_settlement_target',
                             'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                             'impl_staff_settle_imprest_disbursement', 'imprest_raise_result',
                             'imprest_raise_open', 'impl_staff_request_imprest_raise',
                             'impl_staff_decide_imprest_raise', 'impl_staff_hand_out_imprest_raise')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'raised approval functions with the wrong owner or grants: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Every disbursement already recorded reads its original amount, and the figures are unchanged
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  if exists (select 1 from public.imprest_disbursements d
              where private.imprest_approved_tzs(d.id) is distinct from d.amount_tzs
                 or public.imprest_disbursement_approved_tzs(d) is distinct from d.amount_tzs) then
    raise exception 'a disbursement recorded before the upgrade reads an approved amount that is not its own';
  end if;

  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/76000/29000/47000/19000' then
    raise exception 'the upgrade moved the figures: expected 95000/76000/29000/47000/19000, found %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. H, handed out before the upgrade: asked for 2,000 more, raised, handed out, settled at 6,000
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('h.ask', api.staff_request_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  2000, 'The levy rose after the notice went up', 'chain-raise-h-ask'), 'requested');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('h.raise', api.staff_decide_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'h.ask'),
  true, null, 'chain-raise-h-raise'), 'raised');
commit;

do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/76000/31000/45000/19000' then
    raise exception 'a raise should set 2,000 aside and leave 95000/76000/31000/45000/19000, found %', v;
  end if;
  if private.imprest_approved_tzs(migration_chain.did('h')) <> 6000 then
    raise exception 'H should be approved for 6,000 after the raise';
  end if;
end
$$;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
-- Settling waits for the extra to be handed out.
select migration_chain.expect(api.staff_settle_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  jsonb_build_array(jsonb_build_object('amount_tzs', 6000, 'purpose', 'Levy and stamp',
    'receipt_id', null, 'no_receipt_reason', 'transport_fare', 'no_receipt_note', null)),
  0, null, 'chain-raise-h-early'), 'raise_not_handed_out', 'H settled before its extra was handed out');
select migration_chain.spend('h.extra', api.staff_hand_out_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'h.ask'),
  'Chain council', 'chain-raise-h-extra'), 'handed_out');
-- Held to the raised 6,000, not the 4,000 it was handed out for.
select migration_chain.expect(api.staff_settle_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  jsonb_build_array(jsonb_build_object('amount_tzs', 6001, 'purpose', 'Levy and stamp',
    'receipt_id', null, 'no_receipt_reason', 'transport_fare', 'no_receipt_note', null)),
  0, null, 'chain-raise-h-over'), 'over_approval', 'H settled above its raised approval');
select migration_chain.spend('h.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  jsonb_build_array(jsonb_build_object('amount_tzs', 6000, 'purpose', 'Levy and stamp',
    'receipt_id', null, 'no_receipt_reason', 'transport_fare', 'no_receipt_note', null)),
  0, null, 'chain-raise-h-settle'), 'settled');
-- Committed, so the deferred checks on the settlement really run against the raised amount.
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('h.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('h')),
  'chain-raise-h-verify'), 'verified');
commit;

do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/70000/25000/45000/15000' then
    raise exception 'verifying H should post 6,000 and leave 95000/70000/25000/45000/15000, found %', v;
  end if;
  if (select string_agg(kind::text || ':' || amount_tzs, ',' order by kind)
        from public.imprest_postings where disbursement_id = migration_chain.did('h'))
     is distinct from 'expense:6000' then
    raise exception 'H should post one 6,000 expense';
  end if;
  if (select approved_tzs from public.imprest_settlements
       where disbursement_id = migration_chain.did('h')) <> 6000 then
    raise exception 'H''s settlement should record the raised approved amount of 6,000';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. G, sent back before the upgrade at cycle 1: raised by 1,000, settled again at 16,000
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('g.ask', api.staff_request_imprest_raise(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  1000, 'A second fuel station charged more', 'chain-raise-g-ask'), 'requested');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('g.raise', api.staff_decide_imprest_raise(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'g.ask'),
  true, null, 'chain-raise-g-raise'), 'raised');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('g.extra', api.staff_hand_out_imprest_raise(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'g.ask'),
  'Chain fuel station', 'chain-raise-g-extra'), 'handed_out');
commit;

do $$
declare
  v text;
begin
  -- The returned cycle's 15,000 and the 1,000 handed out since.
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/70000/26000/44000/16000' then
    raise exception 'G raised and handed out should leave 95000/70000/26000/44000/16000, found %', v;
  end if;
end
$$;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('g.settled.again', api.staff_settle_imprest_disbursement(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  jsonb_build_array(jsonb_build_object('amount_tzs', 16000, 'purpose', 'Petrol',
    'receipt_id', null, 'no_receipt_reason', 'vendor_did_not_issue', 'no_receipt_note', null)),
  0, null, 'chain-raise-g-settle'), 'settled');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('g.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  (select id from public.imprest_settlements
    where disbursement_id = migration_chain.did('g') order by cycle desc limit 1),
  'chain-raise-g-verify'), 'verified');
commit;

do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/54000/10000/44000/0' then
    raise exception 'verifying G should post 16,000 and leave 95000/54000/10000/44000/0, found %', v;
  end if;

  if (select string_agg(cycle || ':' || approved_tzs || ':' || used_tzs, ',' order by cycle)
        from public.imprest_settlements where disbursement_id = migration_chain.did('g'))
     is distinct from '1:15000:15000,2:16000:16000' then
    raise exception 'G should keep cycle 1 at 15,000 and explain 16,000 in cycle 2';
  end if;

  if (select string_agg(status::text || ':' || amount_tzs, ',' order by requested_at)
        from public.imprest_approval_raises)
     is distinct from 'handed_out:2000,handed_out:1000' then
    raise exception 'the raises should read handed_out:2000,handed_out:1000';
  end if;

  -- Every step is on the audit trail.
  if (select count(*) from public.audit_events
       where action in ('imprest_raise_requested', 'imprest_raise_raised', 'imprest_raise_handed_out')
         and entity_type = 'imprest_disbursement') <> 6 then
    raise exception 'the audit trail should hold six raised-approval events';
  end if;
end
$$;

-- A raise is never changed, even by the table's owner.
do $$
begin
  begin
    update public.imprest_approval_raises set reason = 'Rewritten';
    raise exception 'a raise was rewritten';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the raised approval migration upgraded a populated v0.8.0 database and works on it'
