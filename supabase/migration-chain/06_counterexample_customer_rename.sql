-- v0.0.5 · Migration chain, counterexample 1: a record rewritten in place, with every count intact
--
-- WHY THESE FILES EXIST. The preservation gate compares one answer before an upgrade with the same
-- answer after it and requires them to be identical. That is only worth something if the answer can
-- MOVE. A gate built from counts alone passes a migration that renamed every customer in the
-- business, and the review of PR #28 demonstrated exactly that: the reviewer ran the gate's own
-- query, renamed one existing customer, ran it again, and got a character-for-character identical
-- result. So each counterexample makes one change of a kind a bad migration could really make, and
-- the harness requires the gate's answer to CHANGE. A counterexample that passed unnoticed is the
-- finding, not a test failure to be explained away.
--
-- These run at the END of the phase, on the disposable local database the harness resets straight
-- afterwards. They deliberately damage data, which is the whole point; nothing here ever runs
-- against a real database, and the file refuses to run at all unless the fixture it expects is the
-- one in front of it.
--
-- THIS ONE: one existing customer renamed. No row is added, none is removed, and no other table is
-- touched — so every count in the preservation query is identical afterwards and only a comparison
-- of the CONTENTS can see it.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_id     uuid;
  v_before integer;
  v_after  integer;
begin
  if to_regclass('migration_chain.customer') is null then
    raise exception
      'counterexample 1 needs the populated v0.0.4 fixture: migration_chain.customer is missing';
  end if;

  select count(*) into v_before from public.customers;

  select id into v_id from migration_chain.customer;

  update public.customers
     set name = 'Chain Builders (renamed by counterexample 1)'
   where id = v_id;

  if not found then
    raise exception 'counterexample 1 changed no customer, so it proves nothing about the gate';
  end if;

  select count(*) into v_after from public.customers;

  -- The claim this file makes to the harness: the ONLY thing that moved is content. If a count
  -- moved as well, the harness could pass for the wrong reason and the counterexample would be
  -- proving that a count still works.
  if v_after <> v_before then
    raise exception 'counterexample 1 changed the customer count from % to %, which is not the '
                    'same-count rewrite it is meant to be', v_before, v_after;
  end if;
end
$$;

commit;

\echo 'migration-chain: counterexample 1 renamed one existing customer, leaving every count intact'
