"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { handOutRaiseAction, requestRaiseAction } from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Help } from "@/components/ui/field";
import { formatTzs } from "@/lib/money";

/**
 * The Cashier's side of a raised approval (issue #70), on the same feedback contract as every
 * imprest form (design.md §12.7): acknowledged at once, one activation at a time, a retry resends the
 * same key, nothing typed is cleared on a refusal, success only after the server confirms it.
 *
 * The Cashier never types the approved amount. They ask for an increase and say why; the Manager
 * raises it; the Cashier records handing out the extra. The approved amount is the database's sum.
 */

const SPENDING_UNCONFIRMED_KEY = "spendingErrors.unconfirmed";

type Target = { id: string; version: number };
type RaiseRef = { id: string; amount: number };

/** A request for more the Manager has not decided, or a raise still to be handed out. */
export function RaisePending({
  openRequest,
  awaitingHandOut,
  approved,
  disbursement,
  onDone,
}: {
  openRequest: RaiseRef | null;
  awaitingHandOut: RaiseRef | null;
  approved: number;
  disbursement: Target;
  onDone: (successKey: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  if (openRequest) {
    return (
      <p className="text-sm" data-testid="raise-waiting">
        {t("imprest.spending.raise.waiting", {
          amount: formatTzs(openRequest.amount, locale),
          approved: formatTzs(approved, locale),
        })}
      </p>
    );
  }
  if (awaitingHandOut) {
    return (
      <HandOutExtraForm disbursement={disbursement} raise={awaitingHandOut} onDone={onDone} />
    );
  }
  return null;
}

/** Records that the raised increase went out, and to whom. There is no amount field. */
function HandOutExtraForm({
  disbursement,
  raise,
  onDone,
}: {
  disbursement: Target;
  raise: RaiseRef;
  onDone: (successKey: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [key, controller] = useFreshKey(
    () => onDone("imprest.spending.success.raiseHandedOut"),
    SPENDING_UNCONFIRMED_KEY,
  );
  return (
    <div className="flex flex-col gap-3" data-testid="hand-out-extra">
      <h3 className="font-semibold">{t("imprest.spending.raise.handOutTitle")}</h3>
      <Help>{t("imprest.spending.raise.handOutHelp", { amount: formatTzs(raise.amount, locale) })}</Help>
      <ActionForm
        id="hand-out-extra"
        controller={controller}
        name="handOutExtra"
        action={handOutRaiseAction}
        hidden={{
          disbursementId: disbursement.id,
          expectedVersion: String(disbursement.version),
          raiseId: raise.id,
        }}
        fields={[{ name: "recipient", labelKey: "imprest.spending.raise.recipient", kind: "text" }]}
        submitKey="imprest.spending.raise.handOutSubmit"
        testId="hand-out-extra-form"
        idempotencyKey={key}
      />
      {controller.result.successKey ? null : <Outcome controller={controller} />}
    </div>
  );
}

/**
 * Asks for more than was approved, while the cash is out or the settlement is sent back. The Manager
 * decides; nothing is set aside and nothing may be paid beyond the approval until then.
 */
export function AskForMore({
  disbursement,
  approved,
  onDone,
}: {
  disbursement: Target;
  approved: number;
  onDone: (successKey: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [key, controller, renewKey] = useFreshKey(() => {
    setOpen(false);
    onDone("imprest.spending.success.raiseRequested");
  }, SPENDING_UNCONFIRMED_KEY);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3" data-testid="ask-for-more">
      <div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={TOUCH_FLOOR}
          disabled={controller.pending}
          aria-expanded={open}
          data-testid="ask-for-more-toggle"
          onClick={() => {
            // An unconfirmed request may already have committed. Keep it, and its key, until Try
            // again finds out; a fresh key would turn a committed change into a stale refusal.
            if (!(controller.retry && controller.result.error === SPENDING_UNCONFIRMED_KEY)) {
              controller.clear();
              renewKey();
            }
            setOpen(!open);
          }}
        >
          {t("imprest.spending.raise.open")}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-3">
          <Help>{t("imprest.spending.raise.help", { amount: formatTzs(approved, locale) })}</Help>
          <ActionForm
            id="ask-for-more"
            controller={controller}
            name="askForMore"
            action={requestRaiseAction}
            hidden={{ disbursementId: disbursement.id, expectedVersion: String(disbursement.version) }}
            fields={[
              { name: "amount", labelKey: "imprest.spending.raise.amount", kind: "amount" },
              { name: "reason", labelKey: "imprest.spending.raise.reason", kind: "text" },
            ]}
            submitKey="imprest.spending.raise.submit"
            testId="ask-for-more-form"
            idempotencyKey={key}
          />
        </div>
      ) : null}
      {controller.result.successKey ? null : <Outcome controller={controller} />}
    </div>
  );
}
