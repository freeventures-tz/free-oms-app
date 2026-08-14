"use client";

import { Check, ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { signInAction, type SignInState } from "@/app/sign-in/actions";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { Field, FieldError, FormError, Help, Input } from "@/components/ui/field";
import { PasswordField } from "@/components/ui/password-field";
import { normaliseTanzanianPhone, previewNormalisation } from "@/lib/auth/phone-identity";
import { cn } from "@/lib/utils";

/**
 * Sign-in, in two steps: the phone number, then the password (Stage 9 Part A).
 *
 * STEP ONE NEVER ASKS THE SERVER ANYTHING. It advances on the *format* of what was typed and
 * nothing else. If it checked whether the account existed, the two steps would become an oracle for
 * "does this number have an account?" — exactly what the neutral failure at step two exists to
 * prevent. Every real outcome, good or bad, is decided in one server call at step two.
 *
 * The step is client state, so a failed attempt stays on the password step with the number intact
 * rather than throwing the user back to the beginning.
 */
export function SignInForm({ next }: { next?: string }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, {});

  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [onPasswordStep, setOnPasswordStep] = useState(false);

  const normalised = previewNormalisation(phone);
  const phoneAccepted = normaliseTanzanianPhone(phone).ok;

  // The refusal count comes back with the refusal, so a second identical failure still shakes.
  const shake = state.attempt ?? 0;

  // A phone the server refused belongs to step one, whatever the client thought of its format.
  const phoneError = state.fieldErrors?.phone;
  const showPasswordStep = onPasswordStep && phoneError === undefined;

  function toPasswordStep() {
    if (!phoneAccepted || pending) return;
    setOnPasswordStep(true);
  }

  return (
    <form action={formAction} className="mt-8 flex flex-col gap-6" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <FormError>{state.formError ? t(state.formError) : null}</FormError>

      {showPasswordStep ? (
        <div key="password" className="fv-step flex flex-col gap-6">
          {/* The number is carried forward invisibly and shown back in the form it will be used. */}
          <input type="hidden" name="phone" value={phone} />

          <button
            type="button"
            onClick={() => setOnPasswordStep(false)}
            disabled={pending}
            className="fv-identifier mx-auto inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm text-bronze-text transition-colors hover:bg-[color-mix(in_srgb,var(--fv-vanilla)_35%,transparent)]"
          >
            <ChevronLeft aria-hidden className="size-4" />
            {normalised}
            <span className="sr-only">{t("auth.signIn.changeNumber")}</span>
          </button>

          <PasswordField
            id="password"
            name="password"
            label={t("auth.signIn.passwordPrompt")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            autoFocus
            disabled={pending}
            invalid={Boolean(state.formError || state.fieldErrors?.password)}
            shake={shake}
          />

          <FieldError>
            {state.fieldErrors?.password ? t(state.fieldErrors.password) : null}
          </FieldError>

          <AuthSubmit pending={pending} ready={password.length > 0}>
            {t("auth.signIn.submit")}
          </AuthSubmit>
        </div>
      ) : (
        <div key="phone" className="fv-step flex flex-col gap-6">
          <Field className="gap-3">
            <label
              htmlFor="phone"
              className="text-center text-[15px] font-medium text-foreground"
            >
              {t("auth.signIn.phonePrompt")}
            </label>
            <div
              className="relative"
              data-fv-shake={shakeAttribute(shake, phoneError !== undefined)}
            >
              <Input
                id="phone"
                name="phone"
                type="tel"
                // Numeric keypad on mobile; the field is digits and separators only.
                inputMode="tel"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) => {
                  // Enter here means "next", not "submit an empty password".
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  toPasswordStep();
                }}
                aria-invalid={phoneError === undefined ? undefined : true}
                aria-describedby="phone-help"
                disabled={pending}
                // Golden Bronze at rest and when active. A usable number is not a "success" —
                // nothing has been checked yet — so it deepens the brand colour rather than
                // turning green. Green is reserved for a password that meets its conditions.
                data-accepted={phoneAccepted && phoneError === undefined ? "true" : undefined}
                className={cn(
                  "fv-entry-input h-14 rounded-lg border-2 pr-12 pl-4 text-base md:h-13 xl:h-12",
                  phoneError !== undefined ? "border-danger" : "fv-entry-border",
                )}
              />
              {phoneAccepted && phoneError === undefined ? (
                <Check
                  aria-hidden
                  className="fv-tick absolute top-1/2 right-4 size-5 -translate-y-1/2 text-bronze-text"
                />
              ) : null}
            </div>

            {/* Persistent, never hover-only: it shows the form the number will actually be used in. */}
            <Help id="phone-help" className="text-center">
              {normalised
                ? t("auth.signIn.normalisedAs", { phone: normalised })
                : t("auth.signIn.phoneHelp")}
            </Help>
            <FieldError>{phoneError ? t(phoneError) : null}</FieldError>
          </Field>

          <AuthSubmit type="button" onClick={toPasswordStep} ready={phoneAccepted}>
            {t("auth.signIn.continue")}
          </AuthSubmit>
        </div>
      )}

      {/* No recovery note. Recovery is Director-mediated, but somebody who cannot sign in already
          asks their Director — printing that instruction on every visit teaches nobody anything and
          is one more thing to read past. What matters is that no self-service reset EXISTS, and
          that is true whether or not this screen mentions it. */}
    </form>
  );
}

function shakeAttribute(shake: number, active: boolean): "a" | "b" | undefined {
  if (!active || shake === 0) return undefined;
  return shake % 2 === 1 ? "a" : "b";
}
