-- Issue #83 · Migration chain, step 83b: a delivery paid from imprest on the v0.12.1 database
--
-- Runs after step 61 on the v0.12.1 database, reusing its people, its supplier and its payments.
-- Through the released seven-argument command, the Manager enters a delivery paid from the
-- handed-out disbursement `b`, so the till migration meets a receipt link as v0.12.0 released it,
-- and the preservation query has a link row to compare.

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.v0110('r3', api.staff_enter_stock_receipt(
  (select id from public.suppliers order by created_at limit 1), 'store', current_date,
  'DN-CHAIN-V0121-1',
  jsonb_build_array(jsonb_build_object('product_id', migration_chain.product('Dangote Cement 42R'),
                                       'expected_quantity', 2, 'received_quantity', 2)),
  migration_chain.did('b'), 'chain-v0121-r3'), 'entered');
commit;

do $$
begin
  if (select count(*) from public.stock_receipt_imprest_links) <> 1 then
    raise exception 'step 83b expected exactly one receipt link on the v0.12.1 ground';
  end if;
  if (select count(*) from public.payments) = 0
     or not exists (select 1 from public.payments where reverses_id is not null) then
    raise exception 'step 83b expected released payments and a reversal for the till to read';
  end if;
end
$$;

\echo 'migration-chain: a delivery paid from imprest stands on the v0.12.1 ground'
