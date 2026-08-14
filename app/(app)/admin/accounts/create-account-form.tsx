"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef, useState, useTransition } from "react";

import {
  createAccountAction,
  resetPasswordAction,
  type AdminActionState,
} from "@/app/(app)/admin/accounts/actions";
import { TemporaryPasswordPanel } from "@/app/(app)/admin/accounts/temporary-password-panel";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, Help, Input, Label, Select } from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import { previewNormalisation } from "@/lib/auth/phone-identity";
import { APP_ROLES } from "@/lib/auth/roles";

/**
 * The only account-creation path in the system: there is no public signup to compete with it.
 *
 * The idempotency key is generated when the form OPENS, not when it submits, so a double-click or a
 * lost response resumes the same provisioning job instead of starting a second one
 * (architecture.md §5.7). It is generated on the SERVER and passed in: generating it during render
 * would produce a different value on the server and the client, and the resulting hydration
 * mismatch would silently defeat the protection it exists to provide.
 *
 * A REFRESH IS DIFFERENT, and an earlier version of this comment claimed otherwise. Reloading the
 * page renders a new key, so the submission that follows is a new job. What stops a duplicate
 * account is not the key — it is the unique phone number: the second job is refused with
 * `phone_in_use` before any Auth user is created. The key protects the in-flight submission; the
 * phone protects the account.
 */
/**
 * A displayed temporary password is the ONLY copy that exists — it is stored in no table, no job
 * row and no log. So once one is on screen, nothing that lacks one may replace it.
 *
 * Named and exported because it is an invariant rather than a detail: the two guards in front of it
 * (a disabled control and a stable idempotency key) mean a second in-flight reset should never
 * happen, and this is what holds if one ever does. Losing a displayed credential would leave the
 * account on a password nobody knows.
 */
export function keepIssuedCredential(
  previous: AdminActionState,
  next: AdminActionState,
): AdminActionState {
  return previous.temporaryPassword ? previous : next;
}

