import { randomUUID } from "node:crypto";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { getViewer } from "@/lib/auth/viewer";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { serviceApi } from "@/lib/supabase/api";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The forced first-login password change — one server-orchestrated, fully resumable operation.
 *
 * WHAT WENT WRONG TWICE, AND WHAT FIXED IT
 *
 *   First attempt: change the password, then clear the gate. When the second step failed the retry
 *   called Auth again with the same password and Supabase answered `422 same_password` — the user
 *   was locked out by the password they had just chosen.
 *
 *   Second attempt: record the observed success in the database between those two steps. That
 *   covered a failed gate clear, but not a crash between Auth's response and the record — nothing
 *   was written, so the retry hit `same_password` again and the user had to pick a different one.
 *
 *   This version puts the evidence WHERE THE PASSWORD CHANGE HAPPENS. `updateUserById` writes the
 *   password and a marker into the Auth user's `app_metadata` in ONE request, so there is no window
 *   between them: either both landed or neither did. `app_metadata` is writable only with the
 *   secret key — never by the user, unlike `user_metadata` — so it is trustworthy evidence.
 *
 * REJECTING THE UNCHANGED TEMPORARY PASSWORD
 *   The Admin API does not enforce Supabase's "must differ from the current password" rule, so that
 *   protection has to be recovered deliberately. Before changing anything, the server PROBES: it
 *   attempts a sign-in with the submitted password. If that succeeds, the submitted password is
 *   already the current one — the temporary password — and the request is refused. The probe runs
 *   only when no marker exists, so a retry after a crash never reaches it.
 *
 * WHAT THIS DOES NOT DO — stated plainly
 *   The database cannot verify any of it. `auth.users` is unreachable from migrations
 *   (architecture.md §7.9), so no database function can confirm that Auth changed a password; it
 *   can only require that a live operation exists, belongs to this user, and is in the right stage,
 *   and record the marker for audit. A holder of the secret key can therefore clear a gate — but a
 *   holder of the secret key can also set that user's password outright, so the gate was never a
 *   control against them. It is a control against CLIENTS, and against them it is absolute.
 */

const MARKER_KEY = "fv_first_login";

type Marker = { operation_id: string; token: string; changed_at: string };

export type FirstLoginState =
  | { state: "not_gated" }
  | { state: "needs_password" }
  /** Auth already holds a new password; only the gate is left to clear. */
  | { state: "needs_completion" };

type Operation = { id: string; stage: "pending" | "auth_changed" | "complete" | "superseded" };

export async function readFirstLoginState(): Promise<FirstLoginState> {
  const viewer = await getViewer();
  if (viewer.state !== "gated") return { state: "not_gated" };

  // Read through the user's own session under RLS: they may see only their own operation.
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("first_login_operations")
    .select("id, stage")
    .eq("user_id", viewer.userId)
    .in("stage", ["pending", "auth_changed"])
    .maybeSingle();

  if (data?.stage === "auth_changed") return { state: "needs_completion" };

  // A crash between Auth and the database leaves the evidence in Auth alone, so the screen would
  // otherwise ask for a password Supabase will refuse as unchanged.
  if (data?.id && (await markerFor(viewer.userId, data.id))) {
    return { state: "needs_completion" };
  }

  return { state: "needs_password" };
}

async function markerFor(userId: string, operationId: string): Promise<Marker | null> {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error || !data.user) return null;

  const marker = (data.user.app_metadata as Record<string, unknown> | null)?.[MARKER_KEY] as
    | Marker
    | undefined;

  return marker?.operation_id === operationId ? marker : null;
}

/**
 * Is the submitted password already this account's current password?
 *
 * Answered by asking Supabase Auth, which is the only thing that knows. It costs one sign-in
 * attempt and issues a session we discard; that is the price of keeping the "your new password must
 * differ from your temporary one" rule while performing the change with the Admin API.
 */
async function passwordIsCurrent(phoneE164: string, password: string): Promise<boolean> {
  const response = await fetch(
    `${publicEnv.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: publicEnv.supabasePublishableKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: derivedAuthIdentifier(phoneE164), password }),
      cache: "no-store",
    },
  );
  return response.ok;
}

export async function completeFirstLogin(
  newPassword: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const viewer = await getViewer();

  if (viewer.state === "anonymous") return { ok: false, reason: "not_signed_in" };
  if (viewer.state === "blocked") return { ok: false, reason: "no_access" };
  if (viewer.state === "active") return { ok: true }; // Already completed; nothing to do.

  const api = serviceApi();

  const { data: begun, error: beginError } = await api.rpc("service_begin_first_login", {
    p_user_id: viewer.userId,
  });
  if (beginError) return { ok: false, reason: "begin_failed" };
  if (!begun?.ok) return { ok: false, reason: String(begun?.reason ?? "begin_failed") };
  if (begun.reason === "not_gated") return { ok: true };

  const operation = begun.operation as Operation;

  if (operation.stage !== "auth_changed") {
    // Evidence in Auth outranks anything this request was told. If a previous attempt got the
    // password changed, THIS attempt must not ask Auth to change it again.
    const existing = await markerFor(viewer.userId, operation.id);

    if (existing) {
      const recorded = await recordEvidence(api, operation.id, viewer.userId, existing.token);
      if (!recorded) return { ok: false, reason: "password_change_not_recorded" };
    } else {
      if (!newPassword) return { ok: false, reason: "password_required" };

      // The gate exists to replace the temporary password. Accepting it as the "new" one would
      // leave exactly the credential we are trying to retire.
      if (await passwordIsCurrent(viewer.phoneE164, newPassword)) {
        return { ok: false, reason: "same_password" };
      }

      const token = randomUUID();
      const marker: Marker = {
        operation_id: operation.id,
        token,
        changed_at: new Date().toISOString(),
      };

      // ONE request: the password and the proof that it changed land together or not at all.
      const { error } = await createAdminClient().auth.admin.updateUserById(viewer.userId, {
        password: newPassword,
        app_metadata: { [MARKER_KEY]: marker },
      });
      if (error) return { ok: false, reason: error.code ?? "password_change_failed" };

      const recorded = await recordEvidence(api, operation.id, viewer.userId, token);
      if (!recorded) {
        // Harmless: the marker is in Auth, so the retry finds it and completes without asking for
        // a password at all.
        return { ok: false, reason: "password_change_not_recorded" };
      }
    }
  }

  const { data, error: rpcError } = await api.rpc("service_complete_first_login", {
    p_user_id: viewer.userId,
    p_operation_id: operation.id,
  });

  if (rpcError) return { ok: false, reason: "gate_completion_failed" };
  if (!data?.ok) return { ok: false, reason: String(data?.reason ?? "gate_completion_failed") };

  // Best effort, and deliberately last: the marker has done its job, and leaving it would be
  // harmless anyway because a later reset creates a different operation id.
  await clearMarker(viewer.userId);

  return { ok: true };
}

async function recordEvidence(
  api: ReturnType<typeof serviceApi>,
  operationId: string,
  userId: string,
  token: string,
): Promise<boolean> {
  const { data, error } = await api.rpc("service_record_first_login_password_changed", {
    p_operation_id: operationId,
    p_user_id: userId,
    p_auth_evidence: token,
  });
  return !error && data?.ok === true;
}

async function clearMarker(userId: string): Promise<void> {
  try {
    await createAdminClient().auth.admin.updateUserById(userId, {
      app_metadata: { [MARKER_KEY]: null },
    });
  } catch {
    // A stale marker names a spent operation and can satisfy nothing.
  }
}
