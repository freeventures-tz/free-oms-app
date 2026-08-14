"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";

import {
  changePhoneAction,
  changeRoleAction,
  resetPasswordAction,
  setActiveAction,
  type AdminActionState,
} from "@/app/(app)/admin/accounts/actions";
import { TemporaryPasswordPanel } from "@/app/(app)/admin/accounts/temporary-password-panel";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, Help, Input, Label, Select } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import { formatPhoneForDisplay } from "@/lib/auth/phone-identity";
import { APP_ROLES, type AppRole } from "@/lib/auth/roles";

export type AccountSummary = {
  id: string;
  fullName: string;
  phoneE164: string;
  role: AppRole | null;
  isActive: boolean;
  mustChangePassword: boolean;
};

/**
 * Desktop shows a table with status chips and row actions; mobile shows cards (design.md §3.3,
 * §3.5, §7C.3). Same destinations, same actions, same rules — only the layout changes.
 *
 * There is no delete control anywhere, because accounts are deactivated and never deleted.
 */
export function AccountsList({
  accounts,
  currentUserId,
}: {
  accounts: AccountSummary[];
  currentUserId: string;
}) {
  const t = useTranslations();

  if (accounts.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("admin.accounts.empty")}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} isSelf={account.id === currentUserId} />
      ))}
    </div>
  );
}

type AdminAction = (prev: AdminActionState, data: FormData) => Promise<AdminActionState>;

/** Which control was activated, so the pending state belongs to THAT button and not to the row. */
type ActionName = "reset" | "active" | "role" | "phone";

