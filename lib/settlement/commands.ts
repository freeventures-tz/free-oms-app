import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/settlement/methods";
import { userApi } from "@/lib/supabase/api";

/**
 * Settlement and dispatch commands (product.md §12.5, §12.6, §14, §4.1).
 *
 * Every one goes through the caller's OWN session. The `api` functions derive the acting person and
 * the roles they may hold from the verified JWT and take no actor, so there is no branch in this
 * file deciding who may approve a credit or confirm a release — the database decides.
 */

export type SettlementResult =
  | { ok: true; detail: string; data?: Record<string, unknown> }
  | { ok: false; reason: string; context?: Record<string, unknown> };

export type SettlementApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

// Re-exported so a server caller has one import for the whole settlement surface. The list
// itself lives in a client-safe module, because this file reaches `next/headers`.
export { PAYMENT_METHODS, type PaymentMethod };

function mapDatabaseError(message: string): string {
  if (/not a live Director|may not perform this command|authenticated session/i.test(message)) {
    return "not_permitted";
  }
  return "generic";
}

/** The one place a command result becomes a `SettlementResult`, so ten callers cannot differ. */
async function issue(
  api: SettlementApi,
  fn: string,
  args: Record<string, unknown>,
  successFallback: string,
): Promise<SettlementResult> {
  const { data, error } = await api.rpc(fn, args);

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };

  if (!data?.ok) {
    const context: Record<string, unknown> = {};
    // The refusals that are only actionable with their numbers.
    for (const key of [
      "outstanding",
      "offered",
      "available",
      "requested",
      "total",
      "amount_tzs",
      "manager_limit_tzs",
    ]) {
      if (key in data!) context[key] = Number((data as Record<string, unknown>)[key]);
    }
    return {
      ok: false,
      reason: String(data?.reason ?? "generic"),
      context: Object.keys(context).length > 0 ? context : undefined,
    };
  }

  return { ok: true, detail: String(data.reason ?? successFallback), data };
}

async function resolve(issuedBy?: SettlementApi): Promise<SettlementApi> {
  return issuedBy ?? ((await userApi()) as unknown as SettlementApi);
}

export async function addStorekeeper(
  input: {
    fullName: string;
    phone: string | null;
    startDate: string;
    note: string | null;
    idempotencyKey: string;
  },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "admin_add_storekeeper",
    {
      p_full_name: input.fullName,
      p_phone: input.phone,
      p_start_date: input.startDate,
      p_note: input.note,
      p_idempotency_key: input.idempotencyKey,
    },
    "added",
  );
}

export async function setStorekeeperActive(
  input: { storekeeperId: string; isActive: boolean; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "admin_set_storekeeper_active",
    {
      p_storekeeper_id: input.storekeeperId,
      p_is_active: input.isActive,
      p_idempotency_key: input.idempotencyKey,
    },
    "deactivated",
  );
}

export async function recordPayment(
  input: {
    invoiceId: string;
    method: PaymentMethod;
    amountTzs: number;
    idempotencyKey: string;
  },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_record_payment",
    {
      p_invoice_id: input.invoiceId,
      p_method: input.method,
      p_amount_tzs: input.amountTzs,
      p_idempotency_key: input.idempotencyKey,
    },
    "recorded",
  );
}

export async function requestCredit(
  input: { invoiceId: string; amountTzs: number; reason: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_request_credit",
    {
      p_invoice_id: input.invoiceId,
      p_amount_tzs: input.amountTzs,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "requested",
  );
}

export async function approveCredit(
  input: { creditId: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_credit",
    { p_credit_id: input.creditId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function rejectCredit(
  input: { creditId: string; reason: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_reject_credit",
    {
      p_credit_id: input.creditId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}

export async function approveSettlement(
  input: { invoiceId: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_settlement",
    { p_invoice_id: input.invoiceId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function takeCashPayment(
  input: {
    orderId: string;
    method: PaymentMethod;
    amountTzs: number;
    idempotencyKey: string;
  },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_take_cash_payment",
    {
      p_order_id: input.orderId,
      p_method: input.method,
      p_amount_tzs: input.amountTzs,
      p_idempotency_key: input.idempotencyKey,
    },
    "paid",
  );
}

export type DispatchLineInput = { allocationId: string; quantity: number };

export async function assignDispatch(
  input: {
    invoiceId: string;
    storekeeperId: string;
    sourceLocation: string;
    lines: DispatchLineInput[];
    idempotencyKey: string;
  },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_assign_dispatch",
    {
      p_invoice_id: input.invoiceId,
      p_storekeeper_id: input.storekeeperId,
      p_source_location: input.sourceLocation,
      p_lines: input.lines.map((line) => ({
        allocation_id: line.allocationId,
        quantity: line.quantity,
      })),
      p_idempotency_key: input.idempotencyKey,
    },
    "assigned",
  );
}

export async function recordDispatchNote(
  input: { dispatchId: string; noteNo: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_record_dispatch_note",
    {
      p_dispatch_id: input.dispatchId,
      p_note_no: input.noteNo,
      p_idempotency_key: input.idempotencyKey,
    },
    "recorded",
  );
}

export async function confirmRelease(
  input: { dispatchId: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_confirm_release",
    { p_dispatch_id: input.dispatchId, p_idempotency_key: input.idempotencyKey },
    "released",
  );
}

export async function requestPaymentReversal(
  input: { paymentId: string; reason: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "staff_request_payment_reversal",
    {
      p_payment_id: input.paymentId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "requested",
  );
}

export async function approvePaymentReversal(
  input: { paymentId: string; idempotencyKey: string },
  issuedBy?: SettlementApi,
): Promise<SettlementResult> {
  return issue(
    await resolve(issuedBy),
    "admin_approve_payment_reversal",
    { p_payment_id: input.paymentId, p_idempotency_key: input.idempotencyKey },
    "reversed",
  );
}
