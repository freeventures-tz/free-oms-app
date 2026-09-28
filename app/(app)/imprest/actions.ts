"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import type { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import type { AppRole } from "@/lib/auth/roles";
import {
  cancelDisbursement,
  confirmCount,
  confirmReceived,
  correctHandover,
  decideDisbursement,
  decideFunding,
  enterCount,
  handOutDisbursement,
  increaseApproval,
  openReceipt,
  proposeDisbursement,
  provideFunding,
  registerReceipt,
  reportMismatch,
  requestFunding,
  sendBackCount,
  sendBackSettlement,
  settleDisbursement,
  verifyDisbursement,
  withdrawDisbursement,
  type ImprestResult,
  type ReceiptTicket,
} from "@/lib/imprest/commands";
import { RECEIPT_BUCKET, RECEIPT_LINK_SECONDS } from "@/lib/imprest/spending";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate } from "@/lib/time/business-date";
import { createServerSupabase } from "@/lib/supabase/server";
import { fieldErrors } from "@/lib/validation/auth";
import {
  approveDisbursementSchema,
  approveFundingSchema,
  confirmCountSchema,
  confirmReceivedSchema,
  correctHandoverSchema,
  disbursementReasonSchema,
  enterCountSchema,
  handOutSchema,
  increaseApprovalSchema,
  proposeDisbursementSchema,
  provideFundingSchema,
  registerReceiptSchema,
  rejectFundingSchema,
  reportMismatchSchema,
  requestFundingSchema,
  sendBackCountSchema,
  sendBackSchema,
  settleSchema,
  verifyDisbursementSchema,
} from "@/lib/validation/imprest";

/**
 * Imprest funding writes (product.md §13.2, issue #48).
 *
 * `requireRole` gives the right screen and refuses early. It is not what authorises the change:
 * every `api` function derives the actor from the same session, re-checks the live role, and
 * refuses a version or handover the caller was not shown.
 *
 * The Manager requests, confirms and reports a mismatch. A Director approves, rejects, increases
 * an approval, provides and corrects a handover. Neither can do the other's part.
 *
 * Disbursements (issue #55): the Cashier proposes and withdraws their own; the Manager approves,
 * rejects and cancels. A Director reads and does neither.
 */

const KNOWN_ERRORS = new Set([
  "not_permitted",
  "generic",
  "unconfirmed",
  "idempotency_key_conflict",
  "amount_invalid",
  "reason_required",
  "note_invalid",
  "explanation_required",
  "no_funding",
  "stale",
  "not_awaiting_decision",
  "not_open_for_approval_change",
  "not_awaiting_provision",
  "not_awaiting_receipt",
  "not_in_dispute",
  "exceeds_approval",
  "increase_not_higher",
  "counted_matches_provided",
]);

/**
 * Disbursement refusals have their own messages: the funding ones speak of requests and handovers,
 * which would mislead on a payment proposal.
 */
const SPENDING_ERRORS = new Set([
  "not_permitted",
  "generic",
  "unconfirmed",
  "idempotency_key_conflict",
  "amount_invalid",
  "reason_required",
  "stale",
  "not_awaiting_decision",
  "no_fund",
  "insufficient_imprest",
  "category_invalid",
  "purpose_required",
  "no_disbursement",
  "not_approved",
  "decision_required",
  // Hand-out and settlement (issue #62).
  "already_handed_out",
  "recipient_invalid",
  "not_handed_out",
  "over_approval",
  "returned_invalid",
  "lines_invalid",
  "too_many_lines",
  "line_amount_invalid",
  "line_purpose_invalid",
  "line_evidence_required",
  "line_evidence_both",
  "no_receipt_reason_invalid",
  "no_receipt_note_required",
  "receipt_not_found",
  "receipt_wrong_disbursement",
  "receipt_not_yours",
  "receipt_not_uploaded",
  "receipt_cited_twice",
  "explanation_required",
  "explanation_not_needed",
  "receipt_type_invalid",
  "receipt_too_large",
  "receipt_name_invalid",
  "too_many_receipts",
  "no_receipt",
  // Verification (issue #64).
  "not_settled",
  "settlement_not_latest",
]);

/** The daily count's refusals (issue #68) speak of the tin and the day, not of payments. */
const COUNT_ERRORS = new Set([
  "not_permitted",
  "generic",
  "unconfirmed",
  "idempotency_key_conflict",
  "no_fund",
  "day_changed",
  "already_confirmed",
  "count_awaiting_confirmation",
  "stale",
  "amount_invalid",
  "amount_too_large",
  "note_invalid",
  "no_count",
  "not_awaiting_confirmation",
  "reason_required",
  "explanation_required",
  "explanation_invalid",
  "explanation_note_required",
  "explanation_not_needed",
  "earlier_count_waiting",
  "figures_moved",
]);

type Messages = { namespace: "imprestErrors" | "spendingErrors" | "countErrors"; known: Set<string> };
const FUNDING_MESSAGES: Messages = { namespace: "imprestErrors", known: KNOWN_ERRORS };
const SPENDING_MESSAGES: Messages = { namespace: "spendingErrors", known: SPENDING_ERRORS };
const COUNT_MESSAGES: Messages = { namespace: "countErrors", known: COUNT_ERRORS };

