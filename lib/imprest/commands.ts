import { userApi } from "@/lib/supabase/api";

/**
 * Imprest funding commands (issue #48) and disbursement commands (issue #55). Each one calls a
 * single `api` function through the caller's own session: the database derives the actor, checks
 * the live role, the version on screen and the idempotency key, and commits any refusal to the
 * audit trail. Nothing here decides anything the database does not decide again.
 */

export type ImprestResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string; context?: Record<string, string | number> };

// `free_to_approve_tzs` and `amount_tzs` come with a disbursement approval refused as
// `insufficient_imprest` (issue #55), so the Manager is told how much is free.
const CONTEXT_KEYS = [
  "approved_amount_tzs",
  "provided_amount_tzs",
  "status",
  "free_to_approve_tzs",
  "amount_tzs",
  // A settlement refusal (issue #62) names the line it met and the figures it compared.
  "line",
  "used_tzs",
  "returned_tzs",
  "unaccounted_tzs",
] as const;

/**
 * Only an error that carries a code is an answer: PostgREST or PostgreSQL refused the call, and its
 * transaction rolled back. postgrest-js RETURNS a dropped connection as an error with an empty code,
 * and a gateway page as one with none, and in both cases the command may already have committed.
 * That is `unconfirmed`, never "nothing was changed": only a retry with the same key can tell.
 */
function mapDatabaseError(error: { message: string; code?: string }): string {
  if (!error.code) return "unconfirmed";
  if (/not a live Director|may not perform this command|authenticated session/i.test(error.message)) {
    return "not_permitted";
  }
  return "generic";
}

async function call(fn: string, args: Record<string, unknown>): Promise<ImprestResult> {
  const answer = await callFor(fn, args);
  return answer.ok ? { ok: true, reason: answer.reason } : answer;
}

/** `call`, keeping the whole successful answer for the commands that return data. */
async function callFor(
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; reason: string; data: Record<string, unknown> } | Extract<ImprestResult, { ok: false }>> {
  const api = await userApi();
  const { data, error } = await api.rpc(fn, args);
  if (error) return { ok: false, reason: mapDatabaseError(error) };

  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok === true) return { ok: true, reason: String(result.reason), data: result };

  const context: Record<string, string | number> = {};
  for (const key of CONTEXT_KEYS) {
    const value = result[key];
    if (typeof value === "number" || typeof value === "string") context[key] = value;
  }
  return {
    ok: false,
    reason: typeof result.reason === "string" ? result.reason : "generic",
    context: Object.keys(context).length > 0 ? context : undefined,
  };
}

export const requestFunding = (input: { amount: number; reason: string; idempotencyKey: string }) =>
  call("staff_request_imprest_funding", {
    p_amount_tzs: input.amount,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

type Target = { fundingId: string; expectedVersion: number; idempotencyKey: string };

export const decideFunding = (
  input: Target & { approve: boolean; amount: number | null; reason: string | null },
) =>
  call("admin_decide_imprest_funding", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_approve: input.approve,
    p_amount_tzs: input.amount,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

export const increaseApproval = (input: Target & { amount: number; note: string }) =>
  call("admin_increase_imprest_approval", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_amount_tzs: input.amount,
    p_note: input.note || null,
    p_idempotency_key: input.idempotencyKey,
  });

export const provideFunding = (input: Target & { amount: number }) =>
  call("admin_record_imprest_provided", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_amount_tzs: input.amount,
    p_idempotency_key: input.idempotencyKey,
  });

export const confirmReceived = (input: Target & { handoverId: string }) =>
  call("staff_confirm_imprest_received", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_handover_id: input.handoverId,
    p_idempotency_key: input.idempotencyKey,
  });

export const reportMismatch = (input: Target & { handoverId: string; counted: number; note: string }) =>
  call("staff_report_imprest_mismatch", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_handover_id: input.handoverId,
    p_counted_tzs: input.counted,
    p_note: input.note || null,
    p_idempotency_key: input.idempotencyKey,
  });

export const correctHandover = (input: Target & { amount: number; explanation: string }) =>
  call("admin_resolve_imprest_mismatch", {
    p_funding_id: input.fundingId,
    p_expected_version: input.expectedVersion,
    p_amount_tzs: input.amount,
    p_explanation: input.explanation,
    p_idempotency_key: input.idempotencyKey,
  });

