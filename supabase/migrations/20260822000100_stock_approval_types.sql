-- Stage 10D · The two approval types stock movements need
--
-- Alone in its own migration and NOT wrapped in an explicit transaction, for the reason migration
-- 20260812001300 records: PostgreSQL refuses to USE a new enum value in the transaction that adds
-- it, and the migration that follows uses both of these.
--
-- `stock_adjustment`, `accountability` and the imprest types were already declared in Stage 8A
-- (migration 000100) from product.md §4.1. These two were missed there because Stage 8A had no
-- inventory to approve. They are the same kind of thing and belong in the same enum:
--
--   · supplier_receipt — Manager approval, always required, before stock increases (§9.1)
--   · stock_transfer   — Manager approval, before balances change (§10)
--
-- Reusing `approval_requests` and `approval_decisions` rather than giving each module its own
-- status column is deliberate. §4.3 says a rejected, cancelled or expired record is a completed
-- decision and NOT an approval, and that every decision records actor, role, timestamp, reason and
-- outcome in append-only history. That rule is already implemented once, correctly, with a check
-- constraint that refuses to let a non-approved row carry an approver. A second implementation
-- would be a second chance to get it wrong.

alter type public.approval_type add value if not exists 'supplier_receipt' after 'stock_adjustment';
alter type public.approval_type add value if not exists 'stock_transfer'   after 'supplier_receipt';
