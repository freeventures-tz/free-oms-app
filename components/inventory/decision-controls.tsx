"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { InventoryActionState } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, Help, Input, Label } from "@/components/ui/field";
import { StatusChip } from "@/components/ui/surface";
import type { ApprovalState } from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * Approve or reject, on the three records that need a decision: a supplier receipt, an internal
 * transfer, and a manual stock adjustment.
 *
 * One component rather than three, because the RULES are identical and only the wording differs.
 * §4.3 is what they share and it is easy to get subtly wrong per screen: a rejection is a completed
 * decision with a reason and no approver, an approval is final, and neither may be offered twice.
 *
 * Feedback contract (design.md §12.7), which this owns so no caller re-derives it:
 *
 *   · The tap is acknowledged without waiting for the server, and the button keeps its width.
 *   · A second activation cannot reach the handler while one is in flight.
 *   · Approve and Reject are siblings: while either is working the other is disabled, so a burst
 *     across both cannot send two decisions about one record.
 *   · A refusal keeps the typed reason exactly as it was, and a retry reuses the same idempotency
 *     key so a request that did reach the server is resumed rather than duplicated.
 *   · Success is only ever what the server returned.
 */

export type DecisionAction = (
  previous: InventoryActionState,
  data: FormData,
) => Promise<InventoryActionState>;

export function ApprovalBadge({ approval }: { approval: ApprovalState }) {
  const t = useTranslations("inventory.status");

  if (approval.status === "approved") {
    return (
      <StatusChip tone="success">
        {approval.decidedByName
          ? t("approvedBy", { who: approval.decidedByName })
          : t("approved")}
      </StatusChip>
    );
  }

  if (approval.status === "pending") {
    return <StatusChip tone="attention">{t("pending")}</StatusChip>;
  }

  // Everything else — rejected, cancelled, expired, superseded, withdrawn — is a completed decision
  // and NOT an approval (§4.3). They share one treatment because they share one meaning: this is
  // settled, and nothing was approved.
  return (
    <StatusChip tone="danger">
      {approval.decidedByName ? t("rejectedBy", { who: approval.decidedByName }) : t("rejected")}
    </StatusChip>
  );
}

export function DecisionControls({
  entityId,
  approval,
  canDecide,
  approveAction,
  rejectAction,
  approveLabel,
  /** Named so the confirmation says what will happen, per design.md §10.8. */
  approveConsequence,
}: {
  entityId: string;
  approval: ApprovalState;
  canDecide: boolean;
  approveAction: DecisionAction;
  rejectAction: DecisionAction;
  approveLabel: string;
  approveConsequence: string;
}) {
  const t = useTranslations();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  /**
   * ONE idempotency key per record, minted when the row first renders and reused for every attempt
   * on it — including a retry after a failure. Two taps therefore address the same decision rather
   * than writing two rows into permanent approval history.
   *
   * Minted in an initialiser rather than during render, so the server and the client never disagree
   * about it; a hydration mismatch here would silently defeat the protection.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"approve" | "reject", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
  });
  const { pending, running, result } = action;

  if (approval.status !== "pending") {
    return (
      <div className="flex flex-col items-start gap-1">
        <ApprovalBadge approval={approval} />
        {/* The reason a rejection was given. §4.3 requires it to be recorded; showing it is what
            makes the record answerable a year later. */}
        {approval.note ? (
          <p className="text-xs text-muted-foreground">
            {t("inventory.status.reasonGiven", { reason: approval.note })}
          </p>
        ) : null}
      </div>
    );
  }

  if (!canDecide) {
    return (
      <div className="flex flex-col items-start gap-1">
        <ApprovalBadge approval={approval} />
        {/* No greyed-out Approve button. A role that can never decide this is not shown a control
            it cannot use (design.md §4.3, §4.4). */}
      </div>
    );
  }

  if (result.successKey) {
    return <p className="text-sm text-success">{t(result.successKey)}</p>;
  }

  function submit(name: "approve" | "reject", withReason: boolean) {
    const data = new FormData();
    data.set("entityId", entityId);
    data.set("idempotencyKey", idempotencyKey);
    if (withReason) data.set("reason", reason);
    action.run(name, name === "approve" ? approveAction : rejectAction, data);
  }

  return (
    <div className="flex flex-col gap-3">
      <ApprovalBadge approval={approval} />

      {result.error ? (
        <div className="flex flex-col gap-2">
          {/* The message and its numbers are two keys, not one with placeholders. A refusal must
              render whether or not the server sent the figures with it: a message that needs
              `{available}` would show a raw placeholder on the one path that did not carry it,
              which is a worse answer than a plain sentence. */}
          <FormError>
            {t(result.error)}
            {result.errorValues ? (
              <span className="fv-numeric mt-1 block font-normal">
                {t("inventoryErrors.insufficient_stock_detail", result.errorValues)}
              </span>
            ) : null}
          </FormError>
          {action.retry ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                pending={pending}
                pendingLabel={t("common.loading")}
                onClick={action.retry}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {rejecting ? (
        <div className="flex flex-col gap-3">
          <Field>
            <Label htmlFor={`reason-${entityId}`}>{t("inventory.decision.reasonLabel")}</Label>
            <Input
              id={`reason-${entityId}`}
              type="text"
              autoComplete="off"
              value={reason}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
            <Help>{t("inventory.decision.reasonHelp")}</Help>
            <FieldError>
              {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
            </FieldError>
          </Field>
          <div className="flex flex-col gap-2 md:flex-row">
            <Button
              type="button"
              variant="danger"
              size="small"
              data-testid={`reject-confirm-${entityId}`}
              pending={running === "reject"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => submit("reject", true)}
            >
              {t("inventory.decision.rejectConfirm")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={pending}
              onClick={() => setRejecting(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            size="small"
            data-testid={`approve-${entityId}`}
            pending={running === "approve"}
            pendingLabel={t("common.loading")}
            // Disabled while its sibling is working, so a burst across both controls cannot send
            // two decisions about one record.
            disabled={pending}
            onClick={() => submit("approve", false)}
          >
            {approveLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            data-testid={`reject-${entityId}`}
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            {t("inventory.decision.reject")}
          </Button>
        </div>
      )}

      {/* What approving will DO, stated before it happens rather than confirmed afterwards
          (design.md §10.8, §11.8). */}
      <Help>{approveConsequence}</Help>
    </div>
  );
}
