"use client";

import { Check, Circle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { firstLoginAction, type FirstLoginState } from "@/app/first-login/actions";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { FieldError, FormError } from "@/components/ui/field";
import { PasswordField } from "@/components/ui/password-field";
import { PASSWORD_POLICY, passwordMeetsPolicy } from "@/lib/auth/password-policy";
import { cn } from "@/lib/utils";

/**
 * The forced password change (design.md §7C.2).
 *
 * The requirements are stated BEFORE the user types and each one ticks as it is satisfied, so the
 * rules are never discovered through rejection. The bar and the ticks say the same thing two ways —
 * colour alone never carries it (design.md §11.5).
 */
export function FirstLoginForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FirstLoginState, FormData>(
    firstLoginAction,
    {},
  );

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  // The refusal count comes back with the refusal, so a second identical failure still shakes.
  const shake = state.attempt ?? 0;

  const meetsPolicy = passwordMeetsPolicy(password);
  const matches = confirmation.length > 0 && confirmation === password;

  const rules = [
    { key: "policyLength", met: password.length >= PASSWORD_POLICY.minLength },
    { key: "policyUpper", met: /[A-Z]/.test(password) },
    { key: "policyLower", met: /[a-z]/.test(password) },
    { key: "policyDigit", met: /\d/.test(password) },
  ];

  return (
    <form action={formAction} className="mt-8 flex flex-col gap-6" noValidate>
      <FormError>{state.formError ? t(state.formError) : null}</FormError>

      <div className="rounded-lg bg-[color-mix(in_srgb,var(--fv-vanilla)_35%,transparent)] p-4">
        <p className="text-[13px] font-medium">{t("auth.firstLogin.policyTitle")}</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {rules.map((rule) => (
            <li key={rule.key} className="flex items-center gap-2 text-xs">
              {rule.met ? (
                <Check aria-hidden className="fv-tick size-4 shrink-0 text-success" />
              ) : (
                <Circle aria-hidden className="size-4 shrink-0 text-foreground/30" />
              )}
              <span className={cn(rule.met ? "text-success" : "text-foreground/80")}>
                {t(`auth.firstLogin.${rule.key}`)}
              </span>
              <span className="sr-only">
                {rule.met ? t("auth.password.ruleMet") : t("auth.password.ruleUnmet")}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <PasswordField
        id="password"
        name="password"
        label={t("auth.firstLogin.newPassword")}
        value={password}
        onChange={setPassword}
        satisfied={meetsPolicy}
        autoComplete="new-password"
        autoFocus
        disabled={pending}
        invalid={Boolean(state.fieldErrors?.password)}
        shake={shake}
      />
      <FieldError>{state.fieldErrors?.password ? t(state.fieldErrors.password) : null}</FieldError>

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label={t("auth.firstLogin.confirmPassword")}
        value={confirmation}
        onChange={setConfirmation}
        satisfied={matches}
        autoComplete="new-password"
        disabled={pending}
        invalid={Boolean(state.fieldErrors?.confirmPassword)}
        shake={shake}
      />
      <FieldError>
        {state.fieldErrors?.confirmPassword ? t(state.fieldErrors.confirmPassword) : null}
      </FieldError>

      <AuthSubmit pending={pending} ready={meetsPolicy && matches}>
        {t("auth.firstLogin.submit")}
      </AuthSubmit>
    </form>
  );
}
