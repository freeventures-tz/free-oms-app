"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveReversalAction,
  rejectReversalAction,
  requestReversalAction,
} from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Help } from "@/components/ui/field";
import { formatTzs } from "@/lib/money";

/**
 * Reversal controls (issue #71), on the same feedback contract as every imprest form (design.md
 * §12.7): acknowledged at once, one activation at a time, a retry resends the same key, nothing typed
 * is cleared on a refusal, success only after the server confirms it.
 *
 * A Cashier (on their own payment) or the Manager asks; a Director approves or rejects. The Director
 * types no amount: the correct amount is the one that was asked for.
 */

const REVERSAL_UNCONFIRMED_KEY = "reversalErrors.unconfirmed";

/**
 * Asks a Director to reverse one posting and post it again at the correct amount. It stays in place
 * once a request waits, so the confirmation outlives the step and the wait is said in words.
 */
export function RequestReversal({ postingId, waiting }: { postingId: string; waiting: boolean }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [key, controller, renewKey] = useFreshKey(() => setOpen(false), REVERSAL_UNCONFIRMED_KEY);

  // An unconfirmed request may already have committed. Until Try again finds out it keeps its key,
  // and the form stays open with what was typed, so a different request never reuses that key.
  const unconfirmed = Boolean(controller.retry) && controller.result.error === REVERSAL_UNCONFIRMED_KEY;

  if (waiting && !open) {
    return (
      <div className="flex flex-col gap-2" data-testid="request-reversal">
        <p className="text-sm text-muted-foreground" data-testid="reversal-waiting">
          {t("imprest.reversal.waiting")}
        </p>
        <Outcome controller={controller} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="request-reversal">
      <div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={TOUCH_FLOOR}
          disabled={controller.pending || unconfirmed}
          aria-expanded={open}
          data-testid="request-reversal-toggle"
          onClick={() => {
            controller.clear();
            renewKey();
            setOpen(!open);
          }}
        >
          {t("imprest.reversal.open")}
        </Button>
      </div>
      {open ? (
        <ActionForm
          id={`reversal-${postingId}`}
          controller={controller}
          name="requestReversal"
          action={requestReversalAction}
          hidden={{ postingId }}
          fields={[
            {
              name: "correct",
              labelKey: "imprest.reversal.correct",
              kind: "amount",
              helpKey: "imprest.reversal.correctHelp",
            },
            { name: "reason", labelKey: "imprest.reversal.reason", kind: "text" },
          ]}
          submitKey="imprest.reversal.submit"
          testId="request-reversal-form"
          idempotencyKey={key}
        />
      ) : null}
      <Outcome controller={controller} />
    </div>
  );
}

/**
 * The Director's decision on one open request. Approving says what will be posted and where the
 * posted balance lands, from figures read when the page loaded; the database checks them again.
 */
export function DecideReversal({
  reversal,
  open,
  postedBalance,
  freeToApprove,
}: {
  reversal: { id: string; version: number; original: number; correct: number };
  /** Still waiting for a Director. Once decided only this viewer's own answer is shown. */
  open: boolean;
  postedBalance: number | null;
  freeToApprove: number | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  const [rejecting, setRejecting] = useState(false);
  const [key, controller, renewKey] = useFreshKey(() => setRejecting(false), REVERSAL_UNCONFIRMED_KEY);
  const hidden = { reversalId: reversal.id, expectedVersion: String(reversal.version) };
  const unconfirmed = Boolean(controller.retry) && controller.result.error === REVERSAL_UNCONFIRMED_KEY;
  const replacement =
    reversal.correct > 0
      ? t("imprest.reversal.replacementOf", { amount: tzs(reversal.correct) })
      : t("imprest.reversal.noReplacement");

  // Once decided the controls go; the server's answer stays.
  if (controller.result.successKey || !open) {
    return controller.result.successKey || controller.result.error ? <Outcome controller={controller} /> : null;
  }

  return (
    <section className="flex flex-col gap-3" data-testid="decide-reversal" aria-label={t("imprest.reversal.approve")}>
      <form
        className="flex flex-col gap-2"
        data-testid="approve-reversal-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          for (const [k, v] of Object.entries(hidden)) data.set(k, v);
          data.set("idempotencyKey", key);
          setRejecting(false);
          controller.run("approve", approveReversalAction, data);
        }}
      >
        <Help>
          {t("imprest.reversal.approveHelp", {
            original: tzs(reversal.original),
            replacement,
            before: postedBalance === null ? "-" : tzs(postedBalance),
            after: postedBalance === null ? "-" : tzs(postedBalance + reversal.original - reversal.correct),
            free: freeToApprove === null ? "-" : tzs(freeToApprove),
          })}
        </Help>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            className={TOUCH_FLOOR}
            data-testid="approve-reversal"
            pending={controller.running === "approve"}
            pendingLabel={t("common.loading")}
            disabled={controller.pending}
          >
            {t("imprest.reversal.approve")}
          </Button>
          <Button
            type="button"
            variant={rejecting ? "secondary" : "danger"}
            size="small"
            className={TOUCH_FLOOR}
            disabled={controller.pending}
            aria-expanded={rejecting}
            data-testid="reject-reversal-toggle"
            onClick={() => {
              // Keep an unconfirmed decision's key until Try again finds out whether it committed.
              if (!unconfirmed) {
                controller.clear();
                renewKey();
              }
              setRejecting(!rejecting);
            }}
          >
            {t("imprest.reversal.reject")}
          </Button>
        </div>
      </form>
      {rejecting ? (
        <ActionForm
          id={`reject-reversal-${reversal.id}`}
          controller={controller}
          name="rejectReversal"
          action={rejectReversalAction}
          hidden={hidden}
          fields={[{ name: "reason", labelKey: "imprest.reversal.rejectReason", kind: "text" }]}
          submitKey="imprest.reversal.rejectConfirm"
          variant="danger"
          testId="reject-reversal-form"
          idempotencyKey={key}
        />
      ) : null}
      <Outcome controller={controller} />
    </section>
  );
}
