import { userApi } from "@/lib/supabase/api";

/**
 * Order commands (product.md §12, §4).
 *
 * Every one goes through the caller's OWN session. The `api` functions derive the acting person and
 * the roles they may hold from the verified JWT and take no actor, so there is no branch in this
 * file deciding whether somebody may approve a discount — the database decides, and a Manager
 * reaching beyond their limit is refused by it.
 */

export type SalesResult =
  | { ok: true; detail: string; data?: Record<string, unknown> }
  | { ok: false; reason: string; context?: Record<string, unknown> };

export type SalesApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

function mapDatabaseError(message: string): string {
  if (/not a live Director|may not perform this command|authenticated session/i.test(message)) {
    return "not_permitted";
  }
  return "generic";
}

/** The one place a command result becomes a `SalesResult`, so eight callers cannot differ. */
async function issue(
  api: SalesApi,
  fn: string,
  args: Record<string, unknown>,
  successFallback: string,
): Promise<SalesResult> {
  const { data, error } = await api.rpc(fn, args);

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };

  if (!data?.ok) {
    const reason = String(data?.reason ?? "generic");

    // Two refusals are only actionable with their numbers: not enough stock, and a discount beyond
    // the approver's authority. "No" on its own leaves the person guessing what to do next.
    const context: Record<string, unknown> = {};
    if (data && "available" in data) {
      context.available = Number(data.available);
      context.requested = Number(data.requested);
    }
    if (data && "requested_percent" in data) {
      context.requestedPercent = Number(data.requested_percent);
      context.subtotalTzs = Number(data.subtotal_tzs);
    }
    if (data && "valid_until" in data) {
      context.validUntil = String(data.valid_until);
    }

    return {
      ok: false,
      reason,
      context: Object.keys(context).length > 0 ? context : undefined,
    };
  }

  return { ok: true, detail: String(data.reason ?? successFallback), data };
}

async function resolve(issuedBy?: SalesApi): Promise<SalesApi> {
  return issuedBy ?? ((await userApi()) as unknown as SalesApi);
}

export async function addCustomer(
  input: { name: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_add_customer",
    { p_name: input.name, p_idempotency_key: input.idempotencyKey },
    "added",
  );
}

export type OrderLineInput = { productId: string; quantity: number };

export async function createOrder(
  input: { customerId: string; lines: OrderLineInput[]; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_create_order",
    {
      p_customer_id: input.customerId,
      // snake_case because the database reads these keys out of the jsonb directly. Naming them
      // twice is the price of not putting a second parsing layer between the form and the command.
      p_lines: input.lines.map((line) => ({
        product_id: line.productId,
        quantity: line.quantity,
      })),
      p_idempotency_key: input.idempotencyKey,
    },
    "created",
  );
}

export async function reviseProforma(
  input: { orderId: string; lines: OrderLineInput[]; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_revise_proforma",
    {
      p_order_id: input.orderId,
      p_lines: input.lines.map((line) => ({
        product_id: line.productId,
        quantity: line.quantity,
      })),
      p_idempotency_key: input.idempotencyKey,
    },
    "revised",
  );
}

export async function requestDiscount(
  input: { orderId: string; percent: number; reason: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_request_discount",
    {
      p_order_id: input.orderId,
      p_percent: input.percent,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "requested",
  );
}

export async function approveDiscount(
  input: { orderId: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_discount",
    { p_order_id: input.orderId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function rejectDiscount(
  input: { orderId: string; reason: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_reject_discount",
    {
      p_order_id: input.orderId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}

export async function confirmOrder(
  input: { orderId: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_confirm_order",
    { p_order_id: input.orderId, p_idempotency_key: input.idempotencyKey },
    "confirmed",
  );
}

export async function cancelOrder(
  input: { orderId: string; reason: string; idempotencyKey: string },
  issuedBy?: SalesApi,
): Promise<SalesResult> {
  return issue(
    await resolve(issuedBy),
    "staff_cancel_order",
    {
      p_order_id: input.orderId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "cancelled",
  );
}
