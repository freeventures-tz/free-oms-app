"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guard";
import {
  addStorekeeper,
  approveCredit,
  approvePaymentReversal,
  approveSettlement,
  assignDispatch,
  confirmRelease,
  recordDispatchNote,
  recordPayment,
  rejectCredit,
  requestCredit,
  requestPaymentReversal,
  setStorekeeperActive,
  takeCashPayment,
} from "@/lib/settlement/commands";
import { fieldErrors } from "@/lib/validation/auth";
import {
  addStorekeeperSchema,
  assignDispatchSchema,
  cashSaleSchema,
  creditDecisionSchema,
  creditRejectionSchema,
  dispatchActionSchema,
  invoiceActionSchema,
  paymentReversalDecisionSchema,
  paymentReversalSchema,
  recordNoteSchema,
  recordPaymentSchema,
  requestCreditSchema,
  setStorekeeperActiveSchema,
} from "@/lib/validation/settlement";

/**
 * Settlement and dispatch writes (product.md §12.5, §12.6, §14, §4.1).
 *
 * `requireRole` produces the right SCREEN and refuses early. It is NOT what authorises the change:
 * every `api` function derives the acting person from the same session independently and takes no
 * actor, and the tables carry no write grant for `authenticated`.
 *
 * The roles below are §4.1 and §12.6 as written, including where that is narrow — a Manager cannot
 * take money and a Cashier cannot confirm a release, because the document gives each step to one
 * role and inferring a stand-in from seniority is exactly the invention rule 3 forbids.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "generic",
  "idempotency_key_conflict",
  // Storekeepers
  "storekeeper_name_required",
  "storekeeper_exists",
  "storekeeper_unchanged",
  "storekeeper_state_required",
  "start_date_invalid",
  "no_storekeeper",
  // Payments and credit
  "no_invoice",
  "no_order",
  "invoice_cancelled",
  "amount_invalid",
  "payment_exceeds_balance",
  "credit_exceeds_balance",
  "credit_already_requested",
  "no_credit_request",
  "director_approval_required",
  "not_settled",
  "already_settled",
  "not_a_cash_sale",
  "order_not_confirmable",
  "cash_sale_must_be_paid_in_full",
  "insufficient_stock",
  // Dispatch
  "not_releasable",
  "no_location",
  "no_allocation",
  "lines_required",
  "line_invalid",
  "quantity_invalid",
  "exceeds_outstanding",
  "no_dispatch",
  "dispatch_not_assignable",
  "dispatch_note_required",
  "dispatch_note_in_use",
  "dispatch_note_missing",
  "insufficient_stock_at_location",
  // Reversals
  "no_payment",
  "cannot_reverse_a_reversal",
  "already_reversed",
  "reversal_already_pending",
  "no_approval_request",
  "reason_required",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason) ? `settlementErrors.${reason}` : "settlementErrors.generic";
}

export type SettlementActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  /** The figures a refusal needs to be actionable — a balance, a limit, what is available. */
  errorValues?: Record<string, string | number>;
};

function values(
  context: Record<string, unknown> | undefined,
): Record<string, string | number> | undefined {
  if (!context) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(context)) out[key] = Number(value);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Settling or releasing changes the money screens, the order and what the yard has left. */
function revalidateSettlement() {
  revalidatePath("/payments");
  revalidatePath("/dispatch");
  revalidatePath("/orders");
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

// ---------------------------------------------------------------------------
// Storekeepers — Director only (product.md §3.2)
// ---------------------------------------------------------------------------
export async function addStorekeeperAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["director"]);

  const parsed = addStorekeeperSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone") ?? "",
    startDate: formData.get("startDate"),
    note: formData.get("note") ?? "",
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addStorekeeper(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/storekeepers");
  revalidatePath("/dispatch");
  return { successKey: "settlement.storekeepers.added" };
}

