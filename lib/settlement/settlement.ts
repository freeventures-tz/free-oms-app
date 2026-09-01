import { DATA_UNAVAILABLE, requireRows, type QueryResult } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Settlement and dispatch (product.md §12.5, §12.6, §14).
 *
 * READS go through the caller's own session under RLS. A failed read is NOT an empty queue:
 * `requireRows` throws so the shell's error boundary says the system could not be reached, rather
 * than telling a Cashier there is no work waiting during an outage.
 *
 * EVERY READ IS BOUNDED, AND EVERY BOUND IS VISIBLE. PostgREST caps a response at 1,000 rows and
 * says nothing when it does. A queue that limited its invoices to the newest 200 and then read
 * `payments` and `credit_authorisations` whole would therefore go quietly wrong at the 1,001st
 * payment: the invoices would still be there and the money against them would not. So the primary
 * records are paged with an EXACT count the screen shows, and every related read is scoped to the
 * page with `.in(...)` — never to the whole table.
 *
 * THE ONE FIGURE THAT MUST NOT BE PAGED is customer credit exposure, because a total across some
 * of a customer's invoices is not a smaller answer, it is a wrong one. It is aggregated in
 * `public.customer_credit_exposure` and read back per customer.
 */

/**
 * A storekeeper's FULL record (product.md §3.2), for the screen that administers them.
 *
 * Not the shape the dispatch board gets. §3.2 lists a phone number, a start date and a note, and
 * none of those has anything to do with choosing who fetches the goods — see `StorekeeperOption`.
 */
export type Storekeeper = {
  id: string;
  code: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  startDate: string;
  note: string | null;
};

/**
 * What the Cashier needs to ASSIGN one, and nothing else (design.md §7.10).
 *
 * The dispatch board is a client component, so whatever it is handed is serialised into the page
 * and readable by anyone holding the browser. Handing it the administration record put every
 * storekeeper's phone number and start date there to fill in a `<select>` that renders a name and
 * a code — a use with no need of either. The role boundary is unchanged: the same three roles read
 * the same table. What changes is how much of a row leaves the server.
 */
export type StorekeeperOption = {
  id: string;
  code: string;
  fullName: string;
};

export type Payment = {
  id: string;
  amountTzs: number;
  method: string;
  /** Set on a reversal, pointing at the payment it undoes. Never an edit of the original. */
  reversesId: string | null;
  receivedByName: string;
  receivedAt: string;
  businessDate: string;
  /** True when a Director has already approved a reversal of this payment. */
  reversed: boolean;
  /** True when a reversal has been asked for and nobody has decided yet. */
  reversalPending: boolean;
};

export type CreditAuthorisation = {
  id: string;
  amountTzs: number;
  reason: string;
  requestedByName: string;
  requiredRole: AppRole;
  status: string;
  decidedByName: string | null;
};

/**
 * What an invoice is settled by (product.md §12.3).
 *
 * `status` is CALCULATED from money received and is never a stored value — a fully credited invoice
 * is Unpaid, because nothing was paid (AC-93). `approvedCreditTzs` sits beside it and is never
 * added to it.
 */
export type Settlement = {
  totalTzs: number;
  amountPaidTzs: number;
  approvedCreditTzs: number;
  outstandingTzs: number;
  status: string;
  /** Money plus approved credit covers the bill AND a Cashier has confirmed it (§4.1). */
  releasable: boolean;
};

export type SettlementInvoice = {
  id: string;
  invoiceNo: string;
  orderId: string;
  orderNo: string;
  /** Who owes it, so the screen can look their exposure up (design.md §7.8). */
  customerId: string;
  customerName: string;
  isCashSale: boolean;
  businessDate: string;
  cancelledAt: string | null;
  settlementApprovedAt: string | null;
  settlement: Settlement;
  payments: Payment[];
  credit: CreditAuthorisation | null;
};

export type DispatchLine = {
  id: string;
  allocationId: string;
  productId: string;
  quantity: number;
};

