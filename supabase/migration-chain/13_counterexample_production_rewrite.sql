-- v0.0.6 · Migration chain, counterexample 5: a batch's actual usage rewritten, every count intact
--
-- WHY THESE FILES EXIST is set out in `06_counterexample_customer_rename.sql` and is not repeated:
-- a preservation gate that cannot say no has never said yes either, so each counterexample makes
-- one change a bad migration could really make and the harness REQUIRES the gate's answer to move.
--
-- THIS ONE is the v0.0.5 ground the earlier four never covered. `production_batch_inputs.actual_
-- quantity` is what a batch really consumed (§11.1, AC-38) — the number this whole release exists
-- to protect, and the number the yard is deducted by. Rewriting it in place adds no row and removes
-- none, so every count in the v0.0.5 preservation query is identical afterwards and only a
-- comparison of the CONTENTS can see it.
--
-- The lot's accepted quantity is rewritten with it, because AC-45 makes that the figure that became
-- sellable: a gate that watched what a batch consumed but not what it yielded would still miss half
-- of production.
--
-- Like its four predecessors this runs at the END of the phase, on the disposable local database
-- the harness resets straight afterwards, and it refuses to run unless the fixture it expects is
-- in front of it.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_input_id uuid;
  v_lot_id   uuid;
  v_before   integer;
  v_after    integer;
begin
  if not exists (select 1 from public.production_batches where status = 'approved') then
    raise exception
      'counterexample 5 needs the populated v0.0.5 fixture: no approved batch is present';
  end if;

  select (select count(*) from public.production_batch_inputs)
       + (select count(*) from public.production_lots)
    into v_before;

  -- One input line, changed to a quantity nobody recorded. A migration that rebuilt this table from
  -- the standard quantity rather than the actual one would do exactly this, silently, and §11.1 is
  -- explicit that the variance is never used to adjust the deduction back toward the recipe.
  select id into v_input_id from public.production_batch_inputs order by id limit 1;

  update public.production_batch_inputs
     set actual_quantity = actual_quantity + 1
   where id = v_input_id;

  if not found then
    raise exception 'counterexample 5 changed no batch input, so it proves nothing about the gate';
  end if;

  -- And the yield, which is the other half of a batch's record.
  --
  -- ONE BRICK MOVED FROM ACCEPTED TO REJECTED, rather than simply subtracted. `lot_inspection_
  -- within_curing` requires accepted + rejected to equal what survived moulding (AC-45), and the
  -- database is right to refuse a lot that does not add up — a counterexample must make a change a
  -- bad migration could REALLY make, and one the schema forbids is not that. Moving a unit between
  -- the two columns keeps the accounting intact and is the more honest damage anyway: it is a brick
  -- that was sellable being recorded as scrap, with every total in the business unchanged.
  select id into v_lot_id from public.production_lots
   where accepted_quantity is not null and accepted_quantity > 0
   order by id limit 1;

  if v_lot_id is not null then
    update public.production_lots
       set accepted_quantity        = accepted_quantity - 1,
           rejected_at_inspection   = rejected_at_inspection + 1
     where id = v_lot_id;
  end if;

  select (select count(*) from public.production_batch_inputs)
       + (select count(*) from public.production_lots)
    into v_after;

  -- The claim this file makes to the harness: the ONLY thing that moved is content. A count that
  -- moved too would let the harness pass for the wrong reason, proving that counting still works
  -- rather than that the digests do.
  if v_after <> v_before then
    raise exception 'counterexample 5 changed the production row count from % to %, which is not '
                    'the same-count rewrite it is meant to be', v_before, v_after;
  end if;
end
$$;

commit;

\echo 'migration-chain: counterexample 5 rewrote what a batch consumed and yielded, counts intact'
