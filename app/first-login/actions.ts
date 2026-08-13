"use server";

import { redirect } from "next/navigation";

import { completeFirstLogin } from "@/lib/auth/first-login";
import { changePasswordSchema, fieldErrors } from "@/lib/validation/auth";

export type FirstLoginState = {
  formError?: string;
  fieldErrors?: Record<string, string>;
  /** See `SignInState.attempt` — it replays the rejection animation on a repeated failure. */
  attempt?: number;
};

/**
 * One server-orchestrated operation: resolve the user, change THEIR password at Auth, record that
 * it happened, and only then clear the gate. Nothing about identity comes from this form.
 */
export async function firstLoginAction(
  previous: FirstLoginState,
  formData: FormData,
): Promise<FirstLoginState> {
  const attempt = (previous.attempt ?? 0) + 1;

  const parsed = changePasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { fieldErrors: fieldErrors(parsed.error), attempt };
  }

  return finish(await completeFirstLogin(parsed.data.password), attempt);
}

/**
 * The recovery path. A previous attempt already changed the password at Auth and recorded it; all
 * that remains is to clear the gate, which needs no password — least of all a different one.
 */
export async function finishFirstLoginAction(
  previous: FirstLoginState,
): Promise<FirstLoginState> {
  return finish(await completeFirstLogin(null), (previous.attempt ?? 0) + 1);
}

function finish(
  result: { ok: true } | { ok: false; reason: string },
  attempt: number,
): FirstLoginState {
  if (result.ok) redirect("/");

  if (result.reason === "not_signed_in") redirect("/sign-in");
  if (result.reason === "no_access") redirect("/no-access");

  // Supabase refuses a password identical to the current one. With no recorded change for this
  // gate, the current password is still the temporary one — so this is a real refusal, not a
  // recovery case, and saying so is more useful than a generic failure.
  if (result.reason === "same_password") {
    return { fieldErrors: { password: "auth.errors.password.sameAsCurrent" }, attempt };
  }

  if (result.reason === "password_change_not_recorded") {
    return { formError: "auth.firstLogin.notRecorded", attempt };
  }

  // Everything else leaves the user gated and able to retry safely.
  return { formError: "auth.firstLogin.failed", attempt };
}