export type ImprestActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  errorValues?: Record<string, string | number>;
};

async function fromRefusal(
  refusal: Extract<ImprestResult, { ok: false }>,
  messages: Messages,
): Promise<ImprestActionState> {
  // Cancel needs an approval that is still only approved. Once the cash is out the database says
  // `not_approved` with the status it met, and the Manager is told why in those words.
  const status = refusal.context?.status;
  const result =
    refusal.reason === "not_approved" &&
    (status === "handed_out" || status === "settled" || status === "sent_back" || status === "verified")
      ? { ...refusal, reason: "already_handed_out" }
      : refusal;
  // Shillings in a refusal are shown the way every other amount is: grouped, in the viewer's locale.
  const locale = await getLocale();
  const values = result.context
    ? Object.fromEntries(
        Object.entries(result.context).map(([key, value]) => [
          key,
          key.endsWith("_tzs") && typeof value === "number"
            ? formatTzs(value, locale)
            : key === "business_date" && typeof value === "string"
              ? formatBusinessDate(value, locale)
              : value,
        ]),
      )
    : undefined;
  return {
    error: `${messages.namespace}.${messages.known.has(result.reason) ? result.reason : "generic"}`,
    errorValues: values,
  };
}

async function run<S extends z.ZodTypeAny>(
  roles: AppRole[],
  schema: S,
  raw: Record<string, FormDataEntryValue | null>,
  command: (input: z.output<S>) => Promise<ImprestResult>,
  successKey: string,
  messages: Messages = FUNDING_MESSAGES,
): Promise<ImprestActionState> {
  await requireRole(roles);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await command(parsed.data);
  if (!result.ok) return await fromRefusal(result, messages);

  revalidatePath("/imprest", "layout");
  return { successKey };
}

const target = (data: FormData) => ({
  fundingId: data.get("fundingId"),
  expectedVersion: data.get("expectedVersion"),
  idempotencyKey: data.get("idempotencyKey"),
});

export async function requestFundingAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    requestFundingSchema,
    { amount: data.get("amount") ?? "", reason: data.get("reason") ?? "", idempotencyKey: data.get("idempotencyKey") },
    requestFunding,
    "imprest.success.requested",
  );
}

export async function approveFundingAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["director"],
    approveFundingSchema,
    { ...target(data), amount: data.get("amount") ?? "" },
    (input) => decideFunding({ ...input, approve: true, reason: null }),
    "imprest.success.approved",
  );
}

export async function rejectFundingAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["director"],
    rejectFundingSchema,
    { ...target(data), reason: data.get("reason") ?? "" },
    (input) => decideFunding({ ...input, approve: false, amount: null }),
    "imprest.success.rejected",
  );
}

export async function increaseApprovalAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["director"],
    increaseApprovalSchema,
    { ...target(data), amount: data.get("amount") ?? "", note: data.get("note") ?? "" },
    increaseApproval,
    "imprest.success.increased",
  );
}

export async function provideFundingAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["director"],
    provideFundingSchema,
    { ...target(data), amount: data.get("amount") ?? "" },
    provideFunding,
    "imprest.success.provided",
  );
}

export async function confirmReceivedAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    confirmReceivedSchema,
    { ...target(data), handoverId: data.get("handoverId") },
    confirmReceived,
    "imprest.success.received",
  );
}

export async function reportMismatchAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    reportMismatchSchema,
    {
      ...target(data),
      handoverId: data.get("handoverId"),
      counted: data.get("counted") ?? "",
      note: data.get("note") ?? "",
    },
    reportMismatch,
    "imprest.success.mismatch",
  );
}

export async function correctHandoverAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["director"],
    correctHandoverSchema,
    { ...target(data), amount: data.get("amount") ?? "", explanation: data.get("explanation") ?? "" },
    correctHandover,
    "imprest.success.corrected",
  );
}

const disbursementTarget = (data: FormData) => ({
  disbursementId: data.get("disbursementId"),
  expectedVersion: data.get("expectedVersion"),
  idempotencyKey: data.get("idempotencyKey"),
});

export async function proposeDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["cashier"],
    proposeDisbursementSchema,
    {
      amount: data.get("amount") ?? "",
      category: data.get("category") ?? "",
      purpose: data.get("purpose") ?? "",
      idempotencyKey: data.get("idempotencyKey"),
    },
    proposeDisbursement,
    "imprest.spending.success.proposed",
    SPENDING_MESSAGES,
  );
}

export async function approveDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    approveDisbursementSchema,
    disbursementTarget(data),
    (input) => decideDisbursement({ ...input, approve: true, reason: null }),
    "imprest.spending.success.approved",
    SPENDING_MESSAGES,
  );
}

export async function rejectDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    disbursementReasonSchema,
    { ...disbursementTarget(data), reason: data.get("reason") ?? "" },
    (input) => decideDisbursement({ ...input, approve: false }),
    "imprest.spending.success.rejected",
    SPENDING_MESSAGES,
  );
}