export type Dispatch = {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  customerName: string;
  dispatchNoteNo: string | null;
  storekeeperName: string;
  sourceLocation: string;
  status: string;
  assignedByName: string;
  assignedAt: string;
  releasedAt: string | null;
  lines: DispatchLine[];
};

/** A claim on an invoice that is settled and has not left the yard (design.md §7.12). */
export type OutstandingClaim = {
  allocationId: string;
  invoiceId: string;
  invoiceNo: string;
  customerName: string;
  productId: string;
  outstandingQuantity: number;
  daysWaiting: number;
};

/**
 * One line a Cashier may still put on a dispatch.
 *
 * NOT the same figure as `OutstandingClaim.outstandingQuantity`, and the difference is what makes
 * a second assignment possible. Outstanding is what the customer is still owed; assignable is that
 * minus whatever an in-progress dispatch has already claimed. `api.staff_assign_dispatch` computes
 * exactly this before it writes, and the screen has to agree with it or it offers work the
 * database will refuse.
 */
export type AssignableLine = {
  allocationId: string;
  productId: string;
  assignableQuantity: number;
};

/** An invoice with goods still to hand over and no in-progress dispatch covering all of them. */
export type AssignableInvoice = {
  invoiceId: string;
  invoiceNo: string;
  customerName: string;
  lines: AssignableLine[];
};

/** One page of records, and how many there are in total, so a screen never hides the rest. */
export type Page<T> = {
  rows: T[];
  /** Every row that matches, not just the ones on this page. */
  total: number;
  /** 1-based. */
  page: number;
  pageSize: number;
};

/**
 * How many records a queue section shows at once.
 *
 * Small on purpose. These are work queues cleared item by item on a phone, not reports — and a
 * page that renders three hundred cards on a mid-range Android is a page nobody scrolls
 * (design.md §11.9).
 */
export const QUEUE_PAGE_SIZE = 25;

