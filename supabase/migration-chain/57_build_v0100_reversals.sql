-- Issue #72 · Migration chain, step 57: reversals, one approved and one rejected
--
-- Runs after step 53 on the v0.10.0 database, reusing its people and its payments. Through the
-- released commands:
--
--   H  the 6,000 expense verified in step 53 (after a raise): the Cashier asks for 5,500 and a
--      Director approves, which posts a 6,000 reversal and a 5,500 replacement.
--   B  the 1,000 unexplained loss verified since v0.5.0: the Manager asks for it to be undone and a
--      Director rejects it, so the loss still waits for a Director's decision.
--
-- So the retirement migration meets what v0.10.0 released: a reversal and replacement beside the
-- originals, a rejected request, and a loss still unresolved. The figures read posted balance
-- 70,500, set aside 25,000, Free to approve 45,500 and Awaiting verification 15,000, on both sides
-- of the upgrade.
--
-- It also keeps the active fund's business days as they stand, so step 58 can require the replaced
-- day functions to give the same answer after the upgrade.

create table migration_chain.reversals (name text primary key, res jsonb not null);

create or replace function migration_chain.reverse(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'imprest reversal ' || p_name);
  insert into migration_chain.reversals values (p_name, p_res)
    on conflict (name) do update set res = excluded.res;
  return p_res;
end
$$;

create or replace function migration_chain.rvid(p_name text) returns uuid language sql stable as $$
  select (res -> 'reversal' ->> 'id')::uuid from migration_chain.reversals where name = p_name;
$$;

create or replace function migration_chain.original_posting(p_disbursement uuid, p_kind text)
returns uuid language sql stable as $$
  select id from public.imprest_postings
   where disbursement_id = p_disbursement and kind::text = p_kind and entry = 'original';
$$;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.reverse('h.request', api.staff_request_imprest_reversal(
  migration_chain.original_posting(migration_chain.did('h'), 'expense'), 5500,
  'The stamp was 500 less than the receipt said', 'chain-v0100-h-request'), 'requested');
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.reverse('b.request', api.staff_request_imprest_reversal(
  migration_chain.original_posting(migration_chain.did('b'), 'unexplained_loss'), 0,
  'The 1,000 was found in the van', 'chain-v0100-b-request'), 'requested');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');
select migration_chain.reverse('h.approve', api.admin_decide_imprest_reversal(
  migration_chain.rvid('h.request'), 1, true, null, 'chain-v0100-h-approve'), 'approved');
select migration_chain.reverse('b.reject', api.admin_decide_imprest_reversal(
  migration_chain.rvid('b.request'), 1, false, 'The van was searched twice', 'chain-v0100-b-reject'),
  'rejected');
-- Committed, so the deferred checks that an approval carries its postings really run.
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
  if v is distinct from '95000/70500/25000/45500/15000' then
    raise exception 'the v0.10.0 ground should read 95000/70500/25000/45500/15000, found %', v;
  end if;
  if (select string_agg(status::text, ',' order by status::text) from public.imprest_posting_reversals)
     is distinct from 'approved,rejected' then
    raise exception 'the reversals should read one approved and one rejected';
  end if;
end
$$;

-- The active fund's days and first day, as the released functions give them.
create table migration_chain.v0100_days as
select f.id as fund_id,
       private.imprest_first_count_day(f.id) as first_day,
       (select string_agg(d.business_date::text || ':' || d.state || ':'
                          || coalesce(d.not_counted_since::text, '') || ':'
                          || coalesce(d.resolved_at::text, ''), ',' order by d.business_date)
          from private.imprest_count_days(f.id) d) as days
  from public.imprest_funds f where f.is_active;

\echo 'migration-chain: a reversal approved and one rejected, on the v0.10.0 database'
