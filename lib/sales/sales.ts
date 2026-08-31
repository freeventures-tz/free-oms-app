import { requireRows, requireText } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Orders, proformas, invoices and what is left to sell (product.md §12, §8.1).
 *
 * READS go through the caller's own session under RLS. A failed read is NOT an empty order book:
 * `requireRows` throws so the shell's error boundary says the system could not be reached, rather
 * than telling a Sales Representative they have no orders during an outage.
 */

export type Customer = {
  id: string;
  name: string;
  isActive: boolean;
  /** The permanent one-click walk-in row (product.md §12.4). There is exactly one. */
  isCashCustomer: boolean;
};

/**
 * What is left to sell, as product.md §8.1 defines it.
 *
 * `available` is the only figure an order may be written against. `physical` is shown beside it
 * because the two differ for a reason a person needs to see: the goods ARE in the yard, they are
 * simply spoken for.
 */
export type Availability = {
  productId: string;
  physical: number;
  reserved: number;
  committed: number;
  available: number;
};

export type OrderLine = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceTzs: number;
  lineTotalTzs: number;
};

export type ProformaLine = {
  id: string;
  productName: string;
  productSpecification: string | null;
  unitCode: string;
  unitContent: string | null;
  quantity: number;
  unitPriceTzs: number;
  lineTotalTzs: number;
};

export type Proforma = {
  id: string;
  version: number;
  proformaNo: string;
  subtotalTzs: number;
  discountTzs: number;
  totalTzs: number;
  validUntil: string;
  issuedAt: string;
  supersededAt: string | null;
  lines: ProformaLine[];
};

export type Invoice = {
  id: string;
  invoiceNo: string;
  subtotalTzs: number;
  discountTzs: number;
  totalTzs: number;
  businessDate: string;
  issuedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: ProformaLine[];
};

/** A discount awaiting a decision, and whose decision it is (product.md §4). */
export type DiscountRequest = {
  id: string;
  requestedPercent: number;
  requiredRole: AppRole;
  status: string;
  requestedByName: string;
  decidedByName: string | null;
  note: string | null;
};

export type Order = {
  id: string;
  orderNo: string;
  customerId: string;
  customerName: string;
  status: "proforma" | "confirmed" | "cancelled" | string;
  isCashSale: boolean;
  discountPercent: number;
  discountReason: string | null;
  createdByName: string;
  createdRole: AppRole;
  createdAt: string;
  cancelReason: string | null;
  lines: OrderLine[];
  proformas: Proforma[];
  invoice: Invoice | null;
  /** The newest discount request, decided or not. `null` when none was ever raised. */
  discount: DiscountRequest | null;
  /** Reserved or committed quantity per order line, for the screen to name the claim. */
  reservedQuantity: number;
};

function nameOf(profile: unknown): string {
  const value = profile as { full_name: string } | { full_name: string }[] | null;
  return (Array.isArray(value) ? value[0]?.full_name : value?.full_name) ?? "";
}

export async function loadCustomers(): Promise<Customer[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("customers")
      .select("id, name, is_active, is_cash_customer")
      .order("is_cash_customer", { ascending: false })
      .order("name"),
    "sales.customers",
  );

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    isActive: row.is_active as boolean,
    isCashCustomer: row.is_cash_customer as boolean,
  }));
}

export async function loadAvailability(): Promise<Availability[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("product_availability")
      .select(
        "product_id, physical_quantity, reserved_quantity, committed_quantity, available_quantity",
      ),
    "sales.availability",
  );

  return rows.map((row) => ({
    productId: row.product_id as string,
    physical: Number(row.physical_quantity),
    reserved: Number(row.reserved_quantity),
    committed: Number(row.committed_quantity),
    available: Number(row.available_quantity),
  }));
}

/** The list, without the per-order detail that only the detail screen needs. */
export type OrderSummary = {
  id: string;
  orderNo: string;
  customerName: string;
  status: string;
  isCashSale: boolean;
  totalTzs: number;
  invoiceNo: string | null;
  createdAt: string;
};

