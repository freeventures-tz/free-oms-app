-- Issue #69 · Migration chain, step 45: a day counted, sent back, counted again and confirmed
--
-- Runs after step 41 on the v0.7.0 database, reusing its people and its figures. Through the
-- released commands the Cashier counts TZS 56,000 against the 58,000 expected, the Manager sends it
-- back, the Cashier counts 57,000, and the Manager confirms the 1,000 shortage, which posts and
-- raises a flag. So the Not counted migration meets a count, a return, a confirmation, a posting
-- and a flag.
--
-- Then the day is moved two days into the past, and the fund's opening three, as v0.7.0 running in
-- production for two days would leave it: the count on the day v0.7.0 was released, and yesterday
-- never counted. The migration must start counting from the first count's day, so yesterday is Not
-- counted and the days before the release are not.

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.1', api.staff_enter_imprest_count(
  private.imprest_business_date(), null, 56000, 'Notes only', 'chain-count-1'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.1.back', api.staff_send_back_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.1'),
  1, 'Count the coin bag too', 'chain-count-1-back'), 'sent_back');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.2', api.staff_enter_imprest_count(
  private.imprest_business_date(),
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.1'),
  57000, null, 'chain-count-2'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.2.confirmed', api.staff_confirm_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.2'),
  1, 'counting_error', null, 'chain-count-2-confirm'), 'confirmed');
-- Committed, so the deferred check that the confirmation carries its posting and flag really runs.
commit;

-- Two days on. The count tables refuse any update to a count's day, so this runs with their
-- triggers suspended for the one transaction, as the local stack's owner.
begin;
set local session_replication_role = replica;
update public.imprest_counts set business_date = business_date - 2;
update public.imprest_count_flags set business_date = business_date - 2;
update public.imprest_funds set opened_at = opened_at - interval '3 days' where is_active;
commit;

do $$
declare
  v text;
begin
  if (select string_agg(attempt::text || ':' || status::text || ':' || expected_tzs || ':'
                        || variance_tzs || ':' || (private.imprest_business_date() - business_date),
                        ',' order by attempt)
        from public.imprest_counts)
     is distinct from '1:sent_back:58000:-2000:2,2:confirmed:58000:-1000:2' then
    raise exception 'the counts should read 1:sent_back:58000:-2000:2,2:confirmed:58000:-1000:2, found %',
      (select string_agg(attempt::text || ':' || status::text || ':' || expected_tzs || ':'
                         || variance_tzs || ':' || (private.imprest_business_date() - business_date),
                         ',' order by attempt) from public.imprest_counts);
  end if;

  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '76000/29000/47000/19000' then
    raise exception 'the count fixture should leave 76000/29000/47000/19000, found %', v;
  end if;

  if (select count(*) from public.imprest_count_flags) <> 1
     or (select count(*) from public.imprest_count_returns) <> 1 then
    raise exception 'the count fixture should hold one flag and one return';
  end if;
end
$$;

\echo 'migration-chain: a day counted two days ago, sent back, counted again and confirmed short'
