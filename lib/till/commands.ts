import type { PaymentMethod } from "@/lib/settlement/methods";
import { userApi } from "@/lib/supabase/api";

/**
 * Till count commands (issue #83). Each one calls a single `api` function through the caller's own
 * session: the database derives the actor, checks the live role, the version on screen and the
 * idempotency key, calculates every expected figure, and commits any refusal to the audit trail.
 * Nothing here decides anything the database does not decide again.
 */

export type TillResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string; context?: Record<string, string | number> };

const CONTEXT_KEYS = ["business_date", "variance_tzs", "status"] as const;

/**
 * Only an error that carries a code is an answer: the call was refused and rolled back. A dropped
 * connection comes back with no code, and the command may already have committed. That is
 * `unconfirmed`, never "nothing was changed": only a retry with the same key can tell.
 */
function mapDatabaseError(error: { message: string; code?: string }): string {
  if (!error.code) return "unconfirmed";
  if (/may not perform this command|authenticated session/i.test(error.message)) return "not_permitted";
  return "generic";
}

async function call(fn: string, args: Record<string, unknown>): Promise<TillResult> {
  const api = await userApi();
  const { data, error } = await api.rpc(fn, args);
  if (error) return { ok: false, reason: mapDatabaseError(error) };

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

/** Today's count, or a past Not counted day's with a late reason. A recount names the one it replaces. */
export const enterTillCount = (input: {
  businessDate: string;
  previousCountId: string | null;
  counted: Record<PaymentMethod, number>;
  note: string | null;
  lateReason: string | null;
  idempotencyKey: string;
}) =>
  call("staff_enter_till_count", {
    p_business_date: input.businessDate,
    p_previous_count_id: input.previousCountId,
    p_counted: input.counted,
    p_note: input.note,
    p_late_reason: input.lateReason,
    p_idempotency_key: input.idempotencyKey,
  });

type Target = { countId: string; expectedVersion: number; idempotencyKey: string };

/** There is no figure: the count is confirmed as it stands, with a preset reason for a difference. */
export const confirmTillCount = (input: Target & { explanation: string | null; note: string | null }) =>
  call("staff_confirm_till_count", {
    p_id: input.countId,
    p_expected_version: input.expectedVersion,
    p_explanation: input.explanation,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
  });

export const sendBackTillCount = (input: Target & { reason: string }) =>
  call("staff_send_back_till_count", {
    p_id: input.countId,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });
