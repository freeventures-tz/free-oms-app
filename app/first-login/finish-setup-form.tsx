"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { finishFirstLoginAction, type FirstLoginState } from "@/app/first-login/actions";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { FormError } from "@/components/ui/field";

/**
 * Shown when Supabase Auth has already accepted a new password but the gate was never cleared —
 * the state a crash or a dropped connection leaves behind.
 *
 * There is deliberately no password field. Asking again would be asking for a password the user has
 * already chosen, and Supabase would refuse it as unchanged. Nothing here clears the gate on its
 * own: the server completes the recorded operation, and the database still requires that record.
 */
export function FinishSetupForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FirstLoginState, FormData>(
    (previous) => finishFirstLoginAction(previous),
    {},
  );

  return (
    <form action={formAction} className="mt-8 flex flex-col gap-6">
      <FormError>{state.formError ? t(state.formError) : null}</FormError>

      <p className="rounded-lg bg-[color-mix(in_srgb,var(--fv-periwinkle)_25%,transparent)] p-4 text-sm">
        {t("auth.firstLogin.alreadyChanged")}
      </p>

      <AuthSubmit pending={pending} ready>
        {t("auth.firstLogin.finish")}
      </AuthSubmit>
    </form>
  );
}