export async function setStorekeeperActiveAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["director"]);

  const parsed = setStorekeeperActiveSchema.safeParse({
    storekeeperId: formData.get("storekeeperId"),
    isActive: formData.get("isActive"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await setStorekeeperActive(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/storekeepers");
  revalidatePath("/dispatch");
  return {
    successKey: parsed.data.isActive
      ? "settlement.storekeepers.reactivated"
      : "settlement.storekeepers.deactivated",
  };
}

// ---------------------------------------------------------------------------
// Money — Cashier (product.md §12.6 step 6)
// ---------------------------------------------------------------------------
export async function recordPaymentAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier"]);

  const parsed = recordPaymentSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    method: formData.get("method"),
    amount: formData.get("amount"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await recordPayment({
    invoiceId: parsed.data.invoiceId,
    method: parsed.data.method,
    amountTzs: parsed.data.amount,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.payments.recorded" };
}

export async function requestCreditAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier"]);

  const parsed = requestCreditSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await requestCredit({
    invoiceId: parsed.data.invoiceId,
    amountTzs: parsed.data.amount,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return {
    successKey:
      result.data?.required_role === "director"
        ? "settlement.credit.requestedDirector"
        : "settlement.credit.requestedManager",
  };
}

export async function approveCreditAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["manager", "director"]);

  const parsed = creditDecisionSchema.safeParse({
    creditId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveCredit(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.credit.approved" };
}

export async function rejectCreditAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["manager", "director"]);

  const parsed = creditRejectionSchema.safeParse({
    creditId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectCredit(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateSettlement();
  return { successKey: "settlement.credit.rejected" };
}

export async function approveSettlementAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier"]);

  const parsed = invoiceActionSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveSettlement(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.payments.settled" };
}

/**
 * The atomic walk-in sale (product.md §12.4).
 *
 * One action because the database does it in one transaction: stock, tender, invoice, settlement
 * and commitment together, or nothing at all (AC-88, AC-89). The screen presents it as one
 * confirmation, never as four saves.
 */
export async function takeCashPaymentAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier"]);

  const parsed = cashSaleSchema.safeParse({
    orderId: formData.get("orderId"),
    method: formData.get("method"),
    amount: formData.get("amount"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await takeCashPayment({
    orderId: parsed.data.orderId,
    method: parsed.data.method,
    amountTzs: parsed.data.amount,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.payments.cashSaleCompleted" };
}

// ---------------------------------------------------------------------------
// Dispatch — Cashier assigns, Manager records the note and confirms (§12.6 steps 9, 11, 13)
// ---------------------------------------------------------------------------
export async function assignDispatchAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier"]);

  const parsed = assignDispatchSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    storekeeperId: formData.get("storekeeperId"),
    sourceLocation: formData.get("sourceLocation"),
    lines: parseLines(formData.get("lines")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await assignDispatch(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.dispatch.assigned" };
}

export async function recordDispatchNoteAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["manager"]);

  const parsed = recordNoteSchema.safeParse({
    dispatchId: formData.get("dispatchId"),
    noteNo: formData.get("noteNo"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await recordDispatchNote(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateSettlement();
  return { successKey: "settlement.dispatch.noteRecorded" };
}

export async function confirmReleaseAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["manager"]);

  const parsed = dispatchActionSchema.safeParse({
    dispatchId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await confirmRelease(parsed.data);

  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: values(result.context) };
  }

  revalidateSettlement();
  return { successKey: "settlement.dispatch.released" };
}

// ---------------------------------------------------------------------------
// Payment reversal — Cashier or Manager asks, a DIRECTOR decides (§4.1, AC-21)
// ---------------------------------------------------------------------------
export async function requestPaymentReversalAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["cashier", "manager"]);

  const parsed = paymentReversalSchema.safeParse({
    paymentId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await requestPaymentReversal(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateSettlement();
  return { successKey: "settlement.reversal.requested" };
}

export async function approvePaymentReversalAction(
  _previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  await requireRole(["director"]);

  const parsed = paymentReversalDecisionSchema.safeParse({
    paymentId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approvePaymentReversal(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateSettlement();
  return { successKey: "settlement.reversal.approved" };
}
