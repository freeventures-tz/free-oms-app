"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveRetirementAction,
  rejectRetirementAction,
  submitRetirementAction,
} from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Help } from "@/components/ui/field";

/**
 * Retirement controls (issue #72), on the same feedback contract as every imprest form (design.md
 * §12.7): acknowledged at once, one activation at a time, a retry resends the same key, nothing typed
 * is cleared on a refusal, success only after the server confirms it.
 *
 * The Manager submits with a reason, naming the closing count on screen. A Director approves, after
 * a second step that says it cannot be undone (design.md §7B.12), or rejects with a reason.
 */

const RETIREMENT_UNCONFIRMED_KEY = "retirementErrors.unconfirmed";

export function SubmitRetirement({ countId }: { countId: string }) {
  const [key, controller] = useFreshKey(undefined, RETIREMENT_UNCONFIRMED_KEY);

  // Once submitted the form goes; the confirmation stays until the page shows the submission.
  if (controller.result.successKey) return <Outcome controller={controller} />;

  return (
    <div className="flex flex-col gap-3" data-testid="submit-retirement">
      <ActionForm
        id="retire"
        controller={controller}
        name="submitRetirement"
        action={submitRetirementAction}
        hidden={{ countId }}
        fields={[
          {
            name: "reason",
            labelKey: "imprest.retirement.reason",
            kind: "text",
            helpKey: "imprest.retirement.reasonHelp",
          },
        ]}
        submitKey="imprest.retirement.submit"
        testId="submit-retirement-form"
        idempotencyKey={key}
      />
      <Outcome controller={controller} />
    </div>
  );
}

export function DecideRetirement({ retirement }: { retirement: { id: string; version: number } }) {
  const t = useTranslations();
  const [step, setStep] = useState<"idle" | "confirm" | "reject">("idle");
  const [key, controller, renewKey] = useFreshKey(() => setStep("idle"), RETIREMENT_UNCONFIRMED_KEY);
  const hidden = { retirementId: retirement.id, expectedVersion: String(retirement.version) };
  const unconfirmed = Boolean(controller.retry) && controller.result.error === RETIREMENT_UNCONFIRMED_KEY;

  if (controller.result.successKey) return <Outcome controller={controller} />;

  return (
    <section className="flex flex-col gap-3" data-testid="decide-retirement" aria-label={t("imprest.retirement.approve")}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className={TOUCH_FLOOR}
          disabled={controller.pending || unconfirmed}
          aria-expanded={step === "confirm"}
          data-testid="approve-retirement"
          onClick={() => {
            controller.clear();
            if (step !== "confirm") renewKey();
            setStep(step === "confirm" ? "idle" : "confirm");
          }}
        >
          {t("imprest.retirement.approve")}
        </Button>
        <Button
          type="button"
          variant={step === "reject" ? "secondary" : "danger"}
          size="small"
          className={TOUCH_FLOOR}
          // An unconfirmed decision may already have committed under this key. Until Try again finds
          // out, the other decision is closed.
          disabled={controller.pending || unconfirmed}
          aria-expanded={step === "reject"}
          data-testid="reject-retirement-toggle"
          onClick={() => {
            controller.clear();
            renewKey();
            setStep(step === "reject" ? "idle" : "reject");
          }}
        >
          {t("imprest.retirement.reject")}
        </Button>
      </div>
      {step === "confirm" || (unconfirmed && controller.running === null) ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
          data-testid="confirm-retirement-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData();
            for (const [k, v] of Object.entries(hidden)) data.set(k, v);
            data.set("idempotencyKey", key);
            controller.run("approve", approveRetirementAction, data);
          }}
        >
          <Help>{t("imprest.retirement.confirmHelp")}</Help>
          <Button
            type="submit"
            className={`${TOUCH_FLOOR} self-start`}
            data-testid="confirm-retirement"
            pending={controller.running === "approve"}
            pendingLabel={t("common.loading")}
            disabled={controller.pending}
          >
            {t("imprest.retirement.confirm")}
          </Button>
        </form>
      ) : null}
      {step === "reject" ? (
        <ActionForm
          id={`reject-retirement-${retirement.id}`}
          controller={controller}
          name="rejectRetirement"
          action={rejectRetirementAction}
          hidden={hidden}
          fields={[{ name: "reason", labelKey: "imprest.retirement.rejectReason", kind: "text" }]}
          submitKey="imprest.retirement.rejectConfirm"
          variant="danger"
          testId="reject-retirement-form"
          idempotencyKey={key}
        />
      ) : null}
      <Outcome controller={controller} />
    </section>
  );
}
