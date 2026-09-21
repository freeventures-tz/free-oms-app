-- Issue #48 · A receipt names a handover of its own funding, at that handover's amount
--
-- Raised on PR #49 by automated review. `imprest_fundings.received_handover_id` referenced the
-- handover by id alone, so the database accepted a received funding naming ANOTHER funding's
-- handover, or posting an amount that handover never carried. No reachable writer does either:
-- `api.staff_confirm_imprest_received` copies both from the current handover of the funding it
-- has locked. This makes the rule the database's own, for every writer, rather than one command's.
--
-- One composite foreign key covers both halves. The referenced unique key is (id, funding_id,
-- amount_tzs); `id` alone is already unique, so the key admits exactly the rows that exist.
-- MATCH SIMPLE skips the check while any column is null, and `funding_receipt_shape` keeps the
-- handover and amount null together until the funding is received, so it binds exactly receipts.
--
-- Additive only. It changes no command, no read model and no funding rule, and the handover table
-- is append-only, so the new unique index is never updated.

begin;

alter table public.imprest_funding_handovers
  add constraint imprest_funding_handovers_receipt_key unique (id, funding_id, amount_tzs);

alter table public.imprest_fundings
  add constraint imprest_fundings_receipt_matches_handover_fk
  foreign key (received_handover_id, id, received_amount_tzs)
  references public.imprest_funding_handovers (id, funding_id, amount_tzs);

-- The advisors ask every foreign key for an index that leads with its columns.
create index imprest_fundings_receipt_handover_idx
  on public.imprest_fundings (received_handover_id, id, received_amount_tzs);

comment on constraint imprest_fundings_receipt_matches_handover_fk on public.imprest_fundings is
  'A received funding names one of its own handovers and posts exactly that handover''s amount.';

commit;
