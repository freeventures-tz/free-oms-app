-- Issue #82 · The daily report states the imprest position truthfully
--
-- product.md §13, §15.2a and §18.3. The report's imprest section was written before imprest
-- spending (v0.3.0 to v0.6.0) and the daily count (v0.7.0) existed, and no release updated it: it
-- withheld the expenses and the balance as "imprest spending is not in the system yet", and reported
-- the imprest count as Not counted every night, including nights the Manager confirmed it. From this
-- migration a NEW report reads what the fund has released. A report already written is a stored,
-- immutable snapshot and is not touched: it keeps its old wording and still opens.
--
--   private.report_imprest_section(date)   NEW. The imprest section for one business date.
--   private.report_content(date)           REPLACED. The same body, with the imprest section read
--                                           from the function above instead of written inline.
--
-- THE SNAPSHOT SCHEMA DOES NOT CHANGE. It stays version 1: every key the reader knows keeps its
-- meaning, and what is new is additive. The digest, the immutability triggers, the claim, the lease
-- and the once-per-day schedule are not touched.
--
-- WHAT THE SECTION SAYS, EVERY FIGURE AS AT THE CUTOFF (midnight at the end of the business date in
-- Africa/Dar_es_Salaam), so rebuilding a day gives the same content whatever happened since:
--
--   THE FUND is the one whose business days include the date: opened on or before it, and either
--   still active or with its last count day on or after it, the earliest such. That is the fund the
--   imprest screen counted that day, and it stays the same after a later retirement opens a new one.
--   No such fund is `no_fund`, with the expenses and the balance withheld as `no_imprest_fund`.
--
--   FUNDING is unchanged: requests made on the day and receipts the Manager confirmed on it.
--
--   APPROVED EXPENSES are the postings of the day: verified expenses (`count`, `amount_tzs`), the
--   reversals and replacements of expenses posted that day, the net of the three, and the net
--   unexplained losses. A posting belongs to the day its row was posted.
--
--   THE POSITION is the posted balance (opening balance, confirmed funding, postings and confirmed
--   count variances), set aside, Free to approve, Awaiting verification and expected cash, each
--   rebuilt from the rows dated before the cutoff, the same arithmetic as
--   `private.imprest_spending_figures` and `private.imprest_awaiting_verification_tzs`.
--
--   THE COUNT is the day's latest count entered before the cutoff, as it stood then: confirmed
--   before the cutoff reads its outcome, Balanced, Shortage or Excess, with its figures and reason;
--   waiting reads Awaiting Manager confirmation with what was counted and expected; sent back, or no
--   count at all, reads Not counted with null amounts and a stated reason. Never a zero.
--
-- Nothing here writes, and nothing defines a new imprest rule. The functions are private and no
-- Data API role may execute them.

begin;

