-- Issue #73 · Migration chain, step 61: deliveries entered on the v0.11.0 database, and a
-- retirement it refused
--
-- Runs after step 57 on the v0.11.0 database, reusing its people, its supplier and its payments.
-- Through the released commands:
--
--   R1  the Cashier enters a delivery the Manager has not decided, so it is pending at the upgrade.
--   R2  the Manager enters a delivery and rejects it, so a decided receipt meets the upgrade too.
--   X   the Manager submits the fund's retirement. The released ground keeps payments open, so it is
--       refused, naming them, and the refusal is committed to the audit trail.
--
-- So the link migration meets what v0.11.0 released: receipts in every state it can hold, none of
-- them paid from imprest, with the fund still active and its figures reading posted balance
-- 70,500, set aside 25,000, Free to approve 45,500 and Awaiting verification 15,000, on both sides
-- of the upgrade.

create table migration_chain.v0110 (name text primary key, res jsonb not null);

create or replace function migration_chain.v0110(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'v0.11.0 ' || p_name);
  insert into migration_chain.v0110 values (p_name, p_res)
    on conflict (name) do update set res = excluded.res;
  return p_res;
end
$$;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.v0110('r1', api.staff_enter_stock_receipt(
  (select id from public.suppliers order by created_at limit 1), 'store', current_date,
  'DN-CHAIN-V0110-1',
  jsonb_build_array(jsonb_build_object('product_id', migration_chain.product('Dangote Cement 42R'),
                                       'expected_quantity', 10, 'received_quantity', 9)),
  'chain-v0110-r1'), 'entered');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.v0110('r2', api.staff_enter_stock_receipt(
  (select id from public.suppliers order by created_at limit 1), 'warehouse', current_date,
  'DN-CHAIN-V0110-2',
  jsonb_build_array(jsonb_build_object('product_id', migration_chain.product('Dangote Cement 42R'),
                                       'expected_quantity', 4, 'received_quantity', 4)),
  'chain-v0110-r2'), 'entered');
select migration_chain.v0110('r2.reject', api.staff_reject_stock_receipt(
  ((select res from migration_chain.v0110 where name = 'r2') -> 'receipt' ->> 'id')::uuid,
  'Wrong delivery, sent back to the supplier', 'chain-v0110-r2-reject'), 'rejected');

select migration_chain.v0110('x', api.staff_submit_imprest_retirement(null, 'Month end',
  'chain-v0110-retire'), 'blocked');
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
    raise exception 'the v0.11.0 ground should read 95000/70500/25000/45500/15000, found %', v;
  end if;
  if (select count(*) from public.imprest_retirements) <> 0 then
    raise exception 'the refused retirement wrote a row';
  end if;
  if not exists (select 1 from public.audit_events
                  where action = 'command_refused'
                    and source_operation = 'api.staff_submit_imprest_retirement') then
    raise exception 'the refused retirement is not on the audit trail';
  end if;
end
$$;

-- The receipts and the stock as they stand, for step 62 to require unchanged.
create table migration_chain.v0110_ground as
select (select count(*) from public.stock_receipts) as receipts,
       (select coalesce(sum(quantity_delta), 0) from public.inventory_ledger) as stock,
       (select count(*) from public.approval_requests
         where entity_type = 'stock_receipt' and status = 'pending') as pending;

\echo 'migration-chain: deliveries entered and a retirement refused, on the v0.11.0 database'
