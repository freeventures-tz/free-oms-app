import type { SupabaseClient } from "@supabase/supabase-js";

import { publicEnv, supabaseSecretKey } from "@/lib/env";

/**
 * Thin helpers over the Supabase Auth Admin API for the two things `supabase-js` does not expose.
 * Server-only: every call here carries the secret key.
 */

/**
 * Looks a user up by their derived identifier.
 *
 * This is the ADOPTION path. If a process dies between creating an Auth user and recording its id,
 * the job row says an attempt was made but not which user it produced. Rather than create a second
 * account, the retry finds the first one by the identifier it would have used — the derivation is
 * deterministic, which is what makes recovery possible at all.
 */
export async function findAuthUserByIdentifier(
  identifier: string,
): Promise<{ id: string; email: string } | null> {
  const url = new URL(`${publicEnv.supabaseUrl}/auth/v1/admin/users`);
  url.searchParams.set("filter", identifier);
  url.searchParams.set("per_page", "50");

  const key = supabaseSecretKey();
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`auth_admin_lookup_failed_${response.status}`);
  }

  const body = (await response.json()) as { users?: { id: string; email?: string }[] };
  const match = (body.users ?? []).find(
    (user) => (user.email ?? "").toLowerCase() === identifier.toLowerCase(),
  );

  return match ? { id: match.id, email: match.email ?? identifier } : null;
}

/**
 * Session hygiene after deactivation.
 *
 * Supabase Auth exposes NO administrative "revoke this user's sessions" endpoint — a direct
 * POST to /admin/users/{id}/logout answers 404 on this version, verified rather than assumed. A
 * ban is the mechanism that actually exists: it refuses both new sign-ins and refresh, and it is
 * reversible, idempotent, and safe to retry.
 *
 * This is hygiene, not the control. `profiles.is_active = false` is already committed by the time
 * this runs, and every policy and function refuses that user whether this succeeds or not
 * (architecture.md §7.5).
 */
export async function setAuthUserBanned(
  admin: SupabaseClient,
  userId: string,
  banned: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: banned ? "876000h" : "none",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}
