-- Issue #64 · Migration chain, step 33: hand-outs and settlements in every released shape
--
-- Runs after step 29 on the v0.4.0 database, reusing its people and its disbursements. Every
-- status the released workflow can leave behind is now present, built through the released
-- commands, because each is a row the verification migrations must carry across untouched:
--
--   A  proposed 5,000                  (from step 29)
--   B  settled with a receipt, a No-receipt line and a remainder: Used 17,000, Returned 2,000,
--      Not accounted for 1,000         (step 34 verifies it after the upgrade)
--   C  rejected, D withdrawn, E cancelled (from step 29)
--   F  approved 10,000                 (from step 29)
--   G  settled exactly: Used 15,000    (step 34 verifies it after the upgrade)
--   H  handed out 4,000, not settled
--
-- So TZS 49,000 is set aside, 46,000 is free to approve and 37,000 is awaiting verification, on
-- both sides of the upgrade.

begin;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('g', api.staff_propose_imprest_disbursement(
  15000, 'fuel_and_lubricants', 'Chain generator fuel', 'chain-dsb-g'), 'proposed');
select migration_chain.spend('h', api.staff_propose_imprest_disbursement(
  4000, 'fees_and_charges', 'Chain council levy', 'chain-dsb-h'), 'proposed');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('g.approved', api.staff_decide_imprest_disbursement(
  migration_chain.did('g'), 1, true, null, 'chain-dsb-g-a'), 'approved');
select migration_chain.spend('h.approved', api.staff_decide_imprest_disbursement(
  migration_chain.did('h'), 1, true, null, 'chain-dsb-h-a'), 'approved');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('b.handed_out', api.staff_hand_out_imprest_disbursement(
  migration_chain.did('b'), 2, 'Chain driver', 'chain-dsb-b-h'), 'handed_out');
select migration_chain.spend('g.handed_out', api.staff_hand_out_imprest_disbursement(
  migration_chain.did('g'), 2, 'Chain fuel station', 'chain-dsb-g-h'), 'handed_out');
select migration_chain.spend('h.handed_out', api.staff_hand_out_imprest_disbursement(
  migration_chain.did('h'), 2, 'Chain council', 'chain-dsb-h-h'), 'handed_out');
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
select migration_chain.spend('g.settled', api.staff_settle_imprest_disbursement(
  migration_chain.did('g'), 3,
  jsonb_build_array(
    jsonb_build_object('amount_tzs', 15000, 'purpose', 'Petrol', 'receipt_id', null,
                       'no_receipt_reason', 'vendor_did_not_issue', 'no_receipt_note', null)),
  0, null, 'chain-dsb-g-s'), 'settled');

-- Committed, so the deferred check that a settlement's totals match its lines really runs.
commit;

do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/49000/46000/37000' then
    raise exception 'the settlement fixture should leave 95000/49000/46000/37000, found %', v;
  end if;

  if (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements)
     is distinct from 'proposed,settled,rejected,withdrawn,cancelled,approved,settled,handed_out' then
    raise exception 'the settlement fixture does not hold one row in every released status: %',
      (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements);
  end if;

  if (select string_agg(used_tzs || '/' || returned_tzs || '/' || unaccounted_tzs, ',' order by used_tzs desc)
        from public.imprest_settlements) is distinct from '17000/2000/1000,15000/0/0' then
    raise exception 'the fixture should hold one settlement with a remainder and one without';
  end if;
end
$$;

\echo 'migration-chain: hand-outs and settlements with and without a remainder'
