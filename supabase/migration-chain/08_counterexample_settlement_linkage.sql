-- v0.0.5 · Migration chain, counterexample 3: a settlement attributed to the wrong person
--
-- §12.6 step 7 makes the Cashier's confirmation the thing that lets goods be handed over, and
-- `invoices.settlement_approved_by` is the record of who gave it. Reassign it and the invoice count
-- is identical, every number on every invoice is identical, the allocations are still committed and
-- the dispatch still says released — and the business now has a signed-for release nobody signed
-- for. That is the shape of an authorisation being lost across a migration.
--
-- No trigger is disabled here, and that is worth noticing: `refuse_invoice_amendment` protects the
-- amounts, the numbering and the cancellation pair, and lets the settlement columns move because a
-- released command has to write them. So this is a change an ordinary `UPDATE` inside a migration
-- can make today, with nothing switched off first.
--
-- Disposable database only: the harness runs this at the end of the phase and resets straight
-- afterwards, and the file refuses to run without the fixture it expects.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_invoice    uuid;
  v_approver   uuid;
  v_substitute uuid;
  v_rows_before  integer;
  v_rows_after   integer;
  v_settled_before integer;
  v_settled_after  integer;
begin
  if to_regclass('migration_chain.invoices') is null then
    raise exception
      'counterexample 3 needs the populated v0.0.4 fixture: migration_chain.invoices is missing';
  end if;

  select count(*), count(*) filter (where i.settlement_approved_by is not null)
    into v_rows_before, v_settled_before
    from public.invoices i;

  select i.id, i.settlement_approved_by into v_invoice, v_approver
    from public.invoices i
   where i.settlement_approved_by is not null
   order by i.invoice_no
   limit 1;

  if v_invoice is null then
    raise exception 'counterexample 3 found no approved settlement to reassign, so the fixture '
                    'never confirmed one';
  end if;

  -- Somebody else entirely, who never looked at this invoice.
  select p.id into v_substitute
    from public.profiles p
   where p.id <> v_approver
   order by p.id
   limit 1;

  if v_substitute is null then
    raise exception 'counterexample 3 found nobody else to attribute the settlement to';
  end if;

  update public.invoices
     set settlement_approved_by = v_substitute
   where id = v_invoice;

  if not found then
    raise exception 'counterexample 3 reassigned nothing, so it proves nothing about the gate';
  end if;

  select count(*), count(*) filter (where i.settlement_approved_by is not null)
    into v_rows_after, v_settled_after
    from public.invoices i;

  -- The same invoices, the same number of them settled. Only WHO is different, which is exactly
  -- what an invoice digest without settlement attribution cannot tell you.
  if v_rows_after <> v_rows_before or v_settled_after <> v_settled_before then
    raise exception 'counterexample 3 changed how many invoices exist or how many are settled '
                    '(% of %, was % of %), which is not the attribution-only change it is meant '
                    'to be', v_settled_after, v_rows_after, v_settled_before, v_rows_before;
  end if;
end
$$;

commit;

\echo 'migration-chain: counterexample 3 reassigned a settlement, leaving every count intact'
