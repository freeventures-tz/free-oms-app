-- Issue #73 · Counterexample: a stock receipt's delivery note rewritten in place
--
-- A receipt is written once and never updated: no command changes one, and no role but the
-- superuser holds UPDATE on the table. A link migration that "tidied" released receipts while adding
-- the new table would do it this way. This file does, rewriting the delivery note the Cashier typed
-- from the supplier's paperwork. No row is added or removed and no quantity moves, so every count,
-- stock balance and figure is unchanged, and the gate is REQUIRED to notice anyway. If it did not,
-- the link release could rewrite which paper a delivery was recorded against and the gate would call
-- the database preserved.

begin;

create temp table receipts_before as
select (select count(*) from public.stock_receipts) as receipts,
       (select coalesce(sum(quantity_delta), 0) from public.inventory_ledger) as stock;

update public.stock_receipts
   set delivery_note_ref = 'DN-REWRITTEN'
 where delivery_note_ref = 'DN-CHAIN-V0110-1';

do $$
begin
  if (select count(*) from public.stock_receipts where delivery_note_ref = 'DN-REWRITTEN') <> 1 then
    raise exception 'the counterexample expects exactly one receipt to rewrite';
  end if;
  if exists (select 1 from receipts_before b
              where b.receipts <> (select count(*) from public.stock_receipts)
                 or b.stock <> (select coalesce(sum(quantity_delta), 0) from public.inventory_ledger)) then
    raise exception 'the counterexample changed a receipt count or stock, so it does not test the content digests';
  end if;
end
$$;

commit;
