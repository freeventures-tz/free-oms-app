-- Issue #71 · Migration chain, step 53: raised approvals, one handed out and verified, one refused
--
-- Runs after step 49 on the v0.9.0 database, reusing its people and its payments. Through the
-- released commands:
--
--   H  handed out 4,000: the Cashier asks for 2,000 more, the Manager raises it, the Cashier hands
--      out the extra, settles 6,000 and the Manager verifies it. A 6,000 expense is posted.
--   G  sent back at cycle 1: the Cashier asks for 1,000 more and the Manager refuses it.
--
-- So the reversal migration meets what v0.9.0 released: a raise handed out and verified, and one
-- refused, beside the verification B carries since v0.5.0 (a 17,000 expense and a 1,000 loss).
-- The figures read posted balance 70,000, set aside 25,000, Free to approve 45,000 and Awaiting
-- verification 15,000, on both sides of the upgrade.

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('h.ask', api.staff_request_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  2000, 'The levy rose after the notice went up', 'chain-v090-h-ask'), 'requested');
select migration_chain.spend('g.ask', api.staff_request_imprest_raise(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  1000, 'A second fuel station charged more', 'chain-v090-g-ask'), 'requested');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('h.raise', api.staff_decide_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'h.ask'),
  true, null, 'chain-v090-h-raise'), 'raised');
select migration_chain.spend('g.refuse', api.staff_decide_imprest_raise(
  migration_chain.did('g'),
  (select version from public.imprest_disbursements where id = migration_chain.did('g')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'g.ask'),
  false, 'Settle the first station first', 'chain-v090-g-refuse'), 'refused');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('h.extra', api.staff_hand_out_imprest_raise(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select (res -> 'raise' ->> 'id')::uuid from migration_chain.disbursements where name = 'h.ask'),
  'Chain council', 'chain-v090-h-extra'), 'handed_out');
select migration_chain.spend('h.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  jsonb_build_array(jsonb_build_object('amount_tzs', 6000, 'purpose', 'Levy and stamp',
    'receipt_id', null, 'no_receipt_reason', 'transport_fare', 'no_receipt_note', null)),
  0, null, 'chain-v090-h-settle'), 'settled');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('h.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('h'),
  (select version from public.imprest_disbursements where id = migration_chain.did('h')),
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('h')),
  'chain-v090-h-verify'), 'verified');
-- Committed, so the deferred checks on the raise, the settlement and the verification really run.
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
    raise exception 'the v0.9.0 ground should read 95000/70000/25000/45000/15000, found %', v;
  end if;
  -- Both were asked in one transaction, so they share a moment; the amount tells them apart.
  if (select string_agg(status::text || ':' || amount_tzs, ',' order by amount_tzs desc)
        from public.imprest_approval_raises) is distinct from 'handed_out:2000,refused:1000' then
    raise exception 'the raises should read handed_out:2000,refused:1000';
  end if;
end
$$;

\echo 'migration-chain: a raise handed out and verified, and one refused, on the v0.9.0 database'
