-- v0.0.5 . Migration chain, counterexample 4: a rename hidden behind a migration's own writes
--
-- THE ONE THE OTHER THREE CANNOT CATCH. Counterexamples 1 to 3 each make a single invisible change
-- to a still database, so any movement in the gate's answer must have come from that change. Real
-- migrations are not still: they backfill, they record that they ran, they advance things. Those
-- writes move the gate's answer legitimately.
--
-- A harness that read its baseline BEFORE those permitted writes would see the answer move and
-- conclude the gate had noticed the damage -- when the movement came entirely from the permitted
-- write and the damage went unseen. The gate would be reported as working on the strength of
-- evidence about something else.
--
-- So `09_compatibility_writes.sql` runs first, the harness reads the gate's answer AFTER it, and
-- THEN this file renames a customer in place. Every count is identical across this file, the
-- permitted write is already in the baseline, and the only thing that can move the answer now is
-- the rename. If it does not move, the gate cannot see a customer being renamed and the run fails.
--
-- This runs at the END of the phase, on the disposable local database the harness resets straight
-- afterwards. It deliberately damages data; nothing here ever runs against a real database, and it
-- refuses to run at all unless the fixture it expects is in front of it.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_id      uuid;
  v_before  integer;
  v_after   integer;
  v_was     text;
  v_now     text;
  v_audits  integer;
begin
  if to_regclass('migration_chain.customer') is null then
    raise exception
      'counterexample 4 needs the populated v0.0.4 fixture: migration_chain.customer is missing';
  end if;

  -- The permitted writes must ALREADY have happened, or this file is just counterexample 1 again
  -- and proves nothing about the ordering it exists to prove.
  select count(*) into v_audits
    from public.audit_events
   where action = 'migration.compatibility_backfill';

  if v_audits = 0 then
    raise exception 'counterexample 4 must run AFTER 09_compatibility_writes.sql; without the '
                    'permitted write there is nothing for the rename to hide behind';
  end if;

  select count(*) into v_before from public.customers;
  select id into v_id from migration_chain.customer;
  select name into v_was from public.customers where id = v_id;

  update public.customers
     set name = 'Chain Builders (renamed behind a permitted write)'
   where id = v_id;

  if not found then
    raise exception 'counterexample 4 changed no customer, so it proves nothing about the gate';
  end if;

  select count(*) into v_after from public.customers;
  select name into v_now from public.customers where id = v_id;

  -- The name really moved. Counterexample 1 has already renamed this row once, so a file that
  -- wrote the same name twice would leave the answer identical and fail the run for a reason that
  -- had nothing to do with the gate.
  if v_now is not distinct from v_was then
    raise exception 'counterexample 4 wrote the name it found (%), so nothing changed and the '
                    'gate is being asked to notice a change that was never made', v_was;
  end if;

  -- The claim this file makes to the harness: the ONLY thing that moved is content. A count that
  -- moved as well would let the harness pass while seeing the count rather than the rename, which
  -- is precisely the mistake this counterexample is built to rule out.
  if v_after <> v_before then
    raise exception 'counterexample 4 changed the customer count from % to %, which is not the '
                    'same-count rewrite it is meant to be', v_before, v_after;
  end if;
end
$$;

commit;

\echo 'migration-chain: counterexample 4 renamed a customer behind a permitted write, counts intact'