function AccountRow({ account, isSelf }: { account: AccountSummary; isSelf: boolean }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<ActionName | null>(null);
  const [attempt, setAttempt] = useState<{
    name: ActionName;
    action: AdminAction;
    data: FormData;
  } | null>(null);
  const [result, setResult] = useState<AdminActionState>({});
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<AppRole>(account.role ?? "sales_rep");

  /**
   * The guard that does not wait for a render.
   *
   * `disabled` closes the control, but only once React has committed the pending state. A ref is
   * written synchronously inside the handler, so two activations dispatched in the same tick — a
   * fast double-tap, a stuck key, an assistive tool firing twice — cannot both get through.
   */
  const inFlight = useRef(false);

  /**
   * One key per INTERACTION, held in state — not one per click.
   *
   * Minting a fresh uuid inside the handler meant a double-click sent two different keys and
   * therefore asked for two different commands. The key is stable until the interaction is
   * deliberately started again, and every action is disabled while one is in flight.
   */
  const [resetKey, setResetKey] = useState(() => crypto.randomUUID());
  const [phoneKey, setPhoneKey] = useState(() => crypto.randomUUID());

  function run(name: ActionName, action: AdminAction, data: FormData) {
    if (inFlight.current) return;
    inFlight.current = true;

    setRunning(name);
    setResult({});
    // Held so a refusal can be retried with the SAME FormData — and therefore the same idempotency
    // key, addressing the same command rather than starting a second one.
    setAttempt({ name, action, data });

    startTransition(async () => {
      try {
        const outcome = await action({}, data);
        setResult(outcome);
        // A finished interaction gets fresh keys, so the NEXT deliberate action is a new command
        // rather than a replay of the one just settled.
        if (outcome.temporaryPassword || outcome.successKey) {
          setResetKey(crypto.randomUUID());
          setPhoneKey(crypto.randomUUID());
          setAttempt(null);
        }
      } catch {
        /**
         * The action did not RETURN a refusal — it never got there. A dropped connection, a
         * server that went away mid-request, a Server Action that threw.
         *
         * `finally` alone released the guard but left the screen showing nothing at all: the
         * spinner stopped, the control came back, and the Director was told neither that it had
         * failed nor that it could be tried again. Silence after a tap is the same failure this
         * whole change exists to remove, arriving by a different route.
         *
         * `attempt` is deliberately NOT cleared, so the retry below reuses this exact FormData —
         * and therefore this exact idempotency key. If the request did reach the server before
         * the connection dropped, retrying addresses the SAME command rather than starting a
         * second one. Everything typed into the row is React state and is untouched.
         */
        setResult({ error: "admin.errors.generic" });
      } finally {
        inFlight.current = false;
        setRunning(null);
      }
    });
  }

  if (result.temporaryPassword) {
    return (
      <TemporaryPasswordPanel
        password={result.temporaryPassword}
        forName={account.fullName}
        onDone={() => window.location.reload()}
      />
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{account.fullName}</p>
          <p className="fv-identifier text-sm text-muted-foreground">
            {formatPhoneForDisplay(account.phoneE164)}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <StatusChip tone="neutral">
              {account.role ? t(`admin.roles.${account.role}`) : "—"}
            </StatusChip>
            <StatusChip tone={account.isActive ? "success" : "danger"}>
              {account.isActive ? t("admin.accounts.active") : t("admin.accounts.inactive")}
            </StatusChip>
            {account.mustChangePassword ? (
              <StatusChip tone="attention">{t("admin.accounts.gated")}</StatusChip>
            ) : null}
          </div>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="small"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t("admin.accounts.actions")}
        </Button>
      </div>

      {/* A refusal is inline on the affected record and always paired with a retry, because the
          remedy for "operation failed" is to try it again — and the retry reuses the original
          request, so it can only ever resolve to the one command (design.md §12.5). */}
      {result.error ? (
        <div className="mt-4 flex flex-col gap-3">
          <FormError>{t(result.error)}</FormError>
          {attempt ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                pending={running === attempt.name}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => run(attempt.name, attempt.action, attempt.data)}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {result.successKey && !result.temporaryPassword ? (
        <p className="mt-4 text-sm text-success">{t(result.successKey, { name: account.fullName })}</p>
      ) : null}

      {open ? (
        <div className="mt-5 flex flex-col gap-6 border-t border-border pt-5">
          <div className="flex flex-col gap-3 md:flex-row">
            <Button
              type="button"
              variant="secondary"
              pending={running === "reset"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => {
                const data = new FormData();
                data.set("userId", account.id);
                // No `fullName`: the server reads the name from the database, so the client
                // cannot decide whose name appears beside a live credential.
                data.set("idempotencyKey", resetKey);
                run("reset", resetPasswordAction, data);
              }}
            >
              {t("admin.accounts.resetPassword")}
            </Button>

            {/* Deactivation names its consequence before it happens (design.md §10.8). */}
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant={account.isActive ? "danger" : "secondary"}
                pending={running === "active"}
                pendingLabel={t("common.loading")}
                disabled={pending || (isSelf && account.isActive)}
                onClick={() => {
                  const data = new FormData();
                  data.set("userId", account.id);
                  data.set("isActive", account.isActive ? "false" : "true");
                  run("active", setActiveAction, data);
                }}
              >
                {account.isActive
                  ? t("admin.accounts.deactivate")
                  : t("admin.accounts.reactivate")}
              </Button>
              {account.isActive ? (
                <Help>
                  {isSelf
                    ? t("admin.errors.cannot_deactivate_self")
                    : t("admin.accounts.deactivateWarning")}
                </Help>
              ) : null}
            </div>
          </div>

          <Field>
            <Label htmlFor={`role-${account.id}`}>{t("admin.accounts.changeRole")}</Label>
            <div className="flex flex-col gap-3 md:flex-row">
              <Select
                id={`role-${account.id}`}
                value={role}
                disabled={pending}
                onChange={(event) => setRole(event.target.value as AppRole)}
              >
                {APP_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {t(`admin.roles.${value}`)}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                pending={running === "role"}
                pendingLabel={t("common.loading")}
                disabled={pending || role === account.role}
                onClick={() => {
                  const data = new FormData();
                  data.set("userId", account.id);
                  data.set("role", role);
                  run("role", changeRoleAction, data);
                }}
              >
                {t("admin.accounts.changeRole")}
              </Button>
            </div>
          </Field>

          <Field>
            <Label htmlFor={`phone-${account.id}`}>{t("admin.accounts.changePhone")}</Label>
            <div className="flex flex-col gap-3 md:flex-row">
              <Input
                id={`phone-${account.id}`}
                type="tel"
                inputMode="tel"
                value={phone}
                disabled={pending}
                placeholder={formatPhoneForDisplay(account.phoneE164)}
                onChange={(event) => setPhone(event.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                pending={running === "phone"}
                pendingLabel={t("common.loading")}
                disabled={pending || phone.trim().length === 0}
                onClick={() => {
                  const data = new FormData();
                  data.set("userId", account.id);
                  data.set("phone", phone);
                  data.set("idempotencyKey", phoneKey);
                  run("phone", changePhoneAction, data);
                }}
              >
                {t("admin.accounts.changePhone")}
              </Button>
            </div>
            <Help>{t("admin.accounts.changePhoneWarning")}</Help>
            <FieldError>{result.fieldErrors?.phone ? t(result.fieldErrors.phone) : null}</FieldError>
          </Field>
        </div>
      ) : null}
    </Card>
  );
}