/** Turns a 1-based page number into the half-open range PostgREST wants. */
function rangeFor(page: number, pageSize: number): { from: number; to: number } {
  const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const from = (safe - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}

/**
 * A counted read of one range, as PostgREST answers it.
 *
 * `code` is on the error because one particular code is not a failure: `PGRST103` is what comes
 * back when the range starts past the last row, and that is a page number to correct rather than
 * an outage to report.
 */
type CountedResult<T> = {
  data: T[] | null;
  error: { message: string; code?: string } | null;
  count: number | null;
};

/** PostgREST's "Requested range not satisfiable" — an offset past the end of the result. */
const RANGE_PAST_END = "PGRST103";

/**
 * One page of a query, normalised so a page number can never produce a false empty state.
 *
 * TWO WAYS TO ASK FOR A PAGE THAT IS NOT THERE, and both happen. A person edits `?awaiting=999` in
 * the address bar; or they clear the last invoice on page 2 and the revalidated render asks for
 * page 2 of a queue that now has one page. Either way PostgREST answers with an empty range and a
 * positive count, and the screen says "nothing is waiting" over the top of work that exists. That
 * is the same class of lie as `data ?? []` — a confident statement about the business drawn from
 * a query that did not ask the right question.
 *
 * So when a range comes back empty against a positive count, the last page is computed from that
 * count and asked for instead, and the page number reported back is the one actually shown — which
 * is what the pager builds its links from, so Previous and Next stay right.
 *
 * ORDERING IS THE CALLER'S JOB, and every caller ends its sort on a unique column. A range over a
 * non-deterministic order is not a page: rows with equal timestamps can appear on two pages or on
 * none, and nothing about the result says so.
 */
async function pagedQuery<T>(
  page: number,
  read: (from: number, to: number) => PromiseLike<CountedResult<T>>,
  label: string,
): Promise<Page<T>> {
  const requested = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;

  const first = rangeFor(requested, QUEUE_PAGE_SIZE);
  const result = await read(first.from, first.to);

  // TWO SHAPES OF "THAT PAGE IS NOT THERE", and only one of them looks like an answer.
  //
  // An EXTREME range — row 24,975 of a twelve-row queue, from a hand-edited `?awaiting=999` — is
  // REFUSED outright with `PGRST103`. Untreated it reaches `requireRows` and becomes an outage:
  // the Cashier is told the system could not be reached because somebody typed a number into the
  // address bar.
  //
  // A STALE FINAL PAGE is different. Clear the last row of page 2 and the revalidated render asks
  // for page 2 of a queue that now has one page: the range still starts inside the result set as
  // PostgREST sees it, so the answer is a polite empty list WITH A POSITIVE COUNT. That is the
  // opposite lie — "nothing is waiting" over the top of work that exists.
  //
  // Neither is true, and both have the same fix: find the real last page and show it.
  const pastTheEnd =
    result.error?.code === RANGE_PAST_END ||
    (result.error === null && (result.data ?? []).length === 0 && (result.count ?? 0) > 0);

  if (!pastTheEnd) {
    const rows = requireRows(result, label);
    return { rows, total: result.count ?? rows.length, page: requested, pageSize: QUEUE_PAGE_SIZE };
  }

  // One row from the top, purely for its exact count: a refusal carries no count to work from, and
  // `range(0, 0)` is the one range that is satisfiable whatever the queue holds.
  const probe = await read(0, 0);
  const total = requireRows(probe, label).length === 0 ? 0 : (probe.count ?? 0);

  if (total === 0) {
    return { rows: [], total: 0, page: 1, pageSize: QUEUE_PAGE_SIZE };
  }

  const lastPage = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const fallback = rangeFor(lastPage, QUEUE_PAGE_SIZE);
  const retry = await read(fallback.from, fallback.to);

  return {
    rows: requireRows(retry, label),
    total: retry.count ?? total,
    page: lastPage,
    pageSize: QUEUE_PAGE_SIZE,
  };
}

/** A page number as it arrived from the URL, which is to say: not to be trusted. */
export function pageNumber(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function nameOf(profile: unknown): string {
  const value = profile as { full_name: string } | { full_name: string }[] | null;
  return (Array.isArray(value) ? value[0]?.full_name : value?.full_name) ?? "";
}

function oneOf<T>(embedded: unknown): T | null {
  const value = embedded as T | T[] | null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) ?? null;
}

/**
 * How many rows one request asks for. PostgREST will not return more than its own `max-rows`
 * setting (1,000 here) whatever is asked for, so this matches it: a batch that comes back short is
 * the last one, and a batch that comes back full means there is more.
 */
const READ_BATCH = 1000;

/**
 * A ceiling on the batching below, so a pathological state cannot spin forever.
 *
 * Twenty batches is twenty thousand related rows for twenty-five invoices. Reaching it means
 * something is wrong that this function cannot fix, and the honest answer then is the one every
 * failed read gives — "the system could not be reached" — rather than a total that is quietly
 * short by however much did not fit.
 */
const MAX_BATCHES = 20;

/**
 * Every row of a read, in batches, never the first thousand.
 *
 * SCOPING A READ TO THE PAGE IS NOT ENOUGH ON ITS OWN, and this is the part that is easy to miss:
 * `.in("invoice_id", [twenty-five ids])` is still subject to `max-rows`, so an invoice with a long
 * payment history could still be truncated — silently, because PostgREST does not say it capped
 * anything. Asking by explicit range until a short batch comes back is what makes "every payment
 * against these invoices" mean what it says.
 *
 * The reads that use this are all ordered, because a range over an unordered result is not a page
 * of anything.
 */
async function readEvery<T>(
  read: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const from = batch * READ_BATCH;
    const page = requireRows(await read(from, from + READ_BATCH - 1), label);
    rows.push(...page);
    if (page.length < READ_BATCH) return rows;
  }

  console.error(`[data] ${label} exceeded ${MAX_BATCHES * READ_BATCH} rows`);
  throw new Error(`${DATA_UNAVAILABLE}: ${label}`);
}

