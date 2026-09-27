-- Issue #64 · Imprest spending, part 2b-1: the verified disbursement state
--
-- After the Cashier settles a disbursement, the Manager verifies it, which posts it. Verified is a
-- state of the disbursement, placed after `settled` in the order things happen, and it is final.
--
-- It has a migration of its own because PostgreSQL will not let a transaction use an enum label it
-- has just added. The next migration writes this label into a constraint and into function bodies,
-- so it must be committed first.

begin;

alter type public.imprest_disbursement_status add value if not exists 'verified' after 'settled';

comment on type public.imprest_disbursement_status is
  'The disbursement workflow of product.md §13.3. `approved`, `handed_out` and `settled` set money '
  'aside; `verified` has posted it and is final. Nothing else sets money aside.';

commit;