-- ---------------------------------------------------------------------------
-- private.report_imprest_section — the imprest section of one business date
-- ---------------------------------------------------------------------------
create or replace function private.report_imprest_section(p_business_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from      timestamptz := (p_business_date::timestamp)       at time zone 'Africa/Dar_es_Salaam';
  v_to        timestamptz := ((p_business_date + 1)::timestamp) at time zone 'Africa/Dar_es_Salaam';
  v_fund_id   uuid;
  v_funding   jsonb;
  v_expenses  jsonb;
  v_posted    bigint;
  v_aside     bigint;
  v_awaiting  bigint;
  v_count     record;
  v_state     jsonb;
begin
  select f.id
    into v_fund_id
    from public.imprest_funds f
   where private.imprest_business_date_of(f.opened_at) <= p_business_date
     and (f.retired_at is null or private.imprest_last_count_day(f.id) >= p_business_date)
   order by f.opened_at, f.id
   limit 1;

  if v_fund_id is null then
    -- No fund covered the day: an absence of information, not a balanced fund.
    return jsonb_build_object(
      'fund_no',           null,
      'fund_id',           null,
      'state',             'no_fund',
      'funding',           null,
      'approved_expenses', null,
      'position',          null,
      'unavailable',       jsonb_build_object('approved_expenses', 'no_imprest_fund',
                                              'position',          'no_imprest_fund'),
      'reconciliation',    private.report_reconciliation_state(
                             'not_counted', null, null, null, null, 'no_imprest_fund'));
  end if;

  -- FUNDING, as issue #51 reported it.
  select jsonb_build_object(
           'requested_count',
             count(*) filter (where fu.requested_at >= v_from and fu.requested_at < v_to),
           'requested_tzs',
             coalesce(sum(fu.requested_amount_tzs) filter (
               where fu.requested_at >= v_from and fu.requested_at < v_to), 0),
           'approved_tzs',  null,
           'provided_tzs',  null,
           'received_tzs',
             coalesce(sum(fu.received_amount_tzs) filter (
               where fu.status = 'received'
                 and fu.received_at >= v_from and fu.received_at < v_to), 0),
           'unavailable', jsonb_build_object(
             'approved_tzs', 'funding_aggregation_deferred',
             'provided_tzs', 'funding_aggregation_deferred'))
    into v_funding
    from public.imprest_fundings fu
   where fu.fund_id = v_fund_id
     and ((fu.requested_at >= v_from and fu.requested_at < v_to)
       or (fu.received_at  >= v_from and fu.received_at  < v_to));

  -- APPROVED EXPENSES: the day's postings. A reversal cancels in full, so it counts against.
  select jsonb_build_object(
           'count',
             count(*) filter (where p.kind = 'expense' and p.entry = 'original'),
           'amount_tzs',
             coalesce(sum(p.amount_tzs) filter (where p.kind = 'expense' and p.entry = 'original'), 0),
           'reversed_tzs',
             coalesce(sum(p.amount_tzs) filter (where p.kind = 'expense' and p.entry = 'reversal'), 0),
           'replacement_tzs',
             coalesce(sum(p.amount_tzs) filter (where p.kind = 'expense' and p.entry = 'replacement'), 0),
           'net_tzs',
             coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs else p.amount_tzs end)
                        filter (where p.kind = 'expense'), 0),
           'unexplained_loss_tzs',
             coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs else p.amount_tzs end)
                        filter (where p.kind = 'unexplained_loss'), 0))
    into v_expenses
    from public.imprest_postings p
   where p.fund_id = v_fund_id
     and p.posted_at >= v_from and p.posted_at < v_to;

  -- THE POSTED BALANCE AT THE CUTOFF.
  select (select coalesce(sum(o.amount_tzs), 0) from public.imprest_fund_openings o
           where o.fund_id = v_fund_id and o.posted_at < v_to)
       + (select coalesce(sum(fu.received_amount_tzs), 0) from public.imprest_fundings fu
           where fu.fund_id = v_fund_id and fu.status = 'received' and fu.received_at < v_to)
       - (select coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs
                                   else p.amount_tzs end), 0)
            from public.imprest_postings p
           where p.fund_id = v_fund_id and p.posted_at < v_to)
       + (select coalesce(sum(case when c.kind = 'count_excess' then c.amount_tzs
                                   else -c.amount_tzs end), 0)
            from public.imprest_count_postings c
           where c.fund_id = v_fund_id and c.posted_at < v_to)
    into v_posted;

  -- SET ASIDE AT THE CUTOFF: approved by then, neither cancelled nor verified by then, with every
  -- raise decided by then.
  select coalesce(sum(d.amount_tzs + coalesce(x.tzs, 0)), 0)
    into v_aside
    from public.imprest_disbursements d
    left join lateral (select sum(r.amount_tzs) as tzs from public.imprest_approval_raises r
                        where r.disbursement_id = d.id
                          and r.status in ('raised', 'handed_out')
                          and r.decided_at < v_to) x on true
   where d.fund_id = v_fund_id
     and d.approved_at < v_to
     and (d.cancelled_at is null or d.cancelled_at >= v_to)
     and not exists (select 1 from public.imprest_verifications v
                      where v.disbursement_id = d.id and v.verified_at < v_to);

  -- AWAITING VERIFICATION AT THE CUTOFF: handed out by then and not verified by then, at the latest
  -- cycle settled by then, plus extras handed out by then after that cycle.
  select coalesce(sum(case when s.cycle is null then h.amount_tzs
                           else s.used_tzs + s.unaccounted_tzs end
                      + coalesce(x.tzs, 0)), 0)
    into v_awaiting
    from public.imprest_disbursements d
    join public.imprest_disbursement_handouts h on h.disbursement_id = d.id
    left join lateral (select st.cycle, st.used_tzs, st.unaccounted_tzs
                         from public.imprest_settlements st
                        where st.disbursement_id = d.id and st.settled_at < v_to
                        order by st.cycle desc limit 1) s on true
    left join lateral (select sum(r.amount_tzs) as tzs from public.imprest_approval_raises r
                        where r.disbursement_id = d.id and r.status = 'handed_out'
                          and r.handed_out_at < v_to
                          and r.after_cycle = coalesce(s.cycle, 0)) x on true
   where d.fund_id = v_fund_id
     and h.handed_out_at < v_to
     and not exists (select 1 from public.imprest_verifications v
                      where v.disbursement_id = d.id and v.verified_at < v_to);

  -- THE COUNT, as it stood at the cutoff.
  select c.id, c.counted_tzs, c.expected_tzs, c.variance_tzs,
         k.outcome::text as outcome, k.variance_tzs as confirmed_variance,
         k.explanation::text as explanation, (x.id is not null) as sent_back
    into v_count
    from public.imprest_counts c
    left join public.imprest_count_confirmations k on k.count_id = c.id and k.confirmed_at < v_to
    left join public.imprest_count_returns x on x.count_id = c.id and x.returned_at < v_to
   where c.fund_id = v_fund_id
     and c.business_date = p_business_date
     and c.counted_at < v_to
   order by c.attempt desc
   limit 1;

  if v_count.id is null then
    v_state := private.report_reconciliation_state(
                 'not_counted', null, null, null, null, 'no_reconciliation_record');
  elsif v_count.outcome is not null then
    v_state := private.report_reconciliation_state(
                 v_count.outcome, v_count.counted_tzs, v_count.expected_tzs,
                 v_count.confirmed_variance, v_count.explanation, null);
  elsif v_count.sent_back then
    v_state := private.report_reconciliation_state(
                 'not_counted', null, null, null, null, 'count_sent_back');
  else
    v_state := private.report_reconciliation_state(
                 'awaiting_manager_confirmation', v_count.counted_tzs, v_count.expected_tzs,
                 v_count.variance_tzs, null, null);
  end if;

  return jsonb_build_object(
    'fund_no',           null,
    'fund_id',           v_fund_id,
    'state',             'active',
    'funding',           v_funding,
    'approved_expenses', v_expenses,
    'position',          jsonb_build_object(
                           'as_at',                     'cutoff',
                           'posted_tzs',                v_posted,
                           'set_aside_tzs',             v_aside,
                           'available_tzs',             v_posted - v_aside,
                           'awaiting_verification_tzs', v_awaiting,
                           'expected_cash_tzs',         v_posted - v_awaiting),
    'reconciliation',    v_state);
