import { cache } from "react";

import type { AppRole, Locale } from "@/lib/auth/roles";
import { createServerSupabase } from "@/lib/supabase/server";

// Re-exported as TYPES only. `AppRole` as a value would drag this server-only module — and with it
// `next/headers` — into any Client Component that needed the union.
export type { AppRole, Locale };

export type BlockedReason = "no_profile" | "inactive" | "no_role";

export type Viewer =
  | { state: "anonymous" }
  | { state: "gated"; userId: string; fullName: string; phoneE164: string; locale: Locale }
  | { state: "blocked"; userId: string; reason: BlockedReason }
  | {
      state: "active";
      userId: string;
      fullName: string;
      phoneE164: string;
      locale: Locale;
      role: AppRole;
    };

/**
 * Resolves who is asking, from LIVE database state.
 *
 * The JWT supplies identity only. Activation, the first-login gate and the role are read from the
 * database on every request, so a deactivated account or a removed role is denied on the SAME
 * session, with no token refresh and no revocation step (architecture.md §7.4, §7.9). The `user_role`
 * claim the Auth hook adds is deliberately not consulted here.
 *
 * This is the interface's view of authority. It is NOT the boundary — GRANTs, RLS and the `api`
 * functions are (architecture.md §5.4). Both must agree, and the database wins.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  const supabase = await createServerSupabase();

  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId || typeof userId !== "string") return { state: "anonymous" };

  // Issued TOGETHER, because neither depends on the other: both are keyed by the `userId` the
  // verified token already supplied. Awaiting them one after the other cost a second full round
  // trip to the database on every request in the application — see the Stage 10 Part A measurement.
  //
  // The order of the CHECKS below is unchanged, and so is every state this returns. The one
  // difference is that a gated or deactivated user now also has their role row read, which the
  // sequential version would have skipped. It is the caller's own row under the caller's own
  // session, RLS applies to it exactly as before, and nothing reads the result on those paths.
  const [{ data: profile }, { data: roleRow }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, phone_e164, locale, is_active, must_change_password")
      .eq("id", userId)
      .maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  if (!profile) return { state: "blocked", userId, reason: "no_profile" };

  // Ordering follows §7.5: deactivation denies outright; the gate is a lesser state that still
  // permits the setup screen; rolelessness is checked last because it is not reachable while gated.
  if (!profile.is_active) return { state: "blocked", userId, reason: "inactive" };

  const locale: Locale = profile.locale === "sw" ? "sw" : "en";

  if (profile.must_change_password) {
    return {
      state: "gated",
      userId,
      fullName: profile.full_name,
      // Needed by first-login completion, which asks Auth whether the submitted password is
      // already the current one before changing anything.
      phoneE164: profile.phone_e164,
      locale,
    };
  }

  const role = roleRow?.role as AppRole | undefined;
  if (!role) return { state: "blocked", userId, reason: "no_role" };

  return {
    state: "active",
    userId,
    fullName: profile.full_name,
    phoneE164: profile.phone_e164,
    locale,
    role,
  };
});
