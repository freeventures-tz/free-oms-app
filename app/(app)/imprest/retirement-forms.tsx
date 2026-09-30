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
 *
 * ONE COMPONENT, ALWAYS MOUNTED IN ONE PLACE. A success refreshes the page into its next state: a
 * submitted retirement has no submit form, an approved one no decision. Rendered in the same spot
 * whatever the state, this keeps its answer on screen after the controls it came from are gone.
 */

const RETIREMENT_UNCONFIRMED_KEY = "retirementErrors.unconfirmed";

export function RetirementActions({
  submit,
  decide,
}: {
  /** The closing count the Manager may submit against, or null when they may not submit now. */
  submit: { countId: string } | null;
  /** The retirement a Director may decide, or null. */
  decide: { id: string; version: number } | null;
}) {
  const t = useTranslations();
  const [step, setStep] = useState<"idle" | "confirm" | "reject">("idle");
  const [round, setRound] = useState(0);
  const [key, controller, renewKey] = useFreshKey(() => {
    setStep("idle");
    setRound((r) => r + 1);
  }, RETIREMENT_UNCONFIRMED_KEY);
  const unconfirmed = Boolean(controller.retry) && controller.result.error === RETIREMENT_UNCONFIRMED_KEY;
  const hidden: Record<string, string> = decide
    ? { retirementId: decide.id, expectedVersion: String(decide.version) }
    : {};

  return (
    <div className="flex flex-col gap-3" data-testid="retirement-actions">
      {submit ? (
        <div data-testid="submit-retirement">
          <ActionForm
            key={round}
            id="retire"
            controller={controller}
            name="submitRetirement"
            action={submitRetirementAction}
            hidden={{ countId: submit.countId }}
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
        </div>
      ) : null}

      {decide ? (
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
              // An unconfirmed decision may already have committed under this key. Until Try again
              // finds out, the other decision is closed.
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
          {step === "confirm" ? (
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
              id={`reject-retirement-${decide.id}`}
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
        </section>
      ) : null}

      <Outcome controller={controller} />
    </div>
  );
}
