import { randomUUID } from "node:crypto";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import type { AppRole } from "@/lib/auth/roles";
import { setAuthUserBanned } from "@/lib/admin/auth-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { serviceApi, userApi } from "@/lib/supabase/api";

/**
 * Director account administration.
 *
 * Authority is derived by the DATABASE from the caller's own session — `api.admin_*` takes no
 * actor. The secret key appears only where work leaves this database for Supabase Auth, and there
 * it can only continue a command an authenticated Director already issued.
 *
 * THE RULE THAT MAKES THAT SAFE: a cross-system side effect is performed under a CLAIM. Before
 * touching Auth the worker claims the command, and a command that is complete, reverted or failed
 * is not claimable at all. Replaying a completed reset used to issue a second temporary password
 * and silently invalidate the one the Director had already handed over; replaying a reverted phone
 * change used to push Auth to a number the database had already abandoned.
 *
 * Every continuation result is checked. Nothing here reports success when the database did not
 * confirm the operation.
 */

/** A caller acting under a Director's own session. Injectable so tests drive the real function. */
export type DirectorApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    // `jsonb` from PostgREST: the shape is whatever the function returned, so it is narrowed at the
    // point of use rather than pretended to be known here.
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

export type AdminResult = { ok: true; detail?: string } | { ok: false; reason: string };

function reasonOf(data: { reason?: unknown } | null, fallback: string): string {
  return String(data?.reason ?? fallback);
}

/**
 * Director-mediated password reset.
 *
 * The gate is re-armed inside the authenticated request, before any new credential exists, then the
 * command is claimed and exactly one worker performs the Auth change.
 */