// Disbursements (issue #55). The Cashier proposes and withdraws; the Manager decides and cancels.

export const proposeDisbursement = (input: {
  amount: number;
  category: string;
  purpose: string;
  idempotencyKey: string;
}) =>
  call("staff_propose_imprest_disbursement", {
    p_amount_tzs: input.amount,
    p_category: input.category,
    p_purpose: input.purpose,
    p_idempotency_key: input.idempotencyKey,
  });

type DisbursementTarget = { disbursementId: string; expectedVersion: number; idempotencyKey: string };

/** There is no amount: the Manager approves the proposed figure as it stands, or rejects it. */
export const decideDisbursement = (
  input: DisbursementTarget & { approve: boolean; reason: string | null },
) =>
  call("staff_decide_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_approve: input.approve,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

export const withdrawDisbursement = (input: DisbursementTarget & { reason: string }) =>
  call("staff_withdraw_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

export const cancelDisbursement = (input: DisbursementTarget & { reason: string }) =>
  call("staff_cancel_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

/**
 * Verification (issue #64), the Manager's. There is no amount: the settlement the Manager was shown
 * is verified exactly as the Cashier submitted it. Used posts as the imprest expense and Not
 * accounted for as an unexplained loss.
 */
export const verifyDisbursement = (input: DisbursementTarget & { settlementId: string }) =>
  call("staff_verify_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_settlement_id: input.settlementId,
    p_idempotency_key: input.idempotencyKey,
  });

// Hand-out and settlement (issue #62). Only the Cashier who proposed a disbursement does either.

/** There is no amount: the approved amount is what goes out, and change comes back as Returned. */
export const handOutDisbursement = (input: DisbursementTarget & { recipient: string }) =>
  call("staff_hand_out_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_recipient: input.recipient,
    p_idempotency_key: input.idempotencyKey,
  });

/** A receipt as the database filed it. `key` is its AES-256 key, base64. */
export type ReceiptTicket = {
  id: string;
  objectPath: string;
  fileName: string;
  contentType: string;
  key: string;
};

function ticketFrom(data: Record<string, unknown>): ReceiptTicket {
  const receipt = data.receipt as Record<string, unknown>;
  return {
    id: String(receipt.id),
    objectPath: String(receipt.object_path),
    fileName: String(receipt.file_name),
    contentType: String(receipt.content_type),
    key: String(receipt.key),
  };
}

export async function registerReceipt(input: {
  disbursementId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  idempotencyKey: string;
}): Promise<{ ok: true; ticket: ReceiptTicket } | Extract<ImprestResult, { ok: false }>> {
  const answer = await callFor("staff_register_imprest_receipt", {
    p_disbursement_id: input.disbursementId,
    p_file_name: input.fileName,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
    p_idempotency_key: input.idempotencyKey,
  });
  return answer.ok ? { ok: true, ticket: ticketFrom(answer.data) } : answer;
}

/** The key to one receipt, for somebody allowed to see it. A read: nothing is claimed. */
export async function openReceipt(
  receiptId: string,
): Promise<{ ok: true; ticket: ReceiptTicket } | Extract<ImprestResult, { ok: false }>> {
  const answer = await callFor("staff_open_imprest_receipt", { p_receipt_id: receiptId });
  return answer.ok ? { ok: true, ticket: ticketFrom(answer.data) } : answer;
}

export type SettlementLine = {
  amount: number;
  purpose: string;
  receiptId: string | null;
  reason: string | null;
  note: string;
};

export const settleDisbursement = (
  input: DisbursementTarget & { lines: SettlementLine[]; returned: number; explanation: string },
) =>
  call("staff_settle_imprest_disbursement", {
    p_id: input.disbursementId,
    p_expected_version: input.expectedVersion,
    p_lines: input.lines.map((line) => ({
      amount_tzs: line.amount,
      purpose: line.purpose,
      receipt_id: line.receiptId,
      no_receipt_reason: line.reason,
      no_receipt_note: line.note || null,
    })),
    p_returned_tzs: input.returned,
    p_explanation: input.explanation || null,
    p_idempotency_key: input.idempotencyKey,
  });
