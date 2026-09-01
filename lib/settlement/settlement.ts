import { requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Settlement and dispatch (product.md §12.5, §12.6, §14).
 *
 * READS go through the caller's own session under RLS. A failed read is NOT an empty queue:
 * `requireRows` throws so the shell's error boundary says the system could not be reached, rather
 * than telling a Cashier there is no work waiting during an outage.
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
  /** Who owes it, so `creditExposureByCustomer` can total what they already owe (design.md §7.8). */
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

function nameOf(profile: unknown): string {
  const value = profile as { full_name: string } | { full_name: string }[] | null;
  return (Array.isArray(value) ? value[0]?.full_name : value?.full_name) ?? "";
}

function oneOf<T>(embedded: unknown): T | null {
  const value = embedded as T | T[] | null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) ?? null;
}

export async function loadStorekeepers(): Promise<Storekeeper[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("storekeepers")
      .select("id, storekeeper_code, full_name, phone, is_active, start_date, note")
      .order("full_name"),
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
 * Every invoice with its settlement state, its payments and its credit request.
 *
 * Five concurrent reads rather than a chain: none depends on another, and on this deployment every
 * serial round trip crosses the Atlantic twice (reviews/pr-04-review-brief.md §2).
 */
export async function loadSettlementQueue(): Promise<SettlementInvoice[]> {
  const supabase = await createServerSupabase();

  const [invoiceRows, settlementRows, paymentRows, creditRows, reversalRows] = await Promise.all([
    supabase
      .from("invoices")
      .select(`
        id, invoice_no, order_id, customer_id, business_date, cancelled_at,
        settlement_approved_at,
        orders!inner(order_no, is_cash_sale),
        customers!inner(name)
      `)
      .order("issued_at", { ascending: false })
      .limit(200),
    supabase
      .from("invoice_settlement")
      .select(`
        invoice_id, total_tzs, amount_paid_tzs, approved_credit_tzs, outstanding_tzs, status,
        releasable
      `),
    supabase
      .from("payments")
      .select(`
        id, invoice_id, amount_tzs, method, reverses_id, business_date, received_at,
        profiles!payments_received_by_fkey(full_name)
      `)
      .order("entry_seq"),
    supabase
      .from("credit_authorisations")
      .select(`
        id, invoice_id, amount_tzs, reason,
        profiles!credit_authorisations_requested_by_fkey(full_name)
      `),
    // The reversal decisions, so a payment can say whether one is pending or already made.
    supabase
      .from("approval_requests")
      .select(`
        entity_id, status, approval_type, required_role,
        profiles!approval_requests_approved_by_fkey(full_name)
      `)
      .in("approval_type", ["payment_reversal", "credit_or_unpaid_balance"]),
  ]);

  const invoices = requireRows(invoiceRows, "settlement.invoices");
  const settlements = requireRows(settlementRows, "settlement.states");
  const payments = requireRows(paymentRows, "settlement.payments");
  const credits = requireRows(creditRows, "settlement.credits");
  const approvals = requireRows(reversalRows, "settlement.approvals");

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
      requiredRole: approval?.requiredRole ?? "manager",
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

  return invoices.map((row) => {
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
  });
}

export async function loadDispatchQueue(): Promise<{
  dispatches: Dispatch[];
  outstanding: OutstandingClaim[];
}> {
  const supabase = await createServerSupabase();

  const [dispatchRows, lineRows, outstandingRows] = await Promise.all([
    supabase
      .from("dispatches")
      .select(`
        id, invoice_id, dispatch_note_no, source_location, status, assigned_at, released_at,
        invoices!inner(invoice_no, orders!inner(customers!inner(name))),
        storekeepers!inner(full_name),
        profiles!dispatches_assigned_by_fkey(full_name)
      `)
      .order("assigned_at", { ascending: false })
      .limit(200),
    supabase.from("dispatch_lines").select("id, dispatch_id, allocation_id, product_id, quantity"),
    supabase
      .from("paid_but_unreleased")
      .select(`
        allocation_id, invoice_id, invoice_no, customer_name, product_id, outstanding_quantity,
        days_waiting
      `),
  ]);

  const dispatches = requireRows(dispatchRows, "settlement.dispatches");
  const lines = requireRows(lineRows, "settlement.dispatch_lines");
  const outstanding = requireRows(outstandingRows, "settlement.paid_but_unreleased");

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

  return {
    dispatches: dispatches.map((row) => {
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
    }),
    outstanding: outstanding.map((row) => ({
      allocationId: row.allocation_id as string,
      invoiceId: row.invoice_id as string,
      invoiceNo: row.invoice_no as string,
      customerName: row.customer_name as string,
      productId: row.product_id as string,
      outstandingQuantity: Number(row.outstanding_quantity),
      daysWaiting: Number(row.days_waiting),
    })),
  };
}