/**
 * The same, scoped to the page — and skipped entirely when the page is empty.
 *
 * PostgREST renders `.in("id", [])` as `in.()`, which it rejects — so an empty page would turn
 * into a failed read, and `requireRows` would correctly turn that into "the system could not be
 * reached" on a queue that is simply empty. The short circuit is the difference between an empty
 * queue and an outage, which is a distinction this codebase spends a lot of care on elsewhere.
 */
async function scopedTo<T>(
  ids: string[],
  read: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  label: string,
): Promise<T[]> {
  if (ids.length === 0) return [];
  return readEvery(read, label);
}

/** Every storekeeper record, for Settings › Storekeepers. */
export async function loadStorekeepers(): Promise<Storekeeper[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("storekeepers")
      .select("id, storekeeper_code, full_name, phone, is_active, start_date, note")
      .order("full_name")
      .order("id"),
    "settlement.storekeepers",
  );

  return rows.map((row) => ({
    id: row.id as string,
    code: row.storekeeper_code as string,
    fullName: row.full_name as string,
    phone: (row.phone as string | null) ?? null,
    isActive: row.is_active as boolean,
    startDate: row.start_date as string,
    note: (row.note as string | null) ?? null,
  }));
}

/**
 * The active storekeepers a dispatch may be assigned to — three columns, chosen in the SELECT.
 *
 * Narrowed in the query rather than mapped down afterwards, because a field that is never read out
 * of the database cannot be leaked by a later refactor that forgets to drop it again.
 */
export async function loadStorekeeperOptions(): Promise<StorekeeperOption[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("storekeepers")
      .select("id, storekeeper_code, full_name")
      .eq("is_active", true)
      .order("full_name")
      .order("id"),
    "settlement.storekeeper_options",
  );

  return rows.map((row) => ({
    id: row.id as string,
    code: row.storekeeper_code as string,
    fullName: row.full_name as string,
  }));
}

export type SettlementQueue = {
  /** Not yet settled, newest first — see the note on ordering in `loadSettlementQueue`. */
  awaiting: Page<SettlementInvoice>;
  /** Settled, newest first. History, and paged like history. */
  settled: Page<SettlementInvoice>;
  /**
   * What each customer on this page already owes on approved credit, across EVERY live invoice
   * they hold — not only the ones on the page (design.md §7.8).
   */
  exposureByCustomer: Record<string, number>;
};

/**
 * The Cashier's queue, one page of each section.
 *
 * The two sections are read as two queries rather than one, because they are two questions asked
 * of the same table with different filters.
 *
 * BOTH LEAD WITH THE NEWEST, and the unsettled one learned that the hard way: ordered oldest-first,
 * an invoice a Cashier had just created landed on the last page, so taking a walk-in payment
 * looked like it had done nothing at all. Work that has waited is not lost by this — the pager
 * states the exact total and the way to the rest — but the first thing on the screen has to be the
 * thing that just happened.
 */