export async function loadOrders(): Promise<OrderSummary[]> {
  const supabase = await createServerSupabase();

  // Concurrent: neither read depends on the other, and on this deployment every serial round trip
  // crosses the Atlantic twice (reviews/pr-04-review-brief.md §2).
  const [orderRows, proformaRows, invoiceRows] = await Promise.all([
    supabase
      .from("orders")
      .select(`
        id, order_no, status, is_cash_sale, created_at,
        customers!inner(name)
      `)
      .order("created_at", { ascending: false })
      .limit(200),
    // The LIVE version of each order's quotation — the one that has not been superseded.
    supabase
      .from("proformas")
      .select("order_id, total_tzs, version")
      .is("superseded_at", null),
    supabase.from("invoices").select("order_id, invoice_no, total_tzs, cancelled_at"),
  ]);

  const orders = requireRows(orderRows, "sales.orders");
  const proformas = requireRows(proformaRows, "sales.proformas");
  const invoices = requireRows(invoiceRows, "sales.invoices");

  const liveProforma = new Map(
    proformas.map((row) => [row.order_id as string, Number(row.total_tzs)]),
  );
  const invoiceByOrder = new Map(
    invoices.map((row) => [
      row.order_id as string,
      { invoiceNo: row.invoice_no as string, totalTzs: Number(row.total_tzs) },
    ]),
  );

  return orders.map((row) => {
    const customer = row.customers as { name: string } | { name: string }[] | null;
    const orderId = row.id as string;
    const invoice = invoiceByOrder.get(orderId) ?? null;

    return {
      id: orderId,
      orderNo: row.order_no as string,
      customerName: (Array.isArray(customer) ? customer[0]?.name : customer?.name) ?? "",
      status: row.status as string,
      isCashSale: row.is_cash_sale as boolean,
      // The invoice is the financial truth once one exists; before that the live proforma is what
      // the customer has been quoted. Showing a stale figure on a confirmed order would be showing
      // a number nobody owes.
      totalTzs: invoice?.totalTzs ?? liveProforma.get(orderId) ?? 0,
      invoiceNo: invoice?.invoiceNo ?? null,
      createdAt: row.created_at as string,
    };
  });
}

