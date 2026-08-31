"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guard";
import {
  addCustomer,
  approveDiscount,
  cancelOrder,
  confirmOrder,
  createOrder,
  rejectDiscount,
  requestDiscount,
  reviseProforma,
} from "@/lib/sales/commands";
import { fieldErrors } from "@/lib/validation/auth";
import {
  addCustomerSchema,
  createOrderSchema,
  orderDecisionSchema,
  orderReasonSchema,
  requestDiscountSchema,
  reviseOrderSchema,
} from "@/lib/validation/sales";

/**
 * Order writes (product.md §12, §4).
 *
 * `requireRole` produces the right SCREEN and refuses early. It is NOT what authorises the change:
 * every `api` function below derives the acting person from the same session independently and
 * takes no actor, and the tables carry no write grant for `authenticated` at all.
 *
 * Note what `approveDiscountAction` does NOT do: it does not check the 5% or the TZS 1,000,000
 * limit. A Manager and a Director may both call it, and the database decides which of them is
 * allowed to on this particular order — because the subtotal it is judged against can change after
 * the request is raised, and a check here would be reading a figure that has already moved.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "generic",
  "idempotency_key_conflict",
  "customer_name_required",
  "customer_exists",
  "no_customer",
  "no_order",
  "no_product",
  "product_has_no_price",
  "lines_required",
  "line_invalid",
  "duplicate_product_line",
  "quantity_invalid",
  "quantity_not_whole",
  "order_not_revisable",
  "order_not_confirmable",
  "discount_invalid",
  "discount_already_pending",
  "discount_pending",
  "director_approval_required",
  "no_approval_request",
  "already_settled",
  "reason_required",
  "no_proforma",
  "proforma_expired",
  "insufficient_stock",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason) ? `salesErrors.${reason}` : "salesErrors.generic";
}

export type SalesActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  /** The figures a refusal needs to be actionable — what is available, what was asked for. */
  errorValues?: Record<string, string | number>;
  /** Set when a command produced a record the screen should send the person to. */
  createdOrderId?: string;
};

function revalidateOrders(orderId?: string) {
  revalidatePath("/orders");
  if (orderId) revalidatePath(`/orders/${orderId}`);
  // A confirmation claims stock, so what the yard has left has changed too.
  revalidatePath("/inventory");
}

function parseLines(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** The two refusals that carry numbers, mapped once. */
function contextValues(
  context: Record<string, unknown> | undefined,
): Record<string, string | number> | undefined {
  if (!context) return undefined;
  const values: Record<string, string | number> = {};
  if ("available" in context) {
    values.available = Number(context.available);
    values.requested = Number(context.requested);
  }
  if ("requestedPercent" in context) {
    values.requestedPercent = Number(context.requestedPercent);
    values.subtotalTzs = Number(context.subtotalTzs);
  }
  if ("validUntil" in context) values.validUntil = String(context.validUntil);
  return Object.keys(values).length > 0 ? values : undefined;
}

export async function addCustomerAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = addCustomerSchema.safeParse({
    name: formData.get("name"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addCustomer(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/orders/new");
  return { successKey: "sales.customers.added" };
}

export async function createOrderAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = createOrderSchema.safeParse({
    customerId: formData.get("customerId"),
    lines: parseLines(formData.get("lines")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await createOrder(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: contextValues(result.context) };
  }

  const order = result.data?.order as { id: string } | undefined;
  revalidateOrders(order?.id);

  // The success state names the order and its proforma TOGETHER, and mentions no invoice
  // (design.md §7.6): telling a customer they have been billed before they have agreed to anything
  // is the one thing that screen must never do.
  return { successKey: "sales.orders.created", createdOrderId: order?.id };
}

export async function reviseOrderAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = reviseOrderSchema.safeParse({
    orderId: formData.get("orderId"),
    lines: parseLines(formData.get("lines")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await reviseProforma(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateOrders(parsed.data.orderId);
  return { successKey: "sales.orders.revised" };
}

export async function requestDiscountAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = requestDiscountSchema.safeParse({
    orderId: formData.get("orderId"),
    percent: formData.get("percent"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await requestDiscount(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateOrders(parsed.data.orderId);
  return {
    successKey:
      result.data?.required_role === "director"
        ? "sales.discount.requestedDirector"
        : "sales.discount.requestedManager",
  };
}

export async function approveDiscountAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["manager", "director"]);

  const parsed = orderDecisionSchema.safeParse({
    orderId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveDiscount(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: contextValues(result.context) };
  }

  revalidateOrders(parsed.data.orderId);
  return { successKey: "sales.discount.approved" };
}

export async function rejectDiscountAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["manager", "director"]);

  const parsed = orderReasonSchema.safeParse({
    orderId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectDiscount(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateOrders(parsed.data.orderId);
  return { successKey: "sales.discount.rejected" };
}

export async function confirmOrderAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = orderDecisionSchema.safeParse({
    orderId: formData.get("orderId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await confirmOrder(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: contextValues(result.context) };
  }

  revalidateOrders(parsed.data.orderId);

  // Two outcomes, named apart. §12.4: confirming a walk-in order creates no invoice and no
  // reservation, and a success message that said "invoice generated" would be a lie about the one
  // path where nothing was.
  return {
    successKey:
      result.detail === "confirmed_cash_sale"
        ? "sales.orders.confirmedCashSale"
        : "sales.orders.confirmed",
  };
}

export async function cancelOrderAction(
  _previous: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  await requireRole(["sales_rep", "manager", "director"]);

  const parsed = orderReasonSchema.safeParse({
    orderId: formData.get("orderId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await cancelOrder(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateOrders(parsed.data.orderId);
  return { successKey: "sales.orders.cancelled" };
}
