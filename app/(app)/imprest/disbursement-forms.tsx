"use client";

import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";

import {
  approveDisbursementAction,
  cancelDisbursementAction,
  proposeDisbursementAction,
  rejectDisbursementAction,
  withdrawDisbursementAction,
} from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Field, FieldError, Help, Input, Label } from "@/components/ui/field";
import type { AppRole } from "@/lib/auth/roles";
import { IMPREST_CATEGORIES, PURPOSE_MAX, type ImprestCategory } from "@/lib/imprest/spending";
import { formatTzs, parseTzs } from "@/lib/money";

const SPENDING_UNCONFIRMED_KEY = "spendingErrors.unconfirmed";

/**
 * Imprest disbursement controls (issue #55), on the same feedback contract as the funding forms
 * (design.md §12.7): acknowledged at once, one activation at a time, a retry resends the same key,
 * nothing typed is cleared on a refusal, and success only after the server confirms it.
 */

/**
 * The Cashier's proposal: category chips, amount and a short purpose (design.md §7B.5; the payee
 * arrives in part 2). Free to approve is shown against the amount as it is typed. That is advice,
 * not a rule: the proposal is still accepted, and only the Manager's approval is held to it.
 */
export function ProposeDisbursementForm({
  freeToApprove,
  recentPurposes,
}: {
  freeToApprove: number;
  recentPurposes: string[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ImprestCategory | "">("");
  const [purpose, setPurpose] = useState("");
  const [key, controller] = useFreshKey(() => {
    setAmount("");
    setCategory("");
    setPurpose("");
  }, SPENDING_UNCONFIRMED_KEY);
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  // Submit shows it is working in the first frame; the fields lock one render later. Locking them in
  // the same commit wrote ~17 attributes before that frame and cost a slow phone its 100 ms. A
  // second submit is refused by the controller's own guard either way, and the request is already
  // captured, so nothing can change what is sent in between.
  const locked = useDeferredValue(controller.pending);
  const typed = parseTzs(amount);
  const shortfall = typed !== null && typed > freeToApprove ? typed - freeToApprove : 0;

  const error = (name: string) =>
    problems?.[name] ? (
      <span id={`propose-${name}-error`}>
        <FieldError>{t(problems[name])}</FieldError>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-4"
        noValidate
        data-testid="propose-disbursement-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          data.set("amount", amount);
          data.set("category", category);
          data.set("purpose", purpose);
          data.set("idempotencyKey", key);
          controller.run("propose", proposeDisbursementAction, data);
        }}
      >
        <Help>{t("imprest.spending.propose.help")}</Help>

        <fieldset
          className="flex flex-col gap-2"
          aria-invalid={problems?.category ? true : undefined}
          aria-describedby={problems?.category ? "propose-category-error" : undefined}
        >
          <legend className="mb-2 text-sm font-medium">{t("imprest.spending.propose.category")}</legend>
          <div className="flex flex-wrap gap-2">
            {IMPREST_CATEGORIES.map((c) => (
              // The chip is styled from its radio with `peer-*`, not `has-[…]`: a `:has()` rule makes
              // every radio's `disabled` write re-check its label's style, which on a slow phone
              // pushed Submit's acknowledgement past 100 ms.
              <label key={c} className="inline-flex cursor-pointer">
                <input
                  type="radio"
                  name="category"
                  value={c}
                  className="peer sr-only"
                  checked={category === c}
                  disabled={locked}
                  onChange={() => setCategory(c)}
                />
                <span
                  className={`${TOUCH_FLOOR} inline-flex items-center rounded-full border border-border px-3 py-1.5 text-sm peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2`}
                >
                  {t(`imprest.spending.category.${c}`)}
                </span>
              </label>
            ))}
          </div>
          {error("category")}
        </fieldset>

        <Field>
          <Label htmlFor="propose-amount">{t("imprest.spending.propose.amount")}</Label>
          <Input
            id="propose-amount"
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            value={amount}
            readOnly={locked}
            aria-invalid={problems?.amount ? true : undefined}
            aria-describedby={
              [problems?.amount ? "propose-amount-error" : "", shortfall ? "propose-amount-over" : ""]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onChange={(event) => setAmount(event.target.value)}
          />
          {shortfall ? (
            <Help id="propose-amount-over" data-testid="over-free">
              {t("imprest.spending.propose.overFree", { shortfall: formatTzs(shortfall, locale) })}
            </Help>
          ) : null}
          {error("amount")}
        </Field>

        <Field>
          <Label htmlFor="propose-purpose">{t("imprest.spending.propose.purpose")}</Label>
          <Input
            id="propose-purpose"
            name="purpose"
            autoComplete="off"
            maxLength={PURPOSE_MAX}
            value={purpose}
            readOnly={locked}
            aria-invalid={problems?.purpose ? true : undefined}
            aria-describedby={problems?.purpose ? "propose-purpose-error" : "propose-purpose-help"}
            onChange={(event) => setPurpose(event.target.value)}
          />
          <Help id="propose-purpose-help">{t("imprest.spending.propose.purposeHelp")}</Help>
          {error("purpose")}
          {recentPurposes.length > 0 ? (
            <div className="flex flex-col gap-2" data-testid="recent-purposes">
              <span className="text-xs text-muted-foreground">{t("imprest.spending.propose.recent")}</span>
              <div className="flex flex-wrap gap-2">
                {recentPurposes.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant="secondary"
                    size="small"
                    className={TOUCH_FLOOR}
                    disabled={locked}
                    onClick={() => setPurpose(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </Field>

        <Button
          type="submit"
          className={`${TOUCH_FLOOR} self-start`}
          pending={controller.running === "propose"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
        >
          {t("imprest.spending.propose.submit")}
        </Button>
      </form>
      <Outcome controller={controller} />
    </div>
  );
}

type Target = { id: string; version: number; status: string; amount: number };

/**
 * The controls the viewer may use on this disbursement now, and no others (design.md §4.3). The
 * Manager approves the proposed amount as it stands: there is no field for another figure.
 */
export function DisbursementActions({
  disbursement,
  role,
  isOwn,
}: {
  disbursement: Target;
  role: AppRole;
  isOwn: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const [key, controller, renewKey] = useFreshKey(() => setOpen(null), SPENDING_UNCONFIRMED_KEY);
  const hidden = { disbursementId: disbursement.id, expectedVersion: String(disbursement.version) };
  const shared = { controller, idempotencyKey: key, hidden };

  const toggle = (name: string, labelKey: string, variant: "secondary" | "danger" = "secondary") => (
    <Button
      type="button"
      variant={open === name ? "secondary" : variant}
      size="small"
      className={TOUCH_FLOOR}
      disabled={controller.pending}
      aria-expanded={open === name}
      onClick={() => {
        controller.clear();
        renewKey();
        setOpen(open === name ? null : name);
      }}
    >
      {t(labelKey)}
    </Button>
  );

  const reasonForm = (
    name: string,
    action: typeof rejectDisbursementAction,
    labelKey: string,
    submitKey: string,
  ) => (
    <ActionForm
      {...shared}
      id={name}
      name={name}
      action={action}
      fields={[{ name: "reason", labelKey, kind: "text" }]}
      submitKey={submitKey}
      variant="danger"
      testId={`${name}-form`}
    />
  );

  const forms: Record<string, React.ReactNode> = {
    reject: reasonForm(
      "reject",
      rejectDisbursementAction,
      "imprest.spending.fields.rejectionReason",
      "imprest.spending.actions.confirmReject",
    ),
    withdraw: reasonForm(
      "withdraw",
      withdrawDisbursementAction,
      "imprest.spending.fields.withdrawalReason",
      "imprest.spending.actions.confirmWithdraw",
    ),
    cancel: reasonForm(
      "cancel",
      cancelDisbursementAction,
      "imprest.spending.fields.cancellationReason",
      "imprest.spending.actions.confirmCancel",
    ),
  };

  let direct: React.ReactNode = null;
  let toggles: React.ReactNode = null;

  if (role === "manager" && disbursement.status === "proposed") {
    direct = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          for (const [k, v] of Object.entries(hidden)) data.set(k, v);
          data.set("idempotencyKey", key);
          setOpen(null);
          controller.run("approve", approveDisbursementAction, data);
        }}
      >
        <Button
          type="submit"
          className={TOUCH_FLOOR}
          data-testid="approve-disbursement"
          pending={controller.running === "approve"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
        >
          {t("imprest.spending.actions.approve", { amount: formatTzs(disbursement.amount, locale) })}
        </Button>
      </form>
    );
    toggles = toggle("reject", "imprest.spending.actions.reject", "danger");
  } else if (role === "manager" && disbursement.status === "approved") {
    toggles = toggle("cancel", "imprest.spending.actions.cancel", "danger");
  } else if (role === "cashier" && isOwn && disbursement.status === "proposed") {
    toggles = toggle("withdraw", "imprest.spending.actions.withdraw", "danger");
  }

  // After the last action a viewer may take, the controls go but the server's answer stays.
  if (!toggles && !direct) {
    return controller.result.successKey || controller.result.error ? (
      <Outcome controller={controller} />
    ) : null;
  }

  return (
    <section className="flex flex-col gap-3" aria-label={t("imprest.spending.actions.heading")}>
      <div className="flex flex-wrap items-center gap-2">
        {direct}
        {toggles}
      </div>
      {open && forms[open] ? <div key={`${open}-${disbursement.version}`}>{forms[open]}</div> : null}
      <Outcome controller={controller} />
    </section>
  );
}
