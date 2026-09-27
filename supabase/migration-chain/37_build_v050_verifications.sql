-- Issue #65 · Migration chain, step 37: a real verification, with an unexplained loss
--
-- Runs after step 33 on the v0.5.0 database, reusing its people and its disbursements. The Manager
-- verifies B through the released command, so the send-back migrations meet a verification and its
-- two postings, both append-only, beside rows still waiting in every earlier status:
--
--   A  proposed 5,000
--   B  verified: a 17,000 expense and a 1,000 unexplained loss
--   C  rejected, D withdrawn, E cancelled
--   F  approved 10,000
--   G  settled exactly, Used 15,000, waiting for the Manager (step 38 sends it back)
--   H  handed out 4,000, not settled
--
-- So the posted balance is 77,000, TZS 29,000 is set aside, 48,000 is free to approve and 19,000 is
-- awaiting verification, on both sides of the upgrade.

begin;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('b.verified', api.staff_verify_imprest_disbursement(
  migration_chain.did('b'), 4,
  (select id from public.imprest_settlements where disbursement_id = migration_chain.did('b')),
  'chain-dsb-b-v'), 'verified');

-- Committed, so the deferred check that the verification carries its postings really runs.
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
  if v is distinct from '95000/77000/29000/48000/19000' then
    raise exception 'the verification fixture should leave 95000/77000/29000/48000/19000, found %', v;
  end if;

  if (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements)
     is distinct from 'proposed,verified,rejected,withdrawn,cancelled,approved,settled,handed_out' then
    raise exception 'the verification fixture does not hold one row in every released status: %',
      (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements);
  end if;

  if (select string_agg(kind::text || ':' || amount_tzs, ',' order by kind) from public.imprest_postings)
     is distinct from 'expense:17000,unexplained_loss:1000' then
    raise exception 'the fixture should hold one expense and one unexplained loss';
  end if;
end
$$;

\echo 'migration-chain: a verification with an unexplained loss, beside every earlier status'
