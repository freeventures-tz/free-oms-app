-- Issue #65 · Imprest spending, part 2b-2: the sent-back disbursement state
--
-- The Manager may send a settled disbursement's latest settlement back to the Cashier with a
-- reason. Until the Cashier settles again, the disbursement is `sent_back`: still set aside, still
-- awaiting verification, and open to new receipts. It sits after `settled` in the order things
-- happen, because it is only ever reached from there.
--
-- It has a migration of its own because PostgreSQL will not let a transaction use an enum label it
-- has just added. The next migration writes this label into a constraint and into function bodies,
-- so it must be committed first.

begin;

alter type public.imprest_disbursement_status add value if not exists 'sent_back' after 'settled';

comment on type public.imprest_disbursement_status is
  'The disbursement workflow of product.md §13.3. `approved`, `handed_out`, `settled` and '
  '`sent_back` set money aside; `verified` has posted it and is final. Nothing else sets money aside.';

commit;
