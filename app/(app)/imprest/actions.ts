"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import type { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import type { AppRole } from "@/lib/auth/roles";
import {
  cancelDisbursement,
  confirmReceived,
  correctHandover,
  decideDisbursement,
  decideFunding,
  increaseApproval,
  proposeDisbursement,
  provideFunding,
  reportMismatch,
  requestFunding,
  withdrawDisbursement,
  type ImprestResult,
} from "@/lib/imprest/commands";
import { formatTzs } from "@/lib/money";
import { fieldErrors } from "@/lib/validation/auth";
import {
  approveDisbursementSchema,
  approveFundingSchema,
  confirmReceivedSchema,
  correctHandoverSchema,
  disbursementReasonSchema,
  increaseApprovalSchema,
  proposeDisbursementSchema,
  provideFundingSchema,
  rejectFundingSchema,
  reportMismatchSchema,
  requestFundingSchema,
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
]);

type Messages = { namespace: "imprestErrors" | "spendingErrors"; known: Set<string> };
const FUNDING_MESSAGES: Messages = { namespace: "imprestErrors", known: KNOWN_ERRORS };
const SPENDING_MESSAGES: Messages = { namespace: "spendingErrors", known: SPENDING_ERRORS };

export type ImprestActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  errorValues?: Record<string, string | number>;
};

async function fromRefusal(
  result: Extract<ImprestResult, { ok: false }>,
  messages: Messages,
): Promise<ImprestActionState> {
  // Shillings in a refusal are shown the way every other amount is: grouped, in the viewer's locale.
  const locale = await getLocale();
  const values = result.context
    ? Object.fromEntries(
        Object.entries(result.context).map(([key, value]) => [
          key,
          key.endsWith("_tzs") && typeof value === "number" ? formatTzs(value, locale) : value,
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