export async function withdrawDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["cashier"],
    disbursementReasonSchema,
    { ...disbursementTarget(data), reason: data.get("reason") ?? "" },
    withdrawDisbursement,
    "imprest.spending.success.withdrawn",
    SPENDING_MESSAGES,
  );
}

export async function cancelDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    disbursementReasonSchema,
    { ...disbursementTarget(data), reason: data.get("reason") ?? "" },
    cancelDisbursement,
    "imprest.spending.success.cancelled",
    SPENDING_MESSAGES,
  );
}

/** The Manager verifies a settlement as it stands (issue #64). */
export async function verifyDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    verifyDisbursementSchema,
    { ...disbursementTarget(data), settlementId: data.get("settlementId") },
    verifyDisbursement,
    "imprest.spending.success.verified",
    SPENDING_MESSAGES,
  );
}

/** The Manager sends the settlement they were shown back to the Cashier, with a reason (issue #65). */
export async function sendBackSettlementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    sendBackSchema,
    { ...disbursementTarget(data), settlementId: data.get("settlementId"), reason: data.get("reason") ?? "" },
    sendBackSettlement,
    "imprest.spending.success.sentBack",
    SPENDING_MESSAGES,
  );
}

// Hand-out and settlement (issue #62): the Cashier who proposed the disbursement does both.

export async function handOutDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["cashier"],
    handOutSchema,
    { ...disbursementTarget(data), recipient: data.get("recipient") ?? "" },
    handOutDisbursement,
    "imprest.spending.success.handedOut",
    SPENDING_MESSAGES,
  );
}

export async function settleDisbursementAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["cashier"],
    settleSchema,
    {
      ...disbursementTarget(data),
      approved: data.get("approved"),
      lines: data.get("lines") ?? "[]",
      returned: data.get("returned") ?? "",
      explanation: data.get("explanation") ?? "",
    },
    settleDisbursement,
    "imprest.spending.success.settled",
    SPENDING_MESSAGES,
  );
}

// The daily count (issue #68): the Cashier counts, the Manager confirms or sends back.

export async function enterCountAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["cashier"],
    enterCountSchema,
    {
      businessDate: data.get("businessDate") ?? "",
      previousCountId: data.get("previousCountId") ?? "",
      counted: data.get("counted") ?? "",
      note: data.get("note") ?? "",
      idempotencyKey: data.get("idempotencyKey"),
    },
    enterCount,
    "imprest.count.success.counted",
    COUNT_MESSAGES,
  );
}

const countTarget = (data: FormData) => ({
  countId: data.get("countId"),
  expectedVersion: data.get("expectedVersion"),
  idempotencyKey: data.get("idempotencyKey"),
});

export async function confirmCountAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    confirmCountSchema,
    {
      ...countTarget(data),
      variance: data.get("variance"),
      explanation: data.get("explanation") ?? "",
      note: data.get("note") ?? "",
    },
    confirmCount,
    "imprest.count.success.confirmed",
    COUNT_MESSAGES,
  );
}

export async function sendBackCountAction(_p: ImprestActionState, data: FormData) {
  return run(
    ["manager"],
    sendBackCountSchema,
    { ...countTarget(data), reason: data.get("reason") ?? "" },
    sendBackCount,
    "imprest.count.success.sentBack",
    COUNT_MESSAGES,
  );
}

export type ReceiptTicketState = { ticket?: ReceiptTicket; error?: string };

/**
 * Files one receipt and returns where to upload it and the key to encrypt it with. The key goes
 * only to the Cashier who is filing it; the database checks that again.
 */
export async function registerReceiptAction(input: {
  disbursementId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  idempotencyKey: string;
}): Promise<ReceiptTicketState> {
  await requireRole(["cashier"]);
  const parsed = registerReceiptSchema.safeParse(input);
  if (!parsed.success) {
    return { error: Object.values(fieldErrors(parsed.error))[0] ?? "spendingErrors.generic" };
  }
  const result = await registerReceipt(parsed.data);
  if (!result.ok) return { error: (await fromRefusal(result, SPENDING_MESSAGES)).error };
  return { ticket: result.ticket };
}

export type OpenReceiptState = { ticket?: ReceiptTicket; url?: string; error?: string };

/**
 * A receipt's key and a signed link to its stored bytes, valid for a minute. Both come through the
 * viewer's own session, so each is refused to anybody who may not see the receipt.
 */
export async function openReceiptAction(receiptId: string): Promise<OpenReceiptState> {
  await requireRole(["director", "manager", "cashier"]);
  if (!/^[0-9a-f-]{36}$/i.test(receiptId)) return { error: "spendingErrors.no_receipt" };
  const opened = await openReceipt(receiptId);
  if (!opened.ok) return { error: (await fromRefusal(opened, SPENDING_MESSAGES)).error };

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .createSignedUrl(opened.ticket.objectPath, RECEIPT_LINK_SECONDS);
  if (error || !data) return { error: "spendingErrors.receipt_unavailable" };
  return { ticket: opened.ticket, url: data.signedUrl };
}
