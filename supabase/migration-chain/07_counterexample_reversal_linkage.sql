-- v0.0.5 · Migration chain, counterexample 2: a reversal repointed at the wrong payment
--
-- `payments.reverses_id` is the whole of what makes a negative row a reversal OF something. Repoint
-- it and the count of payments is identical, every amount is identical, every method and business
-- date is identical — and the money now cancels a payment nobody asked to reverse, on an invoice
-- that was never in question. This is the change a preservation query built from
-- `invoice_id | method | amount` cannot see, which is precisely what the v0.0.4 gate used to be.
--
-- THE TRIGGER IS DISABLED HERE, ON PURPOSE. `payments_refuse_update` makes the table append-only
-- for the product, and that is right: no released command edits a payment. It is not a reason to
-- leave the gate untested, because the thing being simulated is a MIGRATION — which runs as the
-- table's owner and can drop a trigger, disable it, or replace the function behind it before
-- touching a row. A gate that only catches corruption polite enough to leave the triggers on is a
-- gate that catches nothing. The trigger is put back before this file finishes.
--
-- Disposable database only: the harness runs this at the end of the phase and resets straight
-- afterwards, and the file refuses to run without the fixture it expects.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_reversal   uuid;
  v_original   uuid;
  v_substitute uuid;
  v_rows_before   integer;
  v_rows_after    integer;
  v_money_before  bigint;
  v_money_after   bigint;
begin
  if to_regclass('migration_chain.reversed_payment') is null then
    raise exception
      'counterexample 2 needs the populated v0.0.4 fixture: migration_chain.reversed_payment '
      'is missing';
  end if;

  select count(*), coalesce(sum(p.amount_tzs), 0)
    into v_rows_before, v_money_before
    from public.payments p;

  select p.id, p.reverses_id into v_reversal, v_original
    from public.payments p
   where p.reverses_id is not null
   order by p.entry_seq
   limit 1;

  if v_reversal is null then
    raise exception 'counterexample 2 found no reversal to repoint, so the fixture never built one';
  end if;

  -- Another real payment, on a different invoice, which the reversal has no business undoing.
  select p.id into v_substitute
    from public.payments p
   where p.reverses_id is null
     and p.id <> v_original
     and p.invoice_id <> (select q.invoice_id from public.payments q where q.id = v_original)
   order by p.entry_seq
   limit 1;

  if v_substitute is null then
    raise exception 'counterexample 2 found no second payment to repoint the reversal at';
  end if;

  alter table public.payments disable trigger payments_refuse_update;

  update public.payments set reverses_id = v_substitute where id = v_reversal;

  if not found then
    raise exception 'counterexample 2 repointed nothing, so it proves nothing about the gate';
  end if;

  alter table public.payments enable trigger payments_refuse_update;

  select count(*), coalesce(sum(p.amount_tzs), 0)
    into v_rows_after, v_money_after
    from public.payments p;

  -- SAME ROWS, SAME MONEY, DIFFERENT LINKAGE. That is the entire change, and it is the whole claim
  -- this file makes to the harness: if a count or a total had moved as well, the gate could notice
  -- for the wrong reason and the counterexample would be proving that counts still work.
  if v_rows_after <> v_rows_before then
    raise exception 'counterexample 2 changed the payment count from % to %, which is not the '
                    'linkage-only change it is meant to be', v_rows_before, v_rows_after;
  end if;

  if v_money_after <> v_money_before then
    raise exception 'counterexample 2 changed the money from % to %, which is not the '
                    'linkage-only change it is meant to be', v_money_before, v_money_after;
  end if;
end
$$;

-- Put back whatever happened above: a counterexample that left the table editable would weaken
-- every assertion the rest of the run makes.
do $$
begin
  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'payments' and t.tgname = 'payments_refuse_update' and t.tgenabled = 'D'
  ) then
    alter table public.payments enable trigger payments_refuse_update;
  end if;
end
$$;

commit;

\echo 'migration-chain: counterexample 2 repointed a reversal, leaving every count and amount intact'