export async function loadOrder(orderId: string): Promise<Order | null> {
  const supabase = await createServerSupabase();

  // The creator's name does NOT come from an embedded `profiles` join, and that is the whole point.
  // `profiles` admits a Manager and a Director and otherwise only your own row, so the join
  // returned null for a Cashier or a second Sales Representative and the screen said
  // "Created by  (Sales Representative)". `api.staff_order_creator_name` answers that one question
  // for the live roles §4.2 already lets read the order, and answers nothing else about the person.
  const { data: orderRow, error: orderError } = await supabase
    .from("orders")
    .select(`
      id, order_no, customer_id, status, is_cash_sale, discount_percent, discount_reason,
      created_role, created_at, cancel_reason,
      customers!inner(name)
    `)
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    // Same rule as `requireRows`: a failed read is not a missing order. The provider's message
    // names tables and values, so it goes to the server log and never onto the thrown error.
    console.error(`[data] sales.order failed: ${orderError.message}`);
    throw new Error(`data_unavailable: sales.order`);
  }

  // A genuine absence, which the caller turns into a 404 rather than a retry.
  if (!orderRow) return null;

  const [creatorName, lineRows, proformaRows, proformaLineRows, invoiceRows, invoiceLineRows,
    discountRows, allocationRows] =
    await Promise.all([
      supabase.schema("api").rpc("staff_order_creator_name", { p_order_id: orderId }),
      supabase
        .from("order_lines")
        .select("id, product_id, quantity, unit_price_tzs, line_total_tzs")
        .eq("order_id", orderId),
      supabase
        .from("proformas")
        .select(`
          id, version, proforma_no, subtotal_tzs, discount_tzs, total_tzs, valid_until, issued_at,
          superseded_at
        `)
        .eq("order_id", orderId)
        .order("version", { ascending: false }),
      supabase
        .from("proforma_lines")
        .select(`
          id, proforma_id, product_name, product_specification, unit_code, unit_content,
          quantity, unit_price_tzs, line_total_tzs
        `),
      supabase
        .from("invoices")
        .select(`
          id, invoice_no, subtotal_tzs, discount_tzs, total_tzs, business_date, issued_at,
          cancelled_at, cancel_reason
        `)
        .eq("order_id", orderId)
        .maybeSingle(),
      supabase
        .from("invoice_lines")
        .select(`
          id, invoice_id, product_name, product_specification, unit_code, unit_content,
          quantity, unit_price_tzs, line_total_tzs
        `),
      supabase
        .from("approval_requests")
        .select(`
          id, requested_percent, required_role, status, request_seq,
          requester:profiles!approval_requests_requested_by_fkey(full_name),
          approver:profiles!approval_requests_approved_by_fkey(full_name)
        `)
        .eq("entity_type", "order")
        .eq("entity_id", orderId)
        .eq("approval_type", "discount")
        .order("request_seq", { ascending: false }),
      supabase
        .from("stock_allocations")
        .select("quantity, state")
        .eq("order_id", orderId),
    ]);

  const lines = requireRows(lineRows, "sales.order_lines");
  const proformas = requireRows(proformaRows, "sales.order_proformas");
  const proformaLines = requireRows(proformaLineRows, "sales.proforma_lines");
  const invoiceLines = requireRows(invoiceLineRows, "sales.invoice_lines");
  const discounts = requireRows(discountRows, "sales.discounts");
  const allocations = requireRows(allocationRows, "sales.allocations");

  // The order row is already in hand, so its creator exists and this caller is entitled to the
  // name: the command answers every live role, and reading the order at all required one. A
  // refusal, a null or anything that is not text therefore means the READ failed — and a failed
  // read is not a blank name. Handing back a half-built order and letting the screen print
  // "Created by  (Sales Representative)" is the same lie as `data ?? []`, one field down.
  const createdByName = requireText(creatorName, "sales.order_creator");

  if (invoiceRows.error) {
    console.error(`[data] sales.invoice failed: ${invoiceRows.error.message}`);
    throw new Error(`data_unavailable: sales.invoice`);
  }

  function toLine(row: Record<string, unknown>): ProformaLine {
    return {
      id: row.id as string,
      productName: row.product_name as string,
      productSpecification: (row.product_specification as string | null) ?? null,
      unitCode: row.unit_code as string,
      unitContent: (row.unit_content as string | null) ?? null,
      quantity: Number(row.quantity),
      unitPriceTzs: Number(row.unit_price_tzs),
      lineTotalTzs: Number(row.line_total_tzs),
    };
  }

  const customer = orderRow.customers as { name: string } | { name: string }[] | null;
  const invoiceRow = invoiceRows.data;
  const discountRow = discounts[0] ?? null;

  return {
    id: orderRow.id as string,
    orderNo: orderRow.order_no as string,
    customerId: orderRow.customer_id as string,
    customerName: (Array.isArray(customer) ? customer[0]?.name : customer?.name) ?? "",
    status: orderRow.status as string,
    isCashSale: orderRow.is_cash_sale as boolean,
    discountPercent: Number(orderRow.discount_percent),
    discountReason: (orderRow.discount_reason as string | null) ?? null,
    createdByName,
    createdRole: orderRow.created_role as AppRole,
    createdAt: orderRow.created_at as string,
    cancelReason: (orderRow.cancel_reason as string | null) ?? null,
    lines: lines.map((row) => ({
      id: row.id as string,
      productId: row.product_id as string,
      quantity: Number(row.quantity),
      unitPriceTzs: Number(row.unit_price_tzs),
      lineTotalTzs: Number(row.line_total_tzs),
    })),
    proformas: proformas.map((row) => ({
      id: row.id as string,
      version: Number(row.version),
      proformaNo: row.proforma_no as string,
      subtotalTzs: Number(row.subtotal_tzs),
      discountTzs: Number(row.discount_tzs),
      totalTzs: Number(row.total_tzs),
      validUntil: row.valid_until as string,
      issuedAt: row.issued_at as string,
      supersededAt: (row.superseded_at as string | null) ?? null,
      lines: proformaLines
        .filter((line) => line.proforma_id === row.id)
        .map((line) => toLine(line as Record<string, unknown>)),
    })),
    invoice: invoiceRow
      ? {
          id: invoiceRow.id as string,
          invoiceNo: invoiceRow.invoice_no as string,
          subtotalTzs: Number(invoiceRow.subtotal_tzs),
          discountTzs: Number(invoiceRow.discount_tzs),
          totalTzs: Number(invoiceRow.total_tzs),
          businessDate: invoiceRow.business_date as string,
          issuedAt: invoiceRow.issued_at as string,
          cancelledAt: (invoiceRow.cancelled_at as string | null) ?? null,
          cancelReason: (invoiceRow.cancel_reason as string | null) ?? null,
          lines: invoiceLines
            .filter((line) => line.invoice_id === invoiceRow.id)
            .map((line) => toLine(line as Record<string, unknown>)),
        }
      : null,
    discount: discountRow
      ? {
          id: discountRow.id as string,
          requestedPercent: Number(discountRow.requested_percent),
          requiredRole: discountRow.required_role as AppRole,
          status: discountRow.status as string,
          requestedByName: nameOf(discountRow.requester),
          decidedByName: nameOf(discountRow.approver) || null,
          note: null,
        }
      : null,
    reservedQuantity: allocations
      .filter((row) => row.state === "reserved" || row.state === "committed")
      .reduce((sum, row) => sum + Number(row.quantity), 0),
  };
}
