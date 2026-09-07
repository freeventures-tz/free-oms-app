-- v0.0.5 . Migration chain: the permitted writes counterexample 4 hides behind
--
-- NOT A COUNTEREXAMPLE. Nothing here is damage, and nothing here is supposed to be refused. This is
-- the ordinary, legitimate writing a migration does on its way past: it records that it ran.
--
-- WHY IT EXISTS. The preservation gate compares an answer before a change with the same answer
-- after it and requires them to differ when a counterexample has damaged something. If the
-- "before" reading is taken too early, ANY later movement in the answer looks like the gate
-- working -- including movement caused by a permitted write, while the damage alongside it went
-- completely unseen. That is a gate reporting success for a reason unrelated to what it tested.
--
-- So this file runs FIRST, the harness reads the gate's answer AFTER it, and only then does
-- `10_counterexample_masked_rename.sql` rename a customer in place. The permitted write is already
-- inside the baseline, so the only thing left that can move the answer is the rename.
--
-- These writes MOVE THE ANSWER LEGITIMATELY: `audit_events` is one of the counts the preservation
-- query reads. That is the point. A compatibility write nobody could see would mask nothing and
-- would prove nothing about the ordering.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_before integer;
  v_after  integer;
  v_name_before text;
  v_name_after  text;
begin
  if to_regclass('migration_chain.customer') is null then
    raise exception
      'the compatibility writes need the populated v0.0.4 fixture: migration_chain.customer is missing';
  end if;

  select count(*) into v_before from public.audit_events;

  select c.name into v_name_before
    from public.customers c
   where c.id = (select id from migration_chain.customer);

  -- A migration recording its own passage, with no end user behind it. `is_system_actor` with a
  -- null `actor_id` is the shape the audit constraint requires of a trusted job.
  insert into public.audit_events
    (actor_id, actor_role, is_system_actor, action, entity_type, correlation_id, source_operation)
  values
    (null, null, true, 'migration.compatibility_backfill', 'migration',
     gen_random_uuid(), 'migration-chain counterexample 4');

  select count(*) into v_after from public.audit_events;

  -- The claim this file makes to the harness: it really does move the gate's answer. A run where
  -- it did not would leave counterexample 4 proving nothing about ordering at all, and the harness
  -- could then pass for the wrong reason in the one place it is checking that it cannot.
  if v_after <= v_before then
    raise exception 'the compatibility writes moved no count (% to %), so they cannot mask '
                    'anything and counterexample 4 would prove nothing', v_before, v_after;
  end if;

  -- AND THEY MUST NOT TOUCH THE CUSTOMER. If a "permitted" write changed the very record the next
  -- file rewrites, the two changes would be indistinguishable and the ordering would be untestable.
  select c.name into v_name_after
    from public.customers c
   where c.id = (select id from migration_chain.customer);

  if v_name_after is distinct from v_name_before then
    raise exception 'the compatibility writes renamed the customer (% to %) they are meant only '
                    'to hide, so counterexample 4 could no longer tell the two apart',
                    v_name_before, v_name_after;
  end if;
end
$$;

commit;

\echo 'migration-chain: the permitted writes ran, and the gate answer moved because of them'
