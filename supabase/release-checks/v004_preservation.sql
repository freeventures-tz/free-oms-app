-- The v0.0.4 preservation query, for the v0.0.5 release gate
--
-- One row, one line, every figure the v0.0.5 migrations must leave exactly as they found it. The
-- harness runs THIS FILE before and after the upgrade and requires the two answers to be identical
-- character for character; the runbook pastes the same bytes into the hosted SQL Editor.
--
-- COUNTS AND DIGESTS TOGETHER. A count alone cannot see a row that was rewritten in place, and a
-- digest alone cannot be read by a person deciding whether to continue. Every digest is built over
-- an ORDERED aggregate, because `string_agg` has no order of its own and an unordered digest would
-- change between two runs of the same database.
--
-- `coalesce(..., '-')` on every digest, deliberately. `md5(null)` is null, null compares equal to
-- nothing including itself, and a gate reading one would pass every comparison it was ever given
-- while proving nothing — the empty-table case is exactly where that happens.

select
  (select count(*) from public.products)                                   as products,
  (select count(*) from public.product_prices)                             as prices,
  (select count(*) from public.units)                                      as units,
  (select count(*) from public.profiles)                                   as people,
  (select count(*) from public.user_roles)                                 as roles,
  (select count(*) from public.suppliers)                                  as suppliers,
  (select count(*) from public.storekeepers)                               as storekeepers,
  (select count(*) from public.stock_receipts)                             as receipts,
  (select count(*) from public.stock_transfers)                            as transfers,
  (select count(*) from public.stock_adjustments)                          as adjustments,
  (select count(*) from public.inventory_ledger)                           as ledger_rows,
  (select count(*) from public.customers)                                  as customers,
  (select count(*) from public.orders)                                     as orders,
  (select count(*) from public.order_lines)                                as order_lines,
  (select count(*) from public.proformas)                                  as proformas,
  (select count(*) from public.invoices)                                   as invoices,
  (select count(*) from public.stock_allocations)                          as allocations,
  (select count(*) from public.payments)                                   as payments,
  (select count(*) from public.credit_authorisations)                      as credits,
  (select count(*) from public.dispatches)                                 as dispatches,
  (select count(*) from public.dispatch_lines)                             as dispatch_lines,
  (select count(*) from public.document_sequences)                         as counters,
  (select count(*) from public.approval_requests)                          as approvals,
  (select count(*) from public.audit_events)                               as audit_events,

  -- Product identity, exactly as the Part C gate reads it.
  coalesce(md5(string_agg(p.name || '|' || coalesce(p.specification, '') || '|' || p.unit_code
                          || '|' || coalesce(p.unit_content, ''), E'\n' order by p.name,
                          coalesce(p.specification, ''), coalesce(p.unit_content, ''))), '-')
    as product_identity,

  -- Every price ever set, with who set it and why: §4.4 makes price history immutable.
  (select coalesce(md5(string_agg(pr.product_id::text || '|' || pr.price_tzs::text || '|'
                                  || pr.effective_at::text || '|' || pr.set_by::text,
                                  E'\n' order by pr.product_id, pr.entry_seq)), '-')
     from public.product_prices pr) as price_history,

  -- Identities and the role each person holds.
  (select coalesce(md5(string_agg(u.user_id::text || '|' || u.role::text,
                                  E'\n' order by u.user_id)), '-')
     from public.user_roles u) as identities,

  -- Every stock movement ever written, with its cause and its authoriser (AC-82).
  (select coalesce(md5(string_agg(l.entry_seq::text || '|' || l.product_id::text || '|'
                                  || l.location_code || '|' || l.stock_state::text || '|'
                                  || l.quantity_delta::text || '|' || l.movement_kind::text || '|'
                                  || coalesce(l.approved_by::text, ''),
                                  E'\n' order by l.entry_seq)), '-')
     from public.inventory_ledger l) as ledger,

  -- Orders, their invoices and what each one was billed.
  (select coalesce(md5(string_agg(o.order_no || '|' || o.status::text || '|'
                                  || coalesce(i.invoice_no, '') || '|'
                                  || coalesce(i.total_tzs::text, ''),
                                  E'\n' order by o.order_no)), '-')
     from public.orders o left join public.invoices i on i.order_id = o.id) as sales,

  -- What a customer has claimed and what has been handed over (§8.1).
  (select coalesce(md5(string_agg(a.order_line_id::text || '|' || a.state::text || '|'
                                  || a.quantity::text || '|' || a.released_quantity::text,
                                  E'\n' order by a.order_line_id, a.state)), '-')
     from public.stock_allocations a) as allocations_detail,

  -- Money received, and credit decided.
  (select coalesce(md5(string_agg(pay.invoice_id::text || '|' || pay.method::text || '|'
                                  || pay.amount_tzs::text,
                                  E'\n' order by pay.invoice_id, pay.received_at,
                                  pay.amount_tzs)), '-')
     from public.payments pay) as money,
  -- A credit authorisation and the approval that settled it: §12.5 keeps credit apart from the
  -- six tenders, and its outcome lives in the shared approval record.
  (select coalesce(md5(string_agg(c.invoice_id::text || '|' || c.amount_tzs::text || '|'
                                  || c.requested_role::text || '|'
                                  || coalesce(r.status::text, ''),
                                  E'
' order by c.invoice_id, c.amount_tzs)), '-')
     from public.credit_authorisations c
     left join public.approval_requests r
            on r.entity_type = 'credit_authorisation' and r.entity_id = c.id) as credit,

  -- Dispatch, and the note number on the paper it was released against (§14).
  (select coalesce(md5(string_agg(d.id::text || '|' || d.status::text || '|'
                                  || coalesce(d.dispatch_note_no, '') || '|' || d.source_location,
                                  E'\n' order by d.id)), '-')
     from public.dispatches d) as dispatch,

  -- The daily counters, which must not be reset or renumbered by a migration.
  (select coalesce(md5(string_agg(s.kind || '|' || s.business_date::text || '|'
                                  || s.next_value::text, E'\n' order by s.kind,
                                  s.business_date)), '-')
     from public.document_sequences s) as counters_detail
from public.products p;
