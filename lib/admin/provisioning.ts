import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import type { AppRole } from "@/lib/auth/roles";
import { adminApi, createAdminClient } from "@/lib/supabase/admin";
import { serviceApi, userApi } from "@/lib/supabase/api";
import { findAuthUserByIdentifier, setAuthUserBanned } from "@/lib/admin/auth-admin";

/**
 * Cross-system account provisioning.
 *
 * Supabase Auth and this database are two systems and no transaction spans them, so this is a
 * CLAIMED, RESUMABLE JOB rather than an atomic operation (architecture.md §7.6, §7.8). The job is
 * CLAIMED under the Director's own session — `api.admin_request_account_provisioning` derives the
 * actor and takes none — and every later step is addressed by job id through `api.service_*`.
 *
 * The temporary password exists only in this function's return value. It is never written to the
 * job row, the database, or a log.
 */

export type ProvisionInput = {
  fullName: string;
  phoneE164: string;
  role: AppRole;
  idempotencyKey: string;
};

export type ProvisionResult =
  | { ok: true; userId: string; temporaryPassword: string; resumed: boolean; jobId: string }
  /**
   * The account already exists and this call issued no credential — either because the same key was
   * replayed, or because a refresh submitted a new key for a phone that is already taken.
   *
   * Reported as a REFUSAL rather than as success, because a Director who retried a lost response
   * would otherwise be told "done" while holding no password to hand over. `userId` lets the
   * interface offer the one action that recovers it: issue a new temporary password.
   */
  | { ok: false; reason: "already_provisioned" | "phone_in_use"; userId: string }
  | { ok: false; reason: string; orphanAuthUserId?: string };

type JobRow = {
  id: string;
  stage: "pending" | "auth_created" | "profile_created" | "complete" | "failed";
  auth_user_id: string | null;
  profile_id: string | null;
};

type ApiCaller = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** An error CODE, never provider output — `error_detail` is constrained to exactly this shape. */
function asErrorCode(value: string): string {
  const code = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 120);
  return code.length > 0 ? code : "unknown_error";
}

/** Issued by a Director from the interface. Authority comes from their session, not a parameter. */
export async function provisionAccountAsDirector(input: ProvisionInput): Promise<ProvisionResult> {
  const api = (await userApi()) as unknown as ApiCaller;
  return provisionAccountWithApi(api, input);
}

/**
 * The one-time bootstrap of the first Director, run from the CLI runbook. It has no session because
 * there is no Director yet, and it is refused the moment one exists.
 */
export async function provisionBootstrapDirector(
  input: Omit<ProvisionInput, "role">,
): Promise<ProvisionResult> {
  const api = serviceApi() as unknown as ApiCaller;
  return provisionAccountWithApi(api, { ...input, role: "director" }, true);
}

