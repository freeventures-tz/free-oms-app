-- Issue #62 · Migration chain, step 29: disbursements in every released status
--
-- Runs after steps 11, 15 and 23 on the v0.3.3 database, reusing their people (the Chain Cashier
-- proposes, the Chain Manager decides) and the TZS 95,000 of posted funding step 15 leaves. Every
-- status the released disbursement workflow can leave behind is built through its own commands,
-- because each is a row the settlement migrations must carry across untouched:
--
--   A  proposed 5,000, never decided
--   B  approved 20,000          (step 30 hands it out and settles it after the upgrade)
--   C  rejected with a reason
--   D  withdrawn by the Cashier
--   E  approved, then cancelled, which frees its money
--   F  approved 10,000          (still approved after the upgrade)
--
-- So TZS 30,000 is set aside and TZS 65,000 is free to approve, on both sides of the upgrade.

begin;

create table migration_chain.disbursements (name text primary key, res jsonb not null);

create or replace function migration_chain.spend(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'imprest disbursement ' || p_name);
  insert into migration_chain.disbursements values (p_name, p_res)
    on conflict (name) do update set res = excluded.res;
  return p_res;
end
$$;

create or replace function migration_chain.did(p_name text) returns uuid language sql stable as $$
  select (res -> 'disbursement' ->> 'id')::uuid from migration_chain.disbursements where name = p_name;
$$;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('a', api.staff_propose_imprest_disbursement(
  5000, 'fuel_and_lubricants', 'Chain generator diesel', 'chain-dsb-a'), 'proposed');
select migration_chain.spend('b', api.staff_propose_imprest_disbursement(
  20000, 'transport_and_delivery', 'Chain trip allowance', 'chain-dsb-b'), 'proposed');
select migration_chain.spend('c', api.staff_propose_imprest_disbursement(
  8000, 'meals_and_staff_welfare', 'Chain lunch', 'chain-dsb-c'), 'proposed');
select migration_chain.spend('d', api.staff_propose_imprest_disbursement(
  3000, 'other', 'Chain padlock', 'chain-dsb-d'), 'proposed');
select migration_chain.spend('e', api.staff_propose_imprest_disbursement(
  12000, 'repairs_and_maintenance', 'Chain mixer belt', 'chain-dsb-e'), 'proposed');
select migration_chain.spend('f', api.staff_propose_imprest_disbursement(
  10000, 'labour_and_casual_workers', 'Chain offloading', 'chain-dsb-f'), 'proposed');
select migration_chain.spend('d.withdrawn', api.staff_withdraw_imprest_disbursement(
  migration_chain.did('d'), 1, 'Bought one myself', 'chain-dsb-d-w'), 'withdrawn');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('b.approved', api.staff_decide_imprest_disbursement(
  migration_chain.did('b'), 1, true, null, 'chain-dsb-b-a'), 'approved');
select migration_chain.spend('c.rejected', api.staff_decide_imprest_disbursement(
  migration_chain.did('c'), 1, false, 'Staff lunch comes from payroll', 'chain-dsb-c-r'), 'rejected');
select migration_chain.spend('e.approved', api.staff_decide_imprest_disbursement(
  migration_chain.did('e'), 1, true, null, 'chain-dsb-e-a'), 'approved');
select migration_chain.spend('e.cancelled', api.staff_cancel_imprest_disbursement(
  migration_chain.did('e'), 2, 'Repaired under warranty', 'chain-dsb-e-c'), 'cancelled');
select migration_chain.spend('f.approved', api.staff_decide_imprest_disbursement(
  migration_chain.did('f'), 1, true, null, 'chain-dsb-f-a'), 'approved');

do $$
declare
  v_figures text;
begin
  select s.posted_funding_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs
    into v_figures
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v_figures is distinct from '95000/30000/65000' then
    raise exception 'the disbursement fixture should leave 95000/30000/65000, found %', v_figures;
  end if;

  if (select string_agg(status::text, ',' order by disbursement_no) from public.imprest_disbursements)
     is distinct from 'proposed,approved,rejected,withdrawn,cancelled,approved' then
    raise exception 'the disbursement fixture does not hold one row in every released status';
  end if;
end
$$;

commit;

\echo 'migration-chain: disbursements in every released status'
