-- The v0.1.0 preservation query, for the reporting release gate (issue #51)
--
-- One row, one line, every figure the two reporting migrations must leave exactly as they found it.
-- The migration-chain harness runs THIS FILE before and after the upgrade and requires the two
-- answers to be identical character for character.
--
-- IT IS THE v0.0.5 QUERY, UNCHANGED, PLUS TWO THINGS. First what v0.1.0 added: imprest funding and
-- its append-only history. Second, the released surface itself — grants, policies, constraints,
-- triggers and function bodies of every object that existed before the report — because the
-- reporting migrations write no business row at all, and the realistic way for them to damage a
-- release is to re-grant, re-issue or re-constrain something rather than to change data.
--
-- The v0.0.5 query's own header follows, kept because every line below it still means what it
-- says there.
--
-- The v0.0.5 preservation query, for the v0.0.6 release gate (issue #7)
--
-- One row, one line, every figure the two v0.0.6 migrations must leave exactly as they found it.
-- The harness runs THIS FILE before and after the upgrade and requires the two answers to be
-- identical character for character; the runbook pastes the same bytes into the hosted SQL Editor.
--
-- IT IS THE v0.0.4 QUERY PLUS WHAT v0.0.5 ADDED. The reasoning behind every line of it is written
-- out in `v004_preservation.sql` and is not repeated here: counts AND digests, ordered aggregates,
-- a tie-free order key, `coalesce(..., '-')` so an empty table cannot compare equal to nothing,
-- and content columns rather than identity alone. What is new is the ground v0.0.5 broke —
-- brick production — and the idempotency ledger, because migration 36 re-issues sixteen commands
-- and a replay that stopped being recognised would be a silent double movement of stock.
--
-- WHY THIS BOUNDARY IS THE INTERESTING ONE. Migration 36 moves sixteen `api` functions into
-- `private` and builds new wrappers over them. Nothing it does should touch a single row, and this
-- query is what says so rather than assuming it.
select
  (select count(*) from public.production_batches)                        as batches,
  (select count(*) from public.production_batch_inputs)                   as batch_inputs,
  (select count(*) from public.production_lots)                           as lots,
  (select count(*) from public.production_recipe_inputs)                  as recipe_inputs,
  (select count(*) from public.production_yield_ranges)                   as yield_ranges,
  (select count(*) from public.idempotency_keys)                          as idempotency_keys,
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
  (select count(*) from public.stock_receipt_lines)                        as receipt_lines,
  (select count(*) from public.stock_transfer_lines)                       as transfer_lines,
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
  (select count(*) from public.approval_decisions)                         as decisions,
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

  -- Identities and the role each person holds, WITH who granted it: §3.1 gives one live role per
  -- person and the grant is part of the record, not decoration on it.
  (select coalesce(md5(string_agg(u.user_id::text || '|' || u.role::text || '|'
                                  || coalesce(u.assigned_by::text, ''),
                                  E'\n' order by u.user_id)), '-')
     from public.user_roles u) as identities,

  -- The people themselves. `identities` above says who holds which role; this says who they ARE,
  -- including the first-login gate and the active flag every authorisation check reads.
  (select coalesce(md5(string_agg(pf.id::text || '|' || pf.full_name || '|' || pf.phone_e164
                                  || '|' || pf.locale || '|' || pf.is_active::text
                                  || '|' || pf.must_change_password::text,
                                  E'\n' order by pf.id)), '-')
     from public.profiles pf) as people_detail,

  -- Who goods came from (§9). Deactivated rather than deleted, so a rewritten name is the only way
  -- one can change at all — and a receipt from a year ago names it permanently.
  (select coalesce(md5(string_agg(s.id::text || '|' || s.name || '|' || s.is_active::text
                                  || '|' || s.created_by::text,
                                  E'\n' order by s.id)), '-')
     from public.suppliers s) as suppliers_detail,

  -- People who move goods but do not use the system (§3.2). Every dispatch names one permanently.
  (select coalesce(md5(string_agg(k.id::text || '|' || k.storekeeper_code || '|' || k.full_name
                                  || '|' || coalesce(k.phone, '') || '|' || k.is_active::text
                                  || '|' || k.start_date::text || '|'
                                  || coalesce(k.deactivated_at::text, '') || '|'
                                  || coalesce(k.note, '') || '|' || k.created_by::text,
                                  E'\n' order by k.id)), '-')
     from public.storekeepers k) as storekeepers_detail,

  -- WHO AN ORDER IS FOR. The reviewer's counterexample was exactly this column: one existing
  -- customer renamed, every count identical, and the gate saw nothing.
  (select coalesce(md5(string_agg(cu.id::text || '|' || cu.name || '|' || cu.is_active::text
                                  || '|' || cu.is_cash_customer::text || '|'
                                  || coalesce(cu.created_by::text, ''),
                                  E'\n' order by cu.id)), '-')
     from public.customers cu) as customers_detail,

  -- A delivery and the lines on it, each keyed so two runs agree on the order.
  (select coalesce(md5(string_agg(r.id::text || '|' || r.supplier_id::text || '|'
                                  || r.location_code || '|'
                                  || coalesce(r.delivery_note_ref, '') || '|'
                                  || r.delivery_date::text || '|' || r.entered_by::text || '|'
                                  || r.entered_role::text,
                                  E'\n' order by r.id)), '-')
     from public.stock_receipts r) as receipts_detail,

  (select coalesce(md5(string_agg(rl.receipt_id::text || '|' || rl.product_id::text || '|'
                                  || rl.expected_quantity::text || '|'
                                  || rl.received_quantity::text || '|'
                                  || rl.damaged_quantity::text || '|'
                                  || coalesce(rl.damage_note, '') || '|'
                                  || rl.accepted_quantity::text,
                                  E'\n' order by rl.receipt_id, rl.product_id, rl.id)), '-')
     from public.stock_receipt_lines rl) as receipt_lines_detail,

  -- An internal move, and what it moved.
  (select coalesce(md5(string_agg(tr.id::text || '|' || tr.from_location || '|' || tr.to_location
                                  || '|' || coalesce(tr.note, '') || '|' || tr.entered_by::text
                                  || '|' || tr.entered_role::text,
                                  E'\n' order by tr.id)), '-')
     from public.stock_transfers tr) as transfers_detail,

  (select coalesce(md5(string_agg(tl.transfer_id::text || '|' || tl.product_id::text || '|'
                                  || tl.quantity::text,
                                  E'\n' order by tl.transfer_id, tl.product_id, tl.id)), '-')
     from public.stock_transfer_lines tl) as transfer_lines_detail,

  -- A correction somebody had to justify, with the person who made it (§10).
  (select coalesce(md5(string_agg(adj.id::text || '|' || adj.product_id::text || '|'
                                  || adj.location_code || '|' || adj.quantity_delta::text || '|'
                                  || adj.reason || '|' || adj.entered_by::text || '|'
                                  || adj.entered_role::text,
                                  E'\n' order by adj.id)), '-')
     from public.stock_adjustments adj) as adjustments_detail,

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

  -- The order itself: who it is for, what it is worth being asked at, and who created it. The
  -- `sales` digest above pairs an order number with its invoice; this is the record underneath it.
  (select coalesce(md5(string_agg(o.id::text || '|' || o.order_no || '|' || o.customer_id::text
                                  || '|' || o.status::text || '|' || o.is_cash_sale::text || '|'
                                  || o.discount_percent::text || '|'
                                  || coalesce(o.discount_reason, '') || '|' || o.created_by::text
                                  || '|' || o.created_role::text || '|'
                                  || coalesce(o.cancel_reason, ''),
                                  E'\n' order by o.id)), '-')
     from public.orders o) as orders_detail,

  -- WHAT IS BEING SOLD, at the price approved when the order was created. A line quietly rewritten
  -- changes what a customer owes without changing how many lines exist.
  (select coalesce(md5(string_agg(ol.order_id::text || '|' || ol.product_id::text || '|'
                                  || ol.quantity::text || '|' || ol.unit_price_tzs::text || '|'
                                  || ol.line_total_tzs::text,
                                  E'\n' order by ol.order_id, ol.product_id)), '-')
     from public.order_lines ol) as order_lines_detail,

  -- Every quotation version ever issued, superseded ones included: §12.1 keeps the old one rather
  -- than overwriting it, so the history is the record.
  (select coalesce(md5(string_agg(pf2.order_id::text || '|' || pf2.version::text || '|'
                                  || pf2.proforma_no || '|' || pf2.subtotal_tzs::text || '|'
                                  || pf2.discount_tzs::text || '|' || pf2.total_tzs::text || '|'
                                  || pf2.valid_until::text || '|' || pf2.issued_by::text || '|'
                                  || (pf2.superseded_at is not null)::text,
                                  E'\n' order by pf2.order_id, pf2.version)), '-')
     from public.proformas pf2) as proformas_detail,

  -- THE FINANCIAL RECORD, with its settlement attribution. §12.6 step 7 makes the Cashier's
  -- confirmation the thing that lets goods be handed over, so who confirmed it and when are part of
  -- the invoice — and an invoice digest that omitted them would pass a migration that reassigned
  -- every settlement in the business.
  (select coalesce(md5(string_agg(inv.id::text || '|' || inv.invoice_no || '|'
                                  || inv.order_id::text || '|' || inv.customer_id::text || '|'
                                  || inv.subtotal_tzs::text || '|' || inv.discount_tzs::text || '|'
                                  || inv.total_tzs::text || '|' || inv.business_date::text || '|'
                                  || coalesce(inv.cancelled_at::text, '') || '|'
                                  || coalesce(inv.cancel_reason, '') || '|'
                                  || coalesce(inv.settlement_approved_by::text, '') || '|'
                                  || coalesce(inv.settlement_approved_at::text, ''),
                                  E'\n' order by inv.id)), '-')
     from public.invoices inv) as invoices_detail,

  -- What a customer has claimed and what has been handed over (§8.1).
  (select coalesce(md5(string_agg(a.order_line_id::text || '|' || a.state::text || '|'
                                  || a.quantity::text || '|' || a.released_quantity::text,
                                  E'\n' order by a.order_line_id, a.state)), '-')
     from public.stock_allocations a) as allocations_detail,

  -- MONEY RECEIVED, AND THE ROW EACH REVERSAL UNDOES.
  --
  -- `reverses_id` is what makes a negative row a reversal of one specific payment rather than an
  -- unexplained deduction, and §4.1/AC-21 put a Director's decision behind it. A digest without it
  -- passes a migration that repointed every reversal at the wrong payment: the count is the same,
  -- the amounts are the same, and the money now cancels somebody else's till. `entry_seq` orders
  -- the aggregate outright, because two payments written by one command share a timestamp.
  (select coalesce(md5(string_agg(pay.id::text || '|' || pay.invoice_id::text || '|'
                                  || pay.method::text || '|' || pay.amount_tzs::text || '|'
                                  || coalesce(pay.reverses_id::text, '') || '|'
                                  || pay.received_by::text || '|' || pay.received_role::text
                                  || '|' || pay.business_date::text,
                                  E'\n' order by pay.entry_seq)), '-')
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

  -- WHAT WAS ON THE NOTE. A dispatch says goods left; its lines say which goods and how many, and
  -- §14 makes the signed note the document somebody is asked about afterwards.
  (select coalesce(md5(string_agg(dl.dispatch_id::text || '|' || dl.allocation_id::text || '|'
                                  || dl.product_id::text || '|' || dl.quantity::text,
                                  E'\n' order by dl.dispatch_id, dl.allocation_id, dl.id)), '-')
     from public.dispatch_lines dl) as dispatch_lines_detail,

  -- Who was asked, for how much, and who answered. Credit, discounts and payment reversals all
  -- settle here, so this is where an approval that was never given would appear.
  (select coalesce(md5(string_agg(ar.id::text || '|' || ar.entity_type::text || '|'
                                  || ar.entity_id::text || '|' || ar.approval_type::text || '|'
                                  || ar.request_seq::text || '|' || ar.requested_by::text || '|'
                                  || ar.requested_role::text || '|'
                                  || coalesce(ar.requested_amount::text, '') || '|'
                                  || coalesce(ar.requested_percent::text, '') || '|'
                                  || ar.required_role::text || '|' || ar.status::text || '|'
                                  || coalesce(ar.approved_by::text, '') || '|'
                                  || coalesce(ar.approved_role::text, ''),
                                  E'\n' order by ar.id)), '-')
     from public.approval_requests ar) as approvals_detail,

  (select coalesce(md5(string_agg(ad.id::text || '|' || ad.request_id::text || '|'
                                  || ad.outcome::text || '|' || ad.decided_by::text || '|'
                                  || ad.decided_role::text || '|'
                                  || coalesce(ad.reason_code, '') || '|'
                                  || coalesce(ad.note, '') || '|'
                                  || coalesce(ad.supersedes_decision_id::text, ''),
                                  E'\n' order by ad.id)), '-')
     from public.approval_decisions ad) as decisions_detail,

  -- The daily counters, which must not be reset or renumbered by a migration.
  (select coalesce(md5(string_agg(s.kind || '|' || s.business_date::text || '|'
                                  || s.next_value::text, E'\n' order by s.kind,
                                  s.business_date)), '-')
     from public.document_sequences s) as counters_detail,
  -- A BATCH, and the decision that consumed the yard (§11.1). `decided_by` and `decision_reason`
  -- are the columns a migration could quietly rewrite and leave every count where it was.
  (select coalesce(md5(string_agg(b.id::text || '|' || b.batch_no || '|' || b.location_code
                                  || '|' || b.status::text || '|' || b.moulded_at::text || '|'
                                  || coalesce(b.yield_note, '') || '|' || b.entered_by::text
                                  || '|' || b.entered_role::text || '|'
                                  || coalesce(b.decided_by::text, '') || '|'
                                  || coalesce(b.decided_role::text, '') || '|'
                                  || coalesce(b.decision_reason, ''),
                                  E'
' order by b.id)), '-')
     from public.production_batches b) as batches_detail,

  -- WHAT A BATCH ACTUALLY USED (§11.1, AC-39): the standard, the actual and the variance are three
  -- separate facts, and the actual is the one this whole release exists to protect.
  (select coalesce(md5(string_agg(bi.batch_id::text || '|' || bi.product_id::text || '|'
                                  || bi.standard_quantity::text || '|' || bi.actual_quantity::text
                                  || '|' || bi.variance_quantity::text,
                                  E'
' order by bi.batch_id, bi.product_id, bi.id)), '-')
     from public.production_batch_inputs bi) as batch_inputs_detail,

  -- Curing and inspection (§11.4, AC-44, AC-45): when the clock started, who inspected, and how
  -- many of the bricks became sellable.
  (select coalesce(md5(string_agg(lo.id::text || '|' || lo.batch_id::text || '|'
                                  || lo.product_id::text || '|' || lo.quantity_moulded::text
                                  || '|' || lo.rejected_at_moulding::text || '|'
                                  || coalesce(lo.moulding_reject_reason::text, '') || '|'
                                  || lo.curing_started_at::text || '|'
                                  || coalesce(lo.inspected_at::text, '') || '|'
                                  || coalesce(lo.inspected_by::text, '') || '|'
                                  || coalesce(lo.inspected_role::text, '') || '|'
                                  || coalesce(lo.accepted_quantity::text, '') || '|'
                                  || coalesce(lo.rejected_at_inspection::text, '') || '|'
                                  || coalesce(lo.inspection_reject_reason::text, ''),
                                  E'
' order by lo.id)), '-')
     from public.production_lots lo) as lots_detail,

  -- The reference recipe and the yield ranges migration 33 installed. A migration that quietly
  -- re-seeded either would change what every future batch is measured against.
  (select coalesce(md5(string_agg(ri.product_id::text || '|' || ri.standard_quantity::text
                                  || '|' || ri.sort_order::text,
                                  E'
' order by ri.product_id)), '-')
     from public.production_recipe_inputs ri) as recipe_detail,

  (select coalesce(md5(string_agg(yr.product_id::text || '|' || yr.min_per_batch::text || '|'
                                  || yr.max_per_batch::text,
                                  E'
' order by yr.product_id)), '-')
     from public.production_yield_ranges yr) as yields_detail,

  -- THE REPLAY LEDGER. Migration 36 re-issues sixteen commands; a key that stopped matching its
  -- operation or its recorded request would turn a retry into a second movement of stock.
  (select coalesce(md5(string_agg(ik.key || '|' || ik.operation || '|'
                                  || coalesce(ik.result_ref::text, '') || '|'
                                  || ik.created_by::text || '|'
                                  || coalesce(ik.request::text, ''),
                                  E'
' order by ik.key)), '-')
     from public.idempotency_keys ik) as idempotency_detail,

  -- ---------------------------------------------------------------------------------------------
  -- WHAT v0.1.0 ADDED: IMPREST FUNDING (issue #48). Every history table in full, because the
  -- approvals, handovers and mismatches are append-only by trigger and the receipt is the one row
  -- that posts money. A migration that touched any of them would change a figure a Director has
  -- already been shown.
  -- ---------------------------------------------------------------------------------------------
  (select count(*) from public.imprest_funds)                               as imprest_funds,
  (select count(*) from public.imprest_fundings)                            as imprest_fundings,
  (select count(*) from public.imprest_funding_approvals)                   as imprest_approvals,
  (select count(*) from public.imprest_funding_handovers)                   as imprest_handovers,
  (select count(*) from public.imprest_funding_mismatches)                  as imprest_mismatches,

  (select coalesce(md5(string_agg(f.id::text || '|' || f.opened_by::text || '|'
                                  || f.opened_at::text || '|' || f.is_active::text,
                                  E'\n' order by f.id)), '-')
     from public.imprest_funds f) as imprest_funds_detail,

  (select coalesce(md5(string_agg(fu.id::text || '|' || fu.funding_no || '|' || fu.fund_id::text
                                  || '|' || fu.status::text || '|' || fu.version::text || '|'
                                  || fu.requested_amount_tzs::text || '|' || fu.reason || '|'
                                  || fu.requested_by::text || '|' || fu.requested_at::text || '|'
                                  || coalesce(fu.rejected_by::text, '') || '|'
                                  || coalesce(fu.rejected_at::text, '') || '|'
                                  || coalesce(fu.rejection_reason, '') || '|'
                                  || coalesce(fu.received_handover_id::text, '') || '|'
                                  || coalesce(fu.received_amount_tzs::text, '') || '|'
                                  || coalesce(fu.received_by::text, '') || '|'
                                  || coalesce(fu.received_at::text, ''),
                                  E'\n' order by fu.id)), '-')
     from public.imprest_fundings fu) as imprest_fundings_detail,

  (select coalesce(md5(string_agg(a.id::text || '|' || a.funding_id::text || '|'
                                  || a.sequence::text || '|' || a.amount_tzs::text || '|'
                                  || coalesce(a.note, '') || '|' || a.approved_by::text || '|'
                                  || a.approved_at::text,
                                  E'\n' order by a.funding_id, a.sequence)), '-')
     from public.imprest_funding_approvals a) as imprest_approvals_detail,

  (select coalesce(md5(string_agg(h.id::text || '|' || h.funding_id::text || '|'
                                  || h.cycle::text || '|' || h.amount_tzs::text || '|'
                                  || coalesce(h.explanation, '') || '|' || h.provided_by::text
                                  || '|' || h.provided_at::text,
                                  E'\n' order by h.funding_id, h.cycle)), '-')
     from public.imprest_funding_handovers h) as imprest_handovers_detail,

  (select coalesce(md5(string_agg(m.id::text || '|' || m.funding_id::text || '|'
                                  || m.handover_id::text || '|' || m.counted_tzs::text || '|'
                                  || coalesce(m.note, '') || '|' || m.reported_by::text || '|'
                                  || m.reported_at::text,
                                  E'\n' order by m.id)), '-')
     from public.imprest_funding_mismatches m) as imprest_mismatches_detail,

  -- ---------------------------------------------------------------------------------------------
  -- THE RELEASED SURFACE ITSELF, not only its rows (issue #51). A reporting migration must add its
  -- own objects and leave every released one exactly as it was: the same grants, the same
  -- policies, the same constraints and triggers, and the same function bodies — so a command that
  -- was quietly re-issued with an older body would move this line even though no row changed.
  -- The reporting objects are excluded BY NAME, so this reads the same on both sides.
  -- ---------------------------------------------------------------------------------------------
  (select coalesce(md5(string_agg(g.grantee || '|' || g.table_schema || '.' || g.table_name
                                  || '|' || g.privilege_type,
                                  E'\n' order by g.grantee, g.table_schema, g.table_name,
                                  g.privilege_type)), '-')
     from information_schema.role_table_grants g
    where g.table_schema in ('public', 'api', 'private')
      and g.table_name !~ '^(report_|daily_reports$)') as released_table_grants,

  (select coalesce(md5(string_agg(pol.schemaname || '.' || pol.tablename || '|' || pol.policyname
                                  || '|' || pol.cmd || '|' || array_to_string(pol.roles, ',')
                                  || '|' || coalesce(pol.qual, '') || '|'
                                  || coalesce(pol.with_check, ''),
                                  E'\n' order by pol.schemaname, pol.tablename, pol.policyname)),
                   '-')
     from pg_policies pol
    where pol.schemaname = 'public'
      and pol.tablename !~ '^report_') as released_policies,

  (select coalesce(md5(string_agg(t.relname || '|' || c.conname || '|'
                                  || pg_get_constraintdef(c.oid),
                                  E'\n' order by t.relname, c.conname)), '-')
     from pg_constraint c
     join pg_class t     on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname !~ '^report_') as released_constraints,

  (select coalesce(md5(string_agg(t.relname || '|' || tg.tgname || '|' || tg.tgenabled::text
                                  || '|' || pg_get_triggerdef(tg.oid),
                                  E'\n' order by t.relname, tg.tgname)), '-')
     from pg_trigger tg
     join pg_class t     on t.oid = tg.tgrelid
     join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and not tg.tgisinternal
      and t.relname !~ '^report_') as released_triggers,

  (select coalesce(md5(string_agg(n.nspname || '.' || p.proname || '('
                                  || pg_get_function_identity_arguments(p.oid) || ')|'
                                  || pg_get_userbyid(p.proowner) || '|'
                                  || p.prosecdef::text || '|'
                                  || coalesce(array_to_string(p.proconfig, ','), '') || '|'
                                  || coalesce(array_to_string(p.proacl, ','), '') || '|'
                                  || md5(p.prosrc),
                                  E'\n' order by n.nspname, p.proname,
                                  pg_get_function_identity_arguments(p.oid))), '-')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'api', 'private')
      and p.proname not in ('report_reconciliation_state', 'report_content',
                            'generate_scheduled_report', 'claim_report_attempt',
                            'complete_report_run', 'fail_report_run',
                            'raise_report_failure_alert', 'run_report_attempt',
                            'run_scheduled_report', 'stamp_report_digest',
                            'refuse_report_snapshot_change')) as released_functions
from public.products p;
