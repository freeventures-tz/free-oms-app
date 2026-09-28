-- Issue #68 · Migration chain, step 41: a settlement sent back, waiting for the Cashier
--
-- Runs after step 37 on the v0.6.0 database, reusing its people and its disbursements. The Manager
-- sends G's settlement back through the released command, so the count migration meets a return,
-- append-only, and a disbursement left sent back beside rows in every earlier status:
--
--   A  proposed 5,000
--   B  verified: a 17,000 expense and a 1,000 unexplained loss
--   C  rejected, D withdrawn, E cancelled
--   F  approved 10,000
--   G  sent back at cycle 1, Used 15,000, waiting for the Cashier
--   H  handed out 4,000, not settled
--
-- A send-back moves no money, so the posted balance is still 77,000, TZS 29,000 is set aside,
-- 48,000 is free to approve and 19,000 is awaiting verification, on both sides of the upgrade.

begin;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
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
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/77000/29000/48000/19000' then
    raise exception 'the send-back fixture should leave 95000/77000/29000/48000/19000, found %', v;
  end if;

  if (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements)
     is distinct from 'proposed,verified,rejected,withdrawn,cancelled,approved,sent_back,handed_out' then
    raise exception 'the send-back fixture does not hold one row in every released status: %',
      (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements);
  end if;

  if (select count(*) from public.imprest_settlement_returns) <> 1 then
    raise exception 'the fixture should hold one return';
  end if;
end
$$;

\echo 'migration-chain: a settlement sent back, beside every earlier status and a verification'
