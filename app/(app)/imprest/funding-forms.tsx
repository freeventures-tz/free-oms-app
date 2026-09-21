"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveFundingAction,
  confirmReceivedAction,
  correctHandoverAction,
  increaseApprovalAction,
  provideFundingAction,
  rejectFundingAction,
  reportMismatchAction,
  requestFundingAction,
  type ImprestActionState,
} from "@/app/(app)/imprest/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import type { AppRole } from "@/lib/auth/roles";
import type { FundingSummary } from "@/lib/imprest/funding";
import { formatTzs } from "@/lib/money";
import { useGuardedAction, type GuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * Imprest funding controls (issue #48), built on the feedback contract of design.md §12.7:
 * a tap is acknowledged at once by `Button pending`, a working control keeps its size and refuses
 * a second activation, a retry resends the same request and key, nothing typed is cleared on a
 * refusal, and success is shown only after the server confirms it.
 *
 * A new key is drawn only after a success. A retry after a timeout therefore replays the request
 * that may already have committed instead of creating a second one.
 */

const TOUCH_FLOOR = "min-h-11 md:min-h-11 xl:min-h-0";

type FieldSpec = {
  name: string;
  labelKey: string;
  kind: "amount" | "text";
  initial?: string;
  helpKey?: string;
};

type Controller = ReturnType<typeof useGuardedAction<string, ImprestActionState>>;

function Outcome({ controller }: { controller: Controller }) {
  const t = useTranslations();
  const { result } = controller;
  if (result.successKey) {
    return <FormSuccess role="status">{t(result.successKey)}</FormSuccess>;
  }
  if (!result.error) return null;
  return (
    <div className="flex flex-col gap-2">
      <FormError>{t(result.error, result.errorValues ?? {})}</FormError>
      {controller.retry ? (
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={TOUCH_FLOOR}
          pending={controller.pending}
          pendingLabel={t("common.loading")}
          onClick={controller.retry}
        >
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

function ActionForm({
  id,
  controller,
  name,
  action,
  hidden,
  fields,
  submitKey,
  variant,
  testId,
  idempotencyKey,
}: {
  id: string;
  controller: Controller;
  name: string;
  action: GuardedAction<ImprestActionState>;
  hidden: Record<string, string>;
  fields: FieldSpec[];
  submitKey: string;
  variant?: "danger" | "secondary";
  testId: string;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ""])),
  );
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData();
        for (const [key, value] of Object.entries({ ...hidden, ...values })) data.set(key, value);
        data.set("idempotencyKey", idempotencyKey);
        controller.run(name, action, data);
      }}
    >
      {fields.map((f) => {
        const problem = problems?.[f.name];
        const fieldId = `${id}-${f.name}`;
        return (
          <Field key={f.name}>
            <Label htmlFor={fieldId}>{t(f.labelKey)}</Label>
            <Input
              id={fieldId}
              name={f.name}
              inputMode={f.kind === "amount" ? "numeric" : undefined}
              autoComplete="off"
              value={values[f.name]}
              readOnly={controller.pending}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${fieldId}-error` : undefined}
              onChange={(event) => setValues((v) => ({ ...v, [f.name]: event.target.value }))}
            />
            {f.helpKey ? <Help>{t(f.helpKey)}</Help> : null}
            {problem ? (
              <span id={`${fieldId}-error`}>
                <FieldError>{t(problem)}</FieldError>
              </span>
            ) : null}
          </Field>
        );
      })}
      <Button
        type="submit"
        variant={variant}
        className={`${TOUCH_FLOOR} self-start`}
        pending={controller.running === name}
        pendingLabel={t("common.loading")}
        disabled={controller.pending}
      >
        {t(submitKey)}
      </Button>
    </form>
  );
}

/** Draws a fresh key after each success, so a retry after failure replays the same request. */
function useFreshKey(onSuccess?: () => void): [string, Controller, () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  const controller = useGuardedAction<string, ImprestActionState>({
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setKey(crypto.randomUUID());
        onSuccess?.();
      }
    },
  });
  return [key, controller, () => setKey(crypto.randomUUID())];
}

export function RequestFundingForm() {
  // Remount the fields after a success so the next request starts empty; a refusal keeps them.
  const [round, setRound] = useState(0);
  const [key, controller] = useFreshKey(() => setRound((r) => r + 1));

  return (
    <div className="flex flex-col gap-3">
      <ActionForm
        key={round}
        id="request"
        controller={controller}
        name="request"
        action={requestFundingAction}
        hidden={{}}
        fields={[
          { name: "amount", labelKey: "imprest.fields.amount", kind: "amount" },
          { name: "reason", labelKey: "imprest.fields.reason", kind: "text" },
        ]}
        submitKey="imprest.actions.request"
        testId="request-funding-form"
        idempotencyKey={key}
      />
      <Outcome controller={controller} />
    </div>
  );
}

/**
 * The controls the viewer may use on this funding right now, and no others. A control nobody may
 * use is absent rather than greyed (design.md §4.3).
 */
export function FundingActions({ funding, role }: { funding: FundingSummary; role: AppRole }) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  // Opening a different form starts a different operation, so it gets its own key.
  const [key, controller, renewKey] = useFreshKey(() => setOpen(null));
  const hidden = { fundingId: funding.id, expectedVersion: String(funding.version) };
  const answer = { ...hidden, handoverId: funding.handoverId ?? "" };

  const toggle = (name: string, labelKey: string, variant?: "secondary" | "danger") => (
    <Button
      type="button"
      variant={open === name ? "secondary" : (variant ?? "secondary")}
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

  const shared = { controller, idempotencyKey: key };
  const forms: Record<string, React.ReactNode> = {
    approve: (
      <ActionForm
        {...shared}
        id="approve"
        name="approve"
        action={approveFundingAction}
        hidden={hidden}
        fields={[
          {
            name: "amount",
            labelKey: "imprest.fields.approvedAmount",
            kind: "amount",
            initial: String(funding.requestedAmount),
          },
        ]}
        submitKey="imprest.actions.approve"
        testId="approve-form"
      />
    ),
    reject: (
      <ActionForm
        {...shared}
        id="reject"
        name="reject"
        action={rejectFundingAction}
        hidden={hidden}
        fields={[{ name: "reason", labelKey: "imprest.fields.rejectionReason", kind: "text" }]}
        submitKey="imprest.actions.confirmReject"
        variant="danger"
        testId="reject-form"
      />
    ),
    provide: (
      <ActionForm
        {...shared}
        id="provide"
        name="provide"
        action={provideFundingAction}
        hidden={hidden}
        fields={[
          {
            name: "amount",
            labelKey: "imprest.fields.providedAmount",
            kind: "amount",
            initial: String(funding.approvedAmount ?? ""),
            helpKey: "imprest.help.provide",
          },
        ]}
        submitKey="imprest.actions.provide"
        testId="provide-form"
      />
    ),
    increase: (
      <ActionForm
        {...shared}
        id="increase"
        name="increase"
        action={increaseApprovalAction}
        hidden={hidden}
        fields={[
          { name: "amount", labelKey: "imprest.fields.newApproval", kind: "amount" },
          { name: "note", labelKey: "imprest.fields.note", kind: "text" },
        ]}
        submitKey="imprest.actions.increase"
        testId="increase-form"
      />
    ),
    correct: (
      <ActionForm
        {...shared}
        id="correct"
        name="correct"
        action={correctHandoverAction}
        hidden={hidden}
        fields={[
          {
            name: "amount",
            labelKey: "imprest.fields.correctedAmount",
            kind: "amount",
            helpKey: "imprest.help.provide",
          },
          { name: "explanation", labelKey: "imprest.fields.explanation", kind: "text" },
        ]}
        submitKey="imprest.actions.correct"
        testId="correct-form"
      />
    ),
    mismatch: (
      <ActionForm
        {...shared}
        id="mismatch"
        name="mismatch"
        action={reportMismatchAction}
        hidden={answer}
        fields={[
          {
            name: "counted",
            labelKey: "imprest.fields.counted",
            kind: "amount",
            helpKey: "imprest.help.counted",
          },
          { name: "note", labelKey: "imprest.fields.note", kind: "text" },
        ]}
        submitKey="imprest.actions.reportMismatch"
        variant="danger"
        testId="mismatch-form"
      />
    ),
  };

  let toggles: React.ReactNode = null;
  let direct: React.ReactNode = null;

  if (role === "director" && funding.status === "requested") {
    toggles = (
      <>
        {toggle("approve", "imprest.actions.approve")}
        {toggle("reject", "imprest.actions.reject")}
      </>
    );
  } else if (role === "director" && funding.status === "approved") {
    toggles = (
      <>
        {toggle("provide", "imprest.actions.provide")}
        {toggle("increase", "imprest.actions.increase")}
      </>
    );
  } else if (role === "director" && funding.status === "disputed") {
    toggles = (
      <>
        {toggle("correct", "imprest.actions.correct")}
        {toggle("increase", "imprest.actions.increase")}
      </>
    );
  } else if (role === "manager" && funding.status === "provided" && funding.handoverId) {
    direct = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          for (const [k, v] of Object.entries(answer)) data.set(k, v);
          data.set("idempotencyKey", key);
          controller.run("confirm", confirmReceivedAction, data);
        }}
      >
        <Button
          type="submit"
          className={TOUCH_FLOOR}
          data-testid="confirm-received"
          pending={controller.running === "confirm"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
        >
          {t("imprest.actions.confirm", { amount: formatTzs(funding.providedAmount ?? 0, locale) })}
        </Button>
      </form>
    );
    toggles = toggle("mismatch", "imprest.actions.reportMismatch", "danger");
  }

  if (!toggles && !direct) return null;

  return (
    <section className="flex flex-col gap-3" aria-label={t("imprest.actions.heading")}>
      {direct}
      <div className="flex flex-wrap gap-2">{toggles}</div>
      {open && forms[open] ? <div key={`${open}-${funding.version}`}>{forms[open]}</div> : null}
      <Outcome controller={controller} />
    </section>
  );
}