export async function resetUserPassword(
  targetUserId: string,
  idempotencyKey: string,
  issuedBy?: DirectorApi,
): Promise<{ ok: true; temporaryPassword: string } | { ok: false; reason: string }> {
  const api = issuedBy ?? (await userApi());

  const { data: issued, error } = await api.rpc("admin_request_password_reset", {
    p_target_user_id: targetUserId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) return { ok: false, reason: "not_permitted" };
  if (!issued?.ok) return { ok: false, reason: reasonOf(issued, "arm_failed") };

  const commandId = issued.command?.id as string | undefined;
  if (!commandId) return { ok: false, reason: "no_command" };

  const service = serviceApi();
  const workerToken = randomUUID();

  const { data: claim, error: claimError } = await service.rpc("service_claim_command", {
    p_command_id: commandId,
    p_worker_token: workerToken,
  });
  if (claimError) return { ok: false, reason: "claim_failed" };

  // A completed command is DONE, and the password it produced is stored nowhere by design. Say so
  // plainly rather than quietly issuing a replacement the Director did not ask for and which would
  // invalidate the one already in the target's hands.
  if (!claim?.ok) return { ok: false, reason: reasonOf(claim, "claim_failed") };

  const admin = createAdminClient();
  const temporaryPassword = generateTemporaryPassword();
  const { error: passwordError } = await admin.auth.admin.updateUserById(targetUserId, {
    password: temporaryPassword,
  });

  if (passwordError) {
    await service.rpc("service_fail_command", {
      p_command_id: commandId,
      p_worker_token: workerToken,
      p_error_code: "auth_password_update_failed",
    });
    return { ok: false, reason: "password_update_failed" };
  }

  const { data: completed, error: completeError } = await service.rpc("service_complete_command", {
    p_command_id: commandId,
    p_worker_token: workerToken,
  });

  // The password IS changed by now. If the database will not record that, the Director must be
  // told the two systems disagree rather than handed a credential nothing accounts for.
  if (completeError || !completed?.ok) return { ok: false, reason: "reset_unconfirmed" };

  return { ok: true, temporaryPassword };
}

/**
 * Deactivate or reactivate. `profiles.is_active` is the control; the Auth-side ban is hygiene
 * applied on the safe side of it in both directions.
 */
export async function setAccountActive(
  targetUserId: string,
  isActive: boolean,
  issuedBy?: DirectorApi,
): Promise<AdminResult> {
  const admin = createAdminClient();

  if (isActive) {
    // Lift the Auth ban first: if it fails, the account simply stays inactive.
    const unbanned = await setAuthUserBanned(admin, targetUserId, false);
    if (!unbanned.ok) return { ok: false, reason: "auth_unban_failed" };
  }

  const api = issuedBy ?? (await userApi());
  const { data, error } = await api.rpc("admin_set_account_active", {
    p_target_user_id: targetUserId,
    p_is_active: isActive,
  });
  if (error) return { ok: false, reason: mapDatabaseError(error.message) };
  if (!data?.ok) return { ok: false, reason: reasonOf(data, "change_failed") };

  if (!isActive) {
    // Access is already denied by the committed flag above. This is retryable hygiene, and its
    // failure is reported without pretending the deactivation did not happen.
    const banned = await setAuthUserBanned(admin, targetUserId, true);
    if (!banned.ok) return { ok: true, detail: "session_revocation_pending" };
  }

  return { ok: true, detail: reasonOf(data, "changed") };
}

export async function changeUserRole(
  targetUserId: string,
  role: AppRole,
  issuedBy?: DirectorApi,
): Promise<AdminResult> {
  const api = issuedBy ?? (await userApi());
  const { data, error } = await api.rpc("admin_change_user_role", {
    p_target_user_id: targetUserId,
    p_role: role,
  });
  if (error) return { ok: false, reason: mapDatabaseError(error.message) };
  if (!data?.ok) return { ok: false, reason: reasonOf(data, "change_failed") };
  return { ok: true, detail: reasonOf(data, "changed") };
}

/**
 * Change the login identifier — a durable, claimed, resumable two-system operation.
 *
 * The database is claimed first, because uniqueness is the contended resource, and only ONE live
 * phone change may exist per account, so two of them cannot be applied out of order.
 */
export async function changeUserPhone(
  targetUserId: string,
  phoneE164: string,
  idempotencyKey: string,
  issuedBy?: DirectorApi,
): Promise<AdminResult> {
  const api = issuedBy ?? (await userApi());

  const { data: issued, error } = await api.rpc("admin_request_phone_change", {
    p_target_user_id: targetUserId,
    p_phone_e164: phoneE164,
    p_idempotency_key: idempotencyKey,
  });
  if (error) return { ok: false, reason: mapDatabaseError(error.message) };
  if (!issued?.ok) return { ok: false, reason: reasonOf(issued, "change_failed") };
  if (issued.reason === "unchanged") return { ok: true, detail: "unchanged" };
  if (issued.reason === "already_completed") return { ok: true, detail: "already_completed" };

  return applyPhoneChangeAtAuth(issued.command as PhoneChangeCommand);
}

export type PhoneChangeCommand = {
  id: string;
  target_user_id: string;
  payload: { phone_e164: string; previous_phone_e164: string };
};

/**
 * The one continuation used by a normal change, a retry and a recovery sweep alike — so all three
 * are the same code path rather than three chances to differ.
 */
export async function applyPhoneChangeAtAuth(command: PhoneChangeCommand): Promise<AdminResult> {
  const admin = createAdminClient();
  const service = serviceApi();
  const workerToken = randomUUID();

  const { data: claim, error: claimError } = await service.rpc("service_claim_command", {
    p_command_id: command.id,
    p_worker_token: workerToken,
  });
  if (claimError) return { ok: false, reason: "claim_failed" };
  if (!claim?.ok) return { ok: false, reason: reasonOf(claim, "claim_failed") };

  const { error: authError } = await admin.auth.admin.updateUserById(command.target_user_id, {
    email: derivedAuthIdentifier(command.payload.phone_e164),
    email_confirm: true,
    phone: command.payload.phone_e164,
    phone_confirm: true,
  });

  if (authError) {
    const { data: reverted } = await service.rpc("service_revert_phone_change", {
      p_command_id: command.id,
      p_worker_token: workerToken,
    });
    return {
      ok: false,
      reason: reverted?.ok
        ? "auth_identifier_update_failed"
        : "auth_identifier_update_failed_unreverted",
    };
  }

  const { data: completed, error: completeError } = await service.rpc("service_complete_command", {
    p_command_id: command.id,
    p_worker_token: workerToken,
  });

  // Auth now holds the new identifier. If the database will not confirm the command, the two
  // systems are in a state nobody has verified — reporting success is how that goes unnoticed.
  if (completeError || !completed?.ok) return { ok: false, reason: "phone_change_unconfirmed" };

  return { ok: true, detail: "changed" };
}

/**
 * Finishes phone changes applied in the database but never confirmed at Auth — the state a crash
 * between the two systems leaves behind. Claim-based, so two workers running at once cannot both
 * execute the same command. Returns how many THIS worker completed.
 */
export async function resumePendingPhoneChanges(): Promise<number> {
  const service = serviceApi();
  const { data, error } = await service.rpc("service_pending_phone_changes");
  if (error || !Array.isArray(data) || data.length === 0) return 0;

  let resumed = 0;
  for (const command of data as PhoneChangeCommand[]) {
    const result = await applyPhoneChangeAtAuth(command);
    if (result.ok) resumed++;
  }
  return resumed;
}

/**
 * Audits a refused route attempt (design.md §4.5), through the caller's OWN session.
 *
 * The previous version passed a user id to a service function, which let the secret key manufacture
 * audit history attributed to any Director. There is no user parameter now.
 */
export async function recordAccessDenial(path: string): Promise<void> {
  try {
    const api = await userApi();
    await api.rpc("self_record_access_denial", { p_path: path });
  } catch {
    // An audit write must not turn a refusal into a crash.
  }
}

/**
 * The database raises for authority failures and for the last-Director invariant. Both arrive as
 * PostgREST error messages, and both must reach the Director as something they can act on.
 */
function mapDatabaseError(message: string): string {
  if (/no active Director/i.test(message)) return "last_active_director";
  if (/not a live Director|authenticated session/i.test(message)) return "not_permitted";
  return "generic";
}