export async function loadSettlementQueue(
  pages: { awaiting?: number; settled?: number } = {},
): Promise<SettlementQueue> {
  const supabase = await createServerSupabase();

  const invoiceColumns = `
    id, invoice_no, order_id, customer_id, business_date, cancelled_at,
    settlement_approved_at,
    orders!inner(order_no, is_cash_sale),
    customers!inner(name)
  `;

  // `id` closes both sorts. Two invoices issued in the same transaction share an `issued_at`, and
  // a range over a tie is not a page: the same row can arrive twice, or never (design.md §12.3 —
  // an empty result and a wrong one are different answers, and this would produce both).
  const [awaiting, settled] = await Promise.all([
    pagedQuery(
      pages.awaiting ?? 1,
      (from, to) =>
        supabase
          .from("invoices")
          .select(invoiceColumns, { count: "exact" })
          .is("cancelled_at", null)
          .is("settlement_approved_at", null)
          .order("issued_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      "settlement.invoices.awaiting",
    ),
    pagedQuery(
      pages.settled ?? 1,
      (from, to) =>
        supabase
          .from("invoices")
          .select(invoiceColumns, { count: "exact" })
          .is("cancelled_at", null)
          .not("settlement_approved_at", "is", null)
          .order("issued_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      "settlement.invoices.settled",
    ),
  ]);

  const invoiceRows = [...awaiting.rows, ...settled.rows];
  const invoiceIds = invoiceRows.map((row) => row.id as string);
  const customerIds = [...new Set(invoiceRows.map((row) => row.customer_id as string))];

  const [settlements, payments, credits, exposures] = await Promise.all([
    scopedTo(
      invoiceIds,
      (from, to) =>
        supabase
          .from("invoice_settlement")
          .select(
            `invoice_id, total_tzs, amount_paid_tzs, approved_credit_tzs, outstanding_tzs, status,
             releasable`,
          )
          .in("invoice_id", invoiceIds)
          .order("invoice_id")
          .range(from, to),
      "settlement.states",
    ),
    scopedTo(
      invoiceIds,
      (from, to) =>
        supabase
          .from("payments")
          .select(
            `id, invoice_id, amount_tzs, method, reverses_id, business_date, received_at,
             profiles!payments_received_by_fkey(full_name)`,
          )
          .in("invoice_id", invoiceIds)
          .order("entry_seq")
          .range(from, to),
      "settlement.payments",
    ),
    scopedTo(
      invoiceIds,
      (from, to) =>
        supabase
          .from("credit_authorisations")
          .select(
            `id, invoice_id, amount_tzs, reason,
             profiles!credit_authorisations_requested_by_fkey(full_name)`,
          )
          .in("invoice_id", invoiceIds)
          .order("id")
          .range(from, to),
      "settlement.credits",
    ),
    // Complete per customer, whatever the page holds: the view does the summing in SQL.
    scopedTo(
      customerIds,
      (from, to) =>
        supabase
          .from("customer_credit_exposure")
          .select("customer_id, exposure_tzs")
          .in("customer_id", customerIds)
          .order("customer_id")
          .range(from, to),
      "settlement.exposure",
    ),
  ]);

  // The decisions, scoped to the payments and credits actually on the page. A second round trip,
  // because their `entity_id` values are only known once those rows are in hand — and the
  // alternative is reading every approval in the business to render twenty-five cards.
  const decidableIds = [
    ...payments.map((row) => row.id as string),
    ...credits.map((row) => row.id as string),
  ];

  const approvals = await scopedTo(
    decidableIds,
    (from, to) =>
      supabase
        .from("approval_requests")
        .select(
          `entity_id, status, approval_type, required_role,
           profiles!approval_requests_approved_by_fkey(full_name)`,
        )
        .in("approval_type", ["payment_reversal", "credit_or_unpaid_balance"])
        .in("entity_id", decidableIds)
        .order("entity_id")
        .order("id")
        .range(from, to),
    "settlement.approvals",
  );

  const settlementBy = new Map(
    settlements.map((row) => [
      row.invoice_id as string,
      {
        totalTzs: Number(row.total_tzs),
        amountPaidTzs: Number(row.amount_paid_tzs),
        approvedCreditTzs: Number(row.approved_credit_tzs),
        outstandingTzs: Number(row.outstanding_tzs),
        status: row.status as string,
        releasable: row.releasable as boolean,
      } satisfies Settlement,
    ]),
  );

  const approvalByEntity = new Map(
    approvals.map((row) => [
      `${row.approval_type as string}:${row.entity_id as string}`,
      {
        status: row.status as string,
        requiredRole: row.required_role as AppRole,
        decidedByName: nameOf(row.profiles) || null,
      },
    ]),
  );

  // Which payments already carry a reversal. Read from the rows themselves rather than from the
  // approval, because the reversal row IS the fact and the approval is only how it was authorised.
  const reversedIds = new Set(
    payments.filter((row) => row.reverses_id !== null).map((row) => row.reverses_id as string),
  );

  const paymentsByInvoice = new Map<string, Payment[]>();
  for (const row of payments) {
    const invoiceId = row.invoice_id as string;
    const id = row.id as string;
    const pending = approvalByEntity.get(`payment_reversal:${id}`);

    const list = paymentsByInvoice.get(invoiceId) ?? [];
    list.push({
      id,
      amountTzs: Number(row.amount_tzs),
      method: row.method as string,
      reversesId: (row.reverses_id as string | null) ?? null,
      receivedByName: nameOf(row.profiles),
      receivedAt: row.received_at as string,
      businessDate: row.business_date as string,
      reversed: reversedIds.has(id),
      reversalPending: pending?.status === "pending",
    });
    paymentsByInvoice.set(invoiceId, list);
  }

  const creditByInvoice = new Map<string, CreditAuthorisation>();
  for (const row of credits) {
    const id = row.id as string;
    const approval = approvalByEntity.get(`credit_or_unpaid_balance:${id}`);
    creditByInvoice.set(row.invoice_id as string, {
      id,
      amountTzs: Number(row.amount_tzs),
      reason: row.reason as string,
      requestedByName: nameOf(row.profiles),
      requiredRole: (approval?.requiredRole as AppRole) ?? "manager",
      status: approval?.status ?? "pending",
      decidedByName: approval?.decidedByName ?? null,
    });
  }

  const EMPTY: Settlement = {
    totalTzs: 0,
    amountPaidTzs: 0,
    approvedCreditTzs: 0,
    outstandingTzs: 0,
    status: "unpaid",
    releasable: false,
  };

  function toInvoice(raw: unknown): SettlementInvoice {
    const row = raw as Record<string, unknown>;
    const order = oneOf<{ order_no: string; is_cash_sale: boolean }>(row.orders);
    const customer = oneOf<{ name: string }>(row.customers);
    const id = row.id as string;

    return {
      id,
      invoiceNo: row.invoice_no as string,
      orderId: row.order_id as string,
      orderNo: order?.order_no ?? "",
      customerId: row.customer_id as string,
      customerName: customer?.name ?? "",
      isCashSale: order?.is_cash_sale ?? false,
      businessDate: row.business_date as string,
      cancelledAt: (row.cancelled_at as string | null) ?? null,
      settlementApprovedAt: (row.settlement_approved_at as string | null) ?? null,
      settlement: settlementBy.get(id) ?? EMPTY,
      payments: paymentsByInvoice.get(id) ?? [],
      credit: creditByInvoice.get(id) ?? null,
    };
  }

  const exposureByCustomer: Record<string, number> = {};
  for (const row of exposures) {
    exposureByCustomer[row.customer_id as string] = Number(row.exposure_tzs);
  }

  return {
    awaiting: { ...awaiting, rows: awaiting.rows.map((row) => toInvoice(row)) },
    settled: { ...settled, rows: settled.rows.map((row) => toInvoice(row)) },
    exposureByCustomer,
  };
}

/** A confirmed walk-in order with no invoice: everything about it happens at payment (§12.4). */
export type CashSale = {
  id: string;
  orderNo: string;
  customerName: string;
  totalTzs: number;
};

/**
 * Walk-in orders that are confirmed and have no invoice yet (product.md §12.4).
 *
 * ONE READ OF ONE VIEW, and the view is what makes it correct. The "no invoice yet" test used to
 * happen in TypeScript, after a limit of twenty-five: twenty-five completed sales from last week
 * would fill the page and then be filtered away, leaving the Cashier an empty queue with a
 * customer standing in front of them. `public.cash_sales_awaiting_payment` applies the anti-join
 * before anything is limited or counted, so a page holds twenty-five sales that genuinely need
 * paying and the total beside it counts the same thing.
 *
 * Ordered oldest-first — a till queue is cleared in the order people arrived — and closed on
 * `order_id`, because two orders written in one second must not swap places between pages.
 */
export async function loadCashSalesAwaitingPayment(page = 1): Promise<Page<CashSale>> {
  const supabase = await createServerSupabase();

  const result = await pagedQuery(
    page,
    (from, to) =>
      supabase
        .from("cash_sales_awaiting_payment")
        .select("order_id, order_no, customer_name, total_tzs", { count: "exact" })
        .order("created_at", { ascending: true })
        .order("order_id", { ascending: true })
        .range(from, to),
    "settlement.cash_sales",
  );

  return {
    ...result,
    rows: result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: row.order_id as string,
        orderNo: row.order_no as string,
        customerName: (row.customer_name as string) ?? "",
        totalTzs: Number(row.total_tzs),
      };
    }),
  };
}

export type DispatchQueue = {
  /** Assigned and note-recorded, in full: open work is the queue, and it is bounded by being open. */
  live: Dispatch[];
  /** Released, newest first, and paged — this is history. */
  released: Page<Dispatch>;
  /**
   * Settled goods still in the yard (design.md §7.12), longest wait first.
   *
   * EVERY committed claim, assigned or not. It is the dangerous-state list and answers a different
   * question from `assignable`, so the two are read and paged independently.
   */
  outstanding: Page<OutstandingClaim>;
  /**
   * Invoices still waiting for a storekeeper — its own read, its own count, its own page.
   *
   * It used to be derived from whatever `outstanding` happened to be showing, and that is exactly
   * how a queue lies: twenty-five older claims already covered by dispatches in progress fill the
   * page, the derivation finds nothing left on any of them, and the Cashier is told nothing is
   * waiting while the claim that IS waiting sits on page two.
   */
  assignable: Page<AssignableInvoice>;
};

export async function loadDispatchQueue(
  pages: { released?: number; unreleased?: number; assignment?: number } = {},
): Promise<DispatchQueue> {
  const supabase = await createServerSupabase();

  const dispatchColumns = `
    id, invoice_id, dispatch_note_no, source_location, status, assigned_at, released_at,
    invoices!inner(invoice_no, orders!inner(customers!inner(name))),
    storekeepers!inner(full_name),
    profiles!dispatches_assigned_by_fkey(full_name)
  `;

  const [live, released, outstanding, assignableInvoices] = await Promise.all([
    // No page, and that is the bound: a dispatch stops being live the moment it is released or
    // cancelled, so this set is the work in hand rather than the history of it. Batched all the
    // same, because "no page" must not quietly become "the first thousand".
    readEvery(
      (from, to) =>
        supabase
          .from("dispatches")
          .select(dispatchColumns)
          .in("status", ["assigned", "note_recorded"])
          .order("assigned_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      "settlement.dispatches.live",
    ),
    pagedQuery(
      pages.released ?? 1,
      (from, to) =>
        supabase
          .from("dispatches")
          .select(dispatchColumns, { count: "exact" })
          .eq("status", "released")
          .order("released_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      "settlement.dispatches.released",
    ),
    // `days_waiting` is a whole number of days, so on any ordinary morning most of this list ties
    // on it, and `invoice_no` ties again across the lines of one invoice. `allocation_id` is what
    // finally settles the order — without it a claim can sit on two pages, or on neither.
    pagedQuery(
      pages.unreleased ?? 1,
      (from, to) =>
        supabase
          .from("paid_but_unreleased")
          .select(
            `allocation_id, invoice_id, invoice_no, customer_name, product_id, outstanding_quantity,
             days_waiting`,
            { count: "exact" },
          )
          .order("days_waiting", { ascending: false })
          .order("invoice_no", { ascending: true })
          .order("allocation_id", { ascending: true })
          .range(from, to),
      "settlement.paid_but_unreleased",
    ),
    // The assignment queue, counted and paged over INVOICES so a card is never split in half.
    // `invoice_id` closes the sort: `days_waiting` is a whole number of days and `invoice_no` can
    // only tie with itself, so without it a page boundary could drop or repeat a card.
    pagedQuery(
      pages.assignment ?? 1,
      (from, to) =>
        supabase
          .from("assignable_dispatch_invoices")
          .select("invoice_id, invoice_no, customer_name, days_waiting", { count: "exact" })
          .order("days_waiting", { ascending: false })
          .order("invoice_no", { ascending: true })
          .order("invoice_id", { ascending: true })
          .range(from, to),
      "settlement.assignable.invoices",
    ),
  ]);

  const dispatchIds = [...live, ...released.rows].map((row) => (row as { id: string }).id);

  const assignableInvoiceIds = assignableInvoices.rows.map(
    (row) => (row as { invoice_id: string }).invoice_id,
  );

  const [lines, assignableLines] = await Promise.all([
    scopedTo(
      dispatchIds,
      (from, to) =>
        supabase
          .from("dispatch_lines")
          .select("id, dispatch_id, allocation_id, product_id, quantity")
          .in("dispatch_id", dispatchIds)
          .order("id")
          .range(from, to),
      "settlement.dispatch_lines",
    ),
    // EVERY line of every invoice on the page, scoped to those invoices. The page decides which
    // invoices; this decides nothing, so an invoice cannot arrive with some of its lines missing.
    scopedTo(
      assignableInvoiceIds,
      (from, to) =>
        supabase
          .from("assignable_dispatch_lines")
          .select("allocation_id, invoice_id, product_id, assignable_quantity")
          .in("invoice_id", assignableInvoiceIds)
          .order("allocation_id")
          .range(from, to),
      "settlement.assignable.lines",
    ),
  ]);

  const linesByDispatch = new Map<string, DispatchLine[]>();
  for (const row of lines) {
    const dispatchId = row.dispatch_id as string;
    const list = linesByDispatch.get(dispatchId) ?? [];
    list.push({
      id: row.id as string,
      allocationId: row.allocation_id as string,
      productId: row.product_id as string,
      quantity: Number(row.quantity),
    });
    linesByDispatch.set(dispatchId, list);
  }

  function toDispatch(raw: unknown): Dispatch {
    const row = raw as Record<string, unknown>;
    const invoice = oneOf<{ invoice_no: string; orders: unknown }>(row.invoices);
    const order = oneOf<{ customers: unknown }>(invoice?.orders);
    const customer = oneOf<{ name: string }>(order?.customers);
    const keeper = oneOf<{ full_name: string }>(row.storekeepers);

    return {
      id: row.id as string,
      invoiceId: row.invoice_id as string,
      invoiceNo: invoice?.invoice_no ?? "",
      customerName: customer?.name ?? "",
      dispatchNoteNo: (row.dispatch_note_no as string | null) ?? null,
      storekeeperName: keeper?.full_name ?? "",
      sourceLocation: row.source_location as string,
      status: row.status as string,
      assignedByName: nameOf(row.profiles),
      assignedAt: row.assigned_at as string,
      releasedAt: (row.released_at as string | null) ?? null,
      lines: linesByDispatch.get(row.id as string) ?? [],
    };
  }

  const liveDispatches = live.map((row) => toDispatch(row));

  const claims = outstanding.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      allocationId: row.allocation_id as string,
      invoiceId: row.invoice_id as string,
      invoiceNo: row.invoice_no as string,
      customerName: row.customer_name as string,
      productId: row.product_id as string,
      outstandingQuantity: Number(row.outstanding_quantity),
      daysWaiting: Number(row.days_waiting),
    };
  });

  // The lines, gathered under the invoice they belong to. Assembled in the order the PAGE gave,
  // not the order the lines came back in, so the cards read the same way every time.
  const linesByInvoice = new Map<string, AssignableLine[]>();
  for (const raw of assignableLines) {
    const row = raw as Record<string, unknown>;
    const invoiceId = row.invoice_id as string;
    const list = linesByInvoice.get(invoiceId) ?? [];
    list.push({
      allocationId: row.allocation_id as string,
      productId: row.product_id as string,
      assignableQuantity: Number(row.assignable_quantity),
    });
    linesByInvoice.set(invoiceId, list);
  }

  const assignable = assignableInvoices.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const invoiceId = row.invoice_id as string;
    return {
      invoiceId,
      invoiceNo: row.invoice_no as string,
      customerName: row.customer_name as string,
      lines: linesByInvoice.get(invoiceId) ?? [],
    } satisfies AssignableInvoice;
  });

  return {
    live: liveDispatches,
    released: { ...released, rows: released.rows.map((row) => toDispatch(row)) },
    outstanding: { ...outstanding, rows: claims },
    assignable: { ...assignableInvoices, rows: assignable },
  };
}
