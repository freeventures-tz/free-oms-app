-- Issue #62 · Imprest spending, part 2a: the two new disbursement states
--
-- After the Manager approves a disbursement, the Cashier hands the cash out and later settles it.
-- Both steps are states of the disbursement, placed after `approved` in the order they happen.
--
-- They have a migration of their own because PostgreSQL will not let a transaction use an enum
-- label it has just added. The next migration writes these labels into a constraint and into
-- function bodies, so they must be committed first.

begin;

alter type public.imprest_disbursement_status add value if not exists 'handed_out' after 'approved';
alter type public.imprest_disbursement_status add value if not exists 'settled' after 'handed_out';

comment on type public.imprest_disbursement_status is
  'The disbursement workflow of product.md §13.3. `approved`, `handed_out` and `settled` set money '
  'aside; nothing else does. Verification (part 2b) comes after `settled`.';

commit;