end;
$$;

comment on function private.report_imprest_section(date) is
  'The daily report''s imprest section for one business date (issue #82): the fund that covered '
  'the day, its funding, the day''s postings, the posted balance, set aside, Free to approve, '
  'Awaiting verification and expected cash, and the count, each as at the cutoff. Reads only.';

alter function private.report_imprest_section(date) owner to fv_definer_owner;
revoke execute on function private.report_imprest_section(date)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.report_content — REPLACED. Every section but the imprest one is the released body,
-- unchanged; the imprest one is read from `private.report_imprest_section`.
-- ---------------------------------------------------------------------------
create or replace function private.report_content(p_business_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- THE BUSINESS DAY AS TWO MOMENTS. Every section below asks "did this happen on the report's
  -- day", and there are two ways to ask it. Wrapping the column — `local_date(col) = the_date` —
  -- reads well and is the wrong one: the expression has to be evaluated for every row in the table
  -- before anything can be discarded, so no index on that column can be used and the planner has no
  -- statistics for what it is about to do. Computing the day's two endpoints ONCE and comparing the
  -- bare column against them asks the same question in a form an index can answer.
  --
  -- Half-open on purpose: `>= v_from and < v_to`. A closed upper bound needs the last representable
  -- instant of the day, and every attempt to write one either loses the microseconds after 23:59:59
  -- or counts midnight into two business days at once.
  --
  -- A NULL column falls outside both comparisons, which is the same answer the previous form gave:
  -- `confirmed_at` and `released_at` are null until the thing happens, and a thing that has not
  -- happened belongs to no business day.
  v_from            timestamptz;
  v_to              timestamptz;

  v_sales           jsonb;
  v_invoices        jsonb;
  v_payments        jsonb;
  v_pay_count       bigint;
  v_pay_total       bigint;
  v_pay_reversals   bigint;
  v_pay_methods     jsonb;
  v_credit          jsonb;
  v_disc_count      bigint;
  v_disc_total      bigint;
  v_appr_by_type    jsonb;
  v_appr_requested  bigint;
  v_unreleased      jsonb;
  v_released        jsonb;
  v_variances       jsonb;
  v_shortages       jsonb;
  v_batches         jsonb;
  v_moulded         bigint;
  v_mould_rejects   bigint;
  v_inspected       bigint;
  v_accepted        bigint;
  v_insp_rejects    bigint;
  v_pending         jsonb;
  v_imprest         jsonb;
begin
  -- Africa/Dar_es_Salaam is UTC+3 with no daylight saving, so the day really is 24 hours long. It
  -- is still written as two local midnights rather than as `+ interval '24 hours'`, because the
  -- rule the business states is "the local calendar day" and that is what this says.
  v_from := (p_business_date::timestamp)       at time zone 'Africa/Dar_es_Salaam';
  v_to   := ((p_business_date + 1)::timestamp) at time zone 'Africa/Dar_es_Salaam';

  -- SALES (product.md §12). Counted by the moment each transition was recorded, in local time.
  --
  -- Three different columns are being asked about, so the WHERE clause is their union and the
  -- FILTER clauses separate them again. Without that outer clause the aggregate would read every
  -- order the business has ever taken in order to report on one day.
  select jsonb_build_object(
           'orders_created',
             count(*) filter (where o.created_at >= v_from and o.created_at < v_to),
           'orders_confirmed',
             count(*) filter (where o.confirmed_at >= v_from and o.confirmed_at < v_to),
           'orders_cancelled',
             count(*) filter (where o.cancelled_at >= v_from and o.cancelled_at < v_to),
           'cash_sales_confirmed',
             count(*) filter (
               where o.is_cash_sale
                 and o.confirmed_at >= v_from and o.confirmed_at < v_to))
    into v_sales
    from public.orders o
   where (o.created_at   >= v_from and o.created_at   < v_to)
      or (o.confirmed_at >= v_from and o.confirmed_at < v_to)
      or (o.cancelled_at >= v_from and o.cancelled_at < v_to);

  -- INVOICES (§12.2). `business_date` is stored on the row, so the number and the day it encodes
  -- can never disagree.
  --
  -- `cancelled_count` is invoices issued that day AND cancelled by the end of it. Counting every
  -- cancellation recorded since would make the figure drift each time somebody cancelled an old
  -- invoice, and would contradict the credit section below — which counts an invoice cancelled
  -- after the cutoff as still owing on the night in question. One cutoff, both sections.
  select jsonb_build_object(
           'issued_count',    count(*),
           'cancelled_count', count(*) filter (where i.cancelled_at < v_to),
           'subtotal_tzs',    coalesce(sum(i.subtotal_tzs), 0),
           'discount_tzs',    coalesce(sum(i.discount_tzs), 0),
           'total_tzs',       coalesce(sum(i.total_tzs), 0))
    into v_invoices
    from public.invoices i
   where i.business_date = p_business_date;

  -- PAYMENTS BY METHOD (§12.5). An approved reversal is a negative payment, so the totals here are
  -- NET takings — which is what the money in the tin actually is — and the reversals are counted
  -- separately so a net figure is never mistaken for a gross one.
  select count(*),
         coalesce(sum(p.amount_tzs), 0),
         count(*) filter (where p.reverses_id is not null)
    into v_pay_count, v_pay_total, v_pay_reversals
    from public.payments p
   where p.business_date = p_business_date;

  select coalesce(
           jsonb_agg(jsonb_build_object('method', m.method, 'count', m.entries,
                                        'amount_tzs', m.amount)
                     order by m.method),
           '[]'::jsonb)
    into v_pay_methods
    from (select p.method::text as method,
                 count(*)       as entries,
                 sum(p.amount_tzs) as amount
            from public.payments p
           where p.business_date = p_business_date
           group by p.method) m;

  v_payments := jsonb_build_object('count', v_pay_count, 'total_tzs', v_pay_total,
                                   'reversal_count', v_pay_reversals, 'methods', v_pay_methods);

  -- OUTSTANDING CREDIT, as at the end of the business date and not as at now: invoices issued on or
  -- before it, less the payments recorded on or before it. Both dates are stored columns, so this
  -- is a point-in-time figure that reads the same whenever the report is regenerated.
  --
  -- `public.invoice_settlement` is deliberately NOT the source, unlike the section above. That view
  -- subtracts EVERY payment ever recorded, which is the right answer for a screen showing what a
  -- customer owes now and the wrong one for a report about a night three weeks ago: a payment taken
  -- since would silently reduce a historical figure. The arithmetic looks the same; the question is
  -- not.
  --
  -- A CANCELLATION IS THE SAME TRAP, one level in. `cancelled_at is null` asks whether the invoice
  -- stands TODAY; this report has to ask whether it stood at the cutoff. An invoice cancelled a
  -- week later was money genuinely owed on the night being described, so it is counted — and the
  -- alternative is worse than a wrong total: the figure would change every time the same day was
  -- rebuilt, which is the one thing an immutable snapshot may not do.
  select jsonb_build_object(
           'as_at_business_date', p_business_date,
           'invoice_count',       count(*),
           'outstanding_tzs',     coalesce(sum(x.outstanding), 0))
    into v_credit
    from (select (i.total_tzs
                  - coalesce((select sum(p.amount_tzs)
                                from public.payments p
                               where p.invoice_id = i.id
                                 and p.business_date <= p_business_date), 0)) as outstanding
            from public.invoices i
           where i.business_date <= p_business_date
             and (i.cancelled_at is null or i.cancelled_at >= v_to)) x
   where x.outstanding > 0;

  -- DISCOUNTS AND APPROVALS (§4.3, §12.3). The discount is what was granted on the day's invoices;
  -- the approvals are every authority decision asked for on the day, whatever it was about.
  --
  -- WHERE EACH ONE STOOD AT THE CUTOFF, NOT WHERE IT STANDS NOW. `approval_requests.status` is a
  -- projection of the latest decision, and a request made at 23:55 and approved at 00:02 would
  -- read as approved in a report the 00:05 retry writes for the day it was still waiting. The
  -- answer is read from the append-only `approval_decisions` history instead: the last decision
  -- made before the cutoff, or `pending` if none was. The projection is used only when no decision
  -- at all came after the cutoff, because then it IS the state at the cutoff and it settles two
  -- decisions stamped in one transaction without a tie-break.
  select count(*) filter (where i.discount_tzs > 0), coalesce(sum(i.discount_tzs), 0)
    into v_disc_count, v_disc_total
    from public.invoices i
   where i.business_date = p_business_date;

  select coalesce(sum(a.requested), 0),
         coalesce(jsonb_agg(jsonb_build_object('approval_type', a.approval_type,
                                               'requested',     a.requested,
                                               'approved',      a.approved,
                                               'rejected',      a.rejected)
                            order by a.approval_type), '[]'::jsonb)
    into v_appr_requested, v_appr_by_type
    from (select r.approval_type::text as approval_type,
                 count(*)                                        as requested,
                 count(*) filter (where c.status = 'approved')   as approved,
                 count(*) filter (where c.status = 'rejected')   as rejected
            from public.approval_requests r
           cross join lateral (
             select case
                      when not exists (select 1
                                         from public.approval_decisions d
                                        where d.request_id = r.id
                                          and d.decided_at >= v_to)
                        then r.status::text
                      else coalesce((select d.outcome::text
                                       from public.approval_decisions d
                                      where d.request_id = r.id
                                        and d.decided_at < v_to
                                      order by d.decided_at desc, d.id desc
                                      limit 1),
                                    'pending')
                    end as status) c
           where r.requested_at >= v_from and r.requested_at < v_to
           group by r.approval_type) a;

  -- PAID BUT UNRELEASED (§8, §12.4). A POSITION: goods the business has been paid for and still
  -- holds. A daily total would be meaningless, so the snapshot records what was outstanding at the
  -- moment of generation and says so.
  --
  -- Read from the EXISTING view, not from a second copy of its predicate. Which allocations count
  -- as paid-but-unreleased is a settled question with one answer, and two definitions of it would
  -- agree today and drift the first time either is corrected.
  select jsonb_build_object(
           'as_at',                'generation',
           'allocation_count',     count(*),
           'outstanding_quantity', coalesce(sum(u.outstanding_quantity), 0))
    into v_unreleased
    from public.paid_but_unreleased u;

  -- RELEASED STOCK (§12.6 step 14). Stock has left the yard only once a Manager confirmed a signed
  -- dispatch note, so a release belongs to the day it was RELEASED, not the day it was assigned.
  select jsonb_build_object(
           'dispatch_count',    count(distinct d.id),
           'released_quantity', coalesce(sum(l.quantity), 0))
    into v_released
    from public.dispatches d
    join public.dispatch_lines l on l.dispatch_id = d.id
   where d.status = 'released'
     and d.released_at >= v_from and d.released_at < v_to;

  -- INVENTORY VARIANCES (§10). Corrections entered on the day, kept as two directions rather than
  -- one net figure: a day that lost 40 and gained 40 is not a quiet day.
  select jsonb_build_object(
           'adjustment_count',  count(*),
           'increase_quantity', coalesce(sum(s.quantity_delta) filter (where s.quantity_delta > 0), 0),
           'decrease_quantity',
             coalesce(-(sum(s.quantity_delta) filter (where s.quantity_delta < 0)), 0),
           'net_quantity',      coalesce(sum(s.quantity_delta), 0))
    into v_variances
    from public.stock_adjustments s
   where s.entered_at >= v_from and s.entered_at < v_to;

  -- SUPPLIER SHORTAGES (§9.1). Short and damaged are different failures and are never added
  -- together: one is a delivery that was light, the other is goods that arrived broken.
  select jsonb_build_object(
           'receipt_count',    count(distinct r.id),
           'short_line_count', count(*) filter (where l.short_quantity > 0),
           'short_quantity',   coalesce(sum(l.short_quantity), 0),
           'damaged_quantity', coalesce(sum(l.damaged_quantity), 0))
    into v_shortages
    from public.stock_receipts r
    join public.stock_receipt_lines l on l.receipt_id = r.id
   where r.entered_at >= v_from and r.entered_at < v_to;

  -- PRODUCTION BATCHES (§11.1). Entered on the day, and shown by the decision each one had reached
  -- AT THE CUTOFF. A batch leaves `draft` exactly once, and the command that moves it stamps
  -- `decided_at` in the same statement, so a batch decided at or after midnight was still a draft
  -- on the day being reported — whatever it has become since.
  select jsonb_build_object(
           'entered',   count(*),
           'draft',     count(*) filter (where c.status = 'draft'),
           'approved',  count(*) filter (where c.status = 'approved'),
           'rejected',  count(*) filter (where c.status = 'rejected'),
           'cancelled', count(*) filter (where c.status = 'cancelled'))
    into v_batches
    from public.production_batches b
   cross join lateral (
     select case when b.decided_at < v_to then b.status
                 else 'draft'::public.production_batch_status
            end as status) c
   where b.entered_at >= v_from and b.entered_at < v_to;

  -- PRODUCTION OUTPUT AND REJECTS (§11.2, §11.5). Two different days are involved and they are not
  -- merged: bricks are moulded on the day their batch was entered, and accepted or rejected on the
  -- day they were inspected — which is at least 72 hours later (§11.4).
  select coalesce(sum(l.quantity_moulded), 0), coalesce(sum(l.rejected_at_moulding), 0)
    into v_moulded, v_mould_rejects
    from public.production_lots l
    join public.production_batches b on b.id = l.batch_id
   where b.entered_at >= v_from and b.entered_at < v_to;

  select count(*), coalesce(sum(l.accepted_quantity), 0), coalesce(sum(l.rejected_at_inspection), 0)
    into v_inspected, v_accepted, v_insp_rejects
    from public.production_lots l
   where l.inspected_at >= v_from and l.inspected_at < v_to;

  -- PENDING APPROVALS. A POSITION again: what is still waiting on somebody at the moment of
  -- generation, which is the only reading that would make a Director act on it.
  select jsonb_build_object(
           'as_at',   'generation',
           'count',   coalesce(sum(t.waiting), 0),
           'by_type', coalesce(jsonb_agg(jsonb_build_object('approval_type', t.approval_type,
                                                            'count',         t.waiting)
                                         order by t.approval_type), '[]'::jsonb))
    into v_pending
    from (select r.approval_type::text as approval_type, count(*) as waiting
            from public.approval_requests r
           where r.status = 'pending'
           group by r.approval_type) t;

  -- IMPREST (§13). Issue #82: read from its own function, every figure as at the cutoff. The
  -- inline section issue #51 wrote here withheld the expenses and the balance and reported every
  -- count as Not counted; see `private.report_imprest_section` above.
  v_imprest := private.report_imprest_section(p_business_date);

  return jsonb_build_object(
    'schema_version', 1,
    'business_date',  p_business_date,
    'time_zone',      'Africa/Dar_es_Salaam',
    'sections', jsonb_build_object(
      'sales',                  v_sales,
      'invoices',               v_invoices,
      'payments_by_method',     v_payments,
      'outstanding_credit',     v_credit,
      'discounts_and_approvals', jsonb_build_object(
        'discounted_invoice_count', v_disc_count,
        'discount_tzs',             v_disc_total,
        'approvals_requested',      v_appr_requested,
        'by_type',                  v_appr_by_type),
      'paid_but_unreleased',    v_unreleased,
      'released_stock',         v_released,
      'inventory_variances',    v_variances,
      'supplier_shortages',     v_shortages,
      'production_batches',     v_batches,
      'production_output', jsonb_build_object(
        'quantity_moulded',       v_moulded,
        'rejected_at_moulding',   v_mould_rejects,
        'inspected_lot_count',    v_inspected,
        'accepted_quantity',      v_accepted,
        'rejected_at_inspection', v_insp_rejects),
      -- The Cashier's till count has no table yet: §15's reconciliation ENTRY screens are a later
      -- ticket. That absence is reported as an absence. Turning it into a zero would tell a
      -- Director the till balanced on a night nobody counted it, which is the one lie §15.2a exists
      -- to prevent.
      --
      -- NOT THE SAME COUNT AS THE IMPREST ONE BELOW, and the two must never be merged. §15.1 lists
      -- "Cash" and "Imprest" as separate variance categories: this is the day's takings in the
      -- till, and the imprest count below is the petty-cash tin of §13.7. One report can honestly
      -- say the imprest was counted and confirmed while the till was never counted at all.
      'cashier_reconciliation', private.report_reconciliation_state(
        'not_counted', null, null, null, null, 'no_cash_reconciliation_record'),
      'pending_approvals',      v_pending,
      'imprest',                v_imprest));
end;
$$;

comment on function private.report_content(date) is
  'The approved pilot report content for one business date, built entirely from existing database '
  'truth. Reads only. Private: it is never reachable through the Data API.';

alter function private.report_content(date) owner to fv_definer_owner;
revoke execute on function private.report_content(date)
  from public, anon, authenticated, service_role;

commit;
