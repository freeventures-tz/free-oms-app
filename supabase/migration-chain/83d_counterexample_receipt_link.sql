-- Issue #83 · Counterexample: a delivery's imprest payment repointed in place
--
-- v0.12.0 released the receipt link, and the v0.12.1 query is the first to compare its rows. A link
-- is written once: a trigger refuses UPDATE for every role. A migration runs as the table's owner
-- and can switch that trigger off, so this file does, and points the one released link at another
-- disbursement of the same fund. No row is added or removed and no figure or stock moves, so every
-- count is unchanged, and the gate is REQUIRED to notice anyway. The trigger is put back before the
-- file finishes.
--
-- Disposable database only: the harness runs this at the end of the phase and resets straight
-- afterwards.

\set ON_ERROR_STOP on

begin;

alter table public.stock_receipt_imprest_links disable trigger stock_receipt_imprest_links_append_only;

do $$
declare
  v_receipt uuid;
  v_from    uuid;
  v_to      uuid;
begin
  select l.receipt_id, l.disbursement_id into v_receipt, v_from
    from public.stock_receipt_imprest_links l
   order by l.linked_at
   limit 1;
  if v_receipt is null then
    raise exception 'the counterexample needs the released link step 83b built';
  end if;

  select d.id into v_to
    from public.imprest_disbursements d
   where d.id <> v_from
     and d.fund_id = (select fund_id from public.stock_receipt_imprest_links where receipt_id = v_receipt)
   order by d.id
   limit 1;
  if v_to is null then
    raise exception 'the counterexample found no other disbursement to repoint the link at';
  end if;

  update public.stock_receipt_imprest_links set disbursement_id = v_to where receipt_id = v_receipt;

  if (select count(*) from public.stock_receipt_imprest_links) <> 1 then
    raise exception 'the counterexample changed how many links there are, so it does not test the digest';
  end if;
end
$$;

alter table public.stock_receipt_imprest_links enable trigger stock_receipt_imprest_links_append_only;

commit;
