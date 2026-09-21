import { userApi } from "@/lib/supabase/api";

/**
 * Imprest funding commands (issue #48). Each one calls a single `api` function through the
 * caller's own session: the database derives the actor, checks the live role, the version on
 * screen and the idempotency key, and commits any refusal to the audit trail. Nothing here decides
 * anything the database does not decide again.
 */

export type ImprestResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string; context?: Record<string, string | number> };

const CONTEXT_KEYS = ["approved_amount_tzs", "provided_amount_tzs", "status"] as const;

function mapDatabaseError(message: string): string {
  if (/not a live Director|may not perform this command|authenticated session/i.test(message)) {
    return "not_permitted";
  }
  return "generic";
}

async function call(fn: string, args: Record<string, unknown>): Promise<ImprestResult> {
  const api = await userApi();
  const { data, error } = await api.rpc(fn, args);
  if (error) return { ok: false, reason: mapDatabaseError(error.message) };

  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok === true) return { ok: true, reason: String(result.reason) };

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