export function CreateAccountForm({ idempotencyKey }: { idempotencyKey: string }) {
  const t = useTranslations();

  /**
   * The credential this form has already produced, remembered outside React state.
   *
   * A burst of taps raises a burst of submissions, and the obvious guards do not stop the second
   * one. `disabled={pending}` closes the button only after React has COMMITTED the pending state.
   * An `onSubmit` handler is delegated at the root, so React's own submit listener on the form has
   * already run by the time it sees the event. Guarding on the `previous` argument fails too:
   * React hands each queued action the state as it was at DISPATCH, so the duplicate is told the
   * form is still empty.
   *
   * React runs queued form actions ONE AT A TIME — measured, by removing each candidate guard in
   * turn and re-running the delayed-action test. So the duplicate arrives after the first has
   * settled, which is precisely when an in-flight latch has already released. Only a record of
   * what was issued survives that gap, and there is deliberately no in-flight latch beside it: a
   * guard that can never fire is a liability, not defence in depth.
   *
   * What it prevents: the second submission returned `phone_in_use` — correctly, the first had
   * just created the account — and that refusal replaced the temporary password already on screen.
   * The account existed and nobody had its password. Same rule as `keepIssuedCredential`
   * (memory.md §6), on the creation path.
   */
  const issuedCredential = useRef<AdminActionState | null>(null);

  async function createOnce(
    previous: AdminActionState,
    data: FormData,
  ): Promise<AdminActionState> {
    if (issuedCredential.current) return issuedCredential.current;

    const result = await createAccountAction(previous, data);
    if (result.temporaryPassword) issuedCredential.current = result;
    return result;
  }

  const [state, formAction, pending] = useActionState<AdminActionState, FormData>(createOnce, {});
  const [phone, setPhone] = useState("");
  const [recovery, setRecovery] = useState<AdminActionState>({});
  const [isRecovering, startTransition] = useTransition();

  /**
   * ONE idempotency key per recoverable account, minted on first use and reused afterwards.
   *
   * A fresh key on every click made every click a NEW reset command, so two of them issued two
   * different temporary passwords — and the first, already read out to the member of staff, stopped
   * working the moment the second landed. That is the same failure `memory.md` §6 records for
   * repeated resets, arriving through the interface instead of the database.
   *
   * With a stable key the second request resolves to the SAME command, so at most one password can
   * ever be minted for this recovery. Minted in the click handler rather than during render, so
   * there is no server/client hydration mismatch to defeat it.
   */
  const recoveryKeyRef = useRef<{ userId: string; key: string } | null>(null);

  /**
   * A fourth guard, and the only one that does not wait for a render: `disabled` closes the control
   * once React commits `isRecovering`, and this closes it in the same tick as the first click.
   */
  const recoveryInFlight = useRef(false);

  function recoveryKeyFor(userId: string): string {
    if (recoveryKeyRef.current?.userId !== userId) {
      recoveryKeyRef.current = { userId, key: crypto.randomUUID() };
    }
    return recoveryKeyRef.current.key;
  }

  const normalised = previewNormalisation(phone);

  const issued = recovery.temporaryPassword ? recovery : state;

  if (issued.temporaryPassword) {
    return (
      <TemporaryPasswordPanel
        password={issued.temporaryPassword}
        forName={issued.temporaryPasswordFor ?? ""}
        onDone={() => {
          // The password is stored nowhere, so leaving this panel destroys the only copy. The
          // reload also fetches a fresh idempotency key for the next account.
          window.location.reload();
        }}
      />
    );
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t("admin.accounts.create")}</h2>

      {recovery.error ? (
        <div className="mt-4">
          <FormError>{t(recovery.error)}</FormError>
        </div>
      ) : null}

      <form action={formAction} className="mt-4 flex flex-col gap-5" noValidate>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        <FormError>{state.error ? t(state.error) : null}</FormError>

        {/* A lost response means the account exists but no credential was issued. Naming the
            recovery here is the difference between a dead end and a next step. The account is
            identified by name, never by its raw id. */}
        {state.recoverableUserId ? (
          <Button
            type="button"
            variant="secondary"
            // `isRecovering` was missing here while the submit button below already had it. A
            // second click during the request started a second reset.
            pending={isRecovering}
            pendingLabel={t("common.loading")}
            disabled={pending || isRecovering}
            onClick={() => {
              if (recoveryInFlight.current) return;
              recoveryInFlight.current = true;
              const userId = state.recoverableUserId!;
              const data = new FormData();
              data.set("userId", userId);
              data.set("idempotencyKey", recoveryKeyFor(userId));
              startTransition(async () => {
                try {
                  const result = await resetPasswordAction({}, data);
                  setRecovery((previous) => keepIssuedCredential(previous, result));
                } finally {
                  recoveryInFlight.current = false;
                }
              });
            }}
          >
            {t("admin.accounts.recoverExisting")}
          </Button>
        ) : null}

        <Field>
          <Label htmlFor="fullName">{t("admin.accounts.fullName")}</Label>
          <Input id="fullName" name="fullName" required disabled={pending} autoComplete="off" />
          <FieldError>{state.fieldErrors?.fullName ? t(state.fieldErrors.fullName) : null}</FieldError>
        </Field>

        <Field>
          <Label htmlFor="newPhone">{t("admin.accounts.phone")}</Label>
          <Input
            id="newPhone"
            name="phone"
            type="tel"
            inputMode="tel"
            required
            disabled={pending}
            autoComplete="off"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-describedby="newPhone-help"
          />
          <Help id="newPhone-help">
            {normalised
              ? t("auth.signIn.normalisedAs", { phone: normalised })
              : t("auth.signIn.phoneHelp")}
          </Help>
          <FieldError>{state.fieldErrors?.phone ? t(state.fieldErrors.phone) : null}</FieldError>
        </Field>

        <Field>
          <Label htmlFor="role">{t("admin.accounts.role")}</Label>
          {/* Exactly one active role per user, so this is a single select — never multi-select. */}
          <Select id="role" name="role" defaultValue="sales_rep" disabled={pending}>
            {APP_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`admin.roles.${role}`)}
              </option>
            ))}
          </Select>
          <FieldError>{state.fieldErrors?.role ? t(state.fieldErrors.role) : null}</FieldError>
        </Field>

        <Button
          type="submit"
          pending={pending}
          pendingLabel={t("common.loading")}
          disabled={pending || isRecovering}
        >
          {t("admin.accounts.create")}
        </Button>
      </form>
    </Card>
  );
}