export async function provisionAccountWithApi(
  api: ApiCaller,
  input: ProvisionInput,
  isBootstrap = false,
): Promise<ProvisionResult> {
  const admin = createAdminClient();
  const service = adminApi(admin);
  const identifier = derivedAuthIdentifier(input.phoneE164);

  // 1. Claim the durable job. A repeat of the same key resumes; it never makes a second job.
  const { data: claim, error: claimError } = await (isBootstrap
    ? api.rpc("service_claim_bootstrap_job", {
        p_idempotency_key: input.idempotencyKey,
        p_full_name: input.fullName,
        p_phone_e164: input.phoneE164,
      })
    : api.rpc("admin_request_account_provisioning", {
        p_idempotency_key: input.idempotencyKey,
        p_full_name: input.fullName,
        p_phone_e164: input.phoneE164,
        p_role: input.role,
      }));

  if (claimError) return { ok: false, reason: asErrorCode(claimError.message) };

  const claimed = claim as
    | { ok?: boolean; reason?: string; job?: JobRow; existing_user_id?: string }
    | null;

  if (!claimed?.ok) {
    // A duplicate phone names the account it collided with, so the interface can offer recovery
    // instead of a dead end.
    if (claimed?.reason === "phone_in_use" && claimed.existing_user_id) {
      return { ok: false, reason: "phone_in_use", userId: claimed.existing_user_id };
    }
    return { ok: false, reason: String(claimed?.reason ?? "claim_failed") };
  }

  const job = claimed.job as JobRow;
  const resumed = claimed.reason === "resumed";

  if (job.stage === "complete" && job.auth_user_id) {
    return { ok: false, reason: "already_provisioned", userId: job.auth_user_id };
  }

  let authUserId = job.auth_user_id;
  let temporaryPassword: string | null = null;
  let createdHere = false;

  // 2. Create the Auth user, under mutual exclusion so two runs cannot both create one.
  if (!authUserId) {
    const { data: attemptData, error: attemptError } = await service.rpc(
      "service_begin_auth_attempt",
      { p_job_id: job.id },
    );
    if (attemptError) return { ok: false, reason: asErrorCode(attemptError.message) };
    const attempt = attemptData as { ok?: boolean; reason?: string; job?: JobRow } | null;

    if (attempt?.ok) {
      temporaryPassword = generateTemporaryPassword();
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: identifier,
        password: temporaryPassword,
        email_confirm: true,
        // Carried on the Auth user too, which gives a second uniqueness guarantee alongside
        // profiles.phone_e164, and is treated as confirmed without SMS (§7.6).
        phone: input.phoneE164,
        phone_confirm: true,
      });

      if (createError || !created?.user) {
        await service.rpc("service_fail_provisioning", {
          p_job_id: job.id,
          p_error_code: asErrorCode(createError?.message ?? "auth_create_failed"),
        });
        return { ok: false, reason: "auth_create_failed" };
      }

      authUserId = created.user.id;
      createdHere = true;
    } else if (attempt?.reason === "auth_user_already_exists") {
      authUserId = attempt.job?.auth_user_id ?? null;
    } else if (attempt?.reason === "attempt_in_progress") {
      // A previous run may have created an Auth user and died before recording it. Adopt it by the
      // identifier it must have used, rather than creating a second privileged account.
      const existing = await findAuthUserByIdentifier(identifier);
      if (!existing) return { ok: false, reason: "attempt_in_progress" };
      authUserId = existing.id;
    } else {
      return { ok: false, reason: String(attempt?.reason ?? "begin_attempt_failed") };
    }
  }

  if (!authUserId) return { ok: false, reason: "no_auth_user" };

  // 3. Record it. Any conflict here means this run produced an orphan, which is disabled, not left.
  const { data: recordedData, error: recordError } = await service.rpc("service_record_auth_user", {
    p_job_id: job.id,
    p_auth_user_id: authUserId,
  });
  if (recordError) return { ok: false, reason: asErrorCode(recordError.message) };
  const recorded = recordedData as
    | { ok?: boolean; reason?: string; orphan_auth_user_id?: string }
    | null;

  if (!recorded?.ok) {
    const orphan = recorded?.orphan_auth_user_id;
    if (createdHere && orphan) await setAuthUserBanned(admin, orphan, true);
    await service.rpc("service_fail_provisioning", {
      p_job_id: job.id,
      p_error_code: asErrorCode(String(recorded?.reason ?? "record_failed")),
    });
    return {
      ok: false,
      reason: String(recorded?.reason ?? "record_failed"),
      orphanAuthUserId: orphan,
    };
  }

  // 4. An adopted or resumed account has an unknown password, so it is given a fresh one — the
  //    Director must leave with a credential they can actually hand over.
  if (!temporaryPassword) {
    temporaryPassword = generateTemporaryPassword();
    const { error: passwordError } = await admin.auth.admin.updateUserById(authUserId, {
      password: temporaryPassword,
    });
    if (passwordError) {
      await service.rpc("service_fail_provisioning", {
        p_job_id: job.id,
        p_error_code: asErrorCode(passwordError.message),
      });
      return { ok: false, reason: "temporary_password_failed" };
    }
  }

  // 5. Profile, role, then activation — in that order, so any failure leaves zero access.
  const { data: completedData, error: completeError } = await service.rpc(
    "service_complete_provisioning",
    { p_job_id: job.id },
  );
  if (completeError) return { ok: false, reason: asErrorCode(completeError.message) };
  const completed = completedData as { ok?: boolean; reason?: string } | null;

  if (!completed?.ok) {
    await service.rpc("service_fail_provisioning", {
      p_job_id: job.id,
      p_error_code: asErrorCode(String(completed?.reason ?? "complete_failed")),
    });
    return { ok: false, reason: String(completed?.reason ?? "complete_failed") };
  }

  return { ok: true, userId: authUserId, temporaryPassword, resumed, jobId: job.id };
}

/** Whether the system has been bootstrapped, used by the runbook and the bootstrap guard. */
export async function directorExists(): Promise<boolean> {
  const { data, error } = await serviceApi().rpc("service_director_exists");
  if (error) throw new Error(asErrorCode(error.message));
  return data === true;
}
