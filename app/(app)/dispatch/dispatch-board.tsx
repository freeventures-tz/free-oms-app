"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  assignDispatchAction,
  confirmReleaseAction,
  recordDispatchNoteAction,
  type SettlementActionState,
} from "@/app/(app)/payments/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct } from "@/lib/catalogue/catalogue";
import type { InventoryLocation } from "@/lib/inventory/inventory";
import type { AppRole } from "@/lib/auth/roles";
import type {
  Dispatch,
  OutstandingClaim,
  SettlementInvoice,
  Storekeeper,
} from "@/lib/settlement/settlement";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/** design.md §7.9: the queue is grouped by stage, so a person sees only their own next action. */
const STAGE_TONE: Record<string, "neutral" | "success" | "attention" | "danger"> = {
  assigned: "attention",
  note_recorded: "attention",
  released: "success",
  cancelled: "danger",
};

export function DispatchBoard({
  dispatches,
  outstanding,
  storekeepers,
  invoices,
  products,
  locations,
  role,
  idempotencyKey,
}: {
  dispatches: Dispatch[];
  outstanding: OutstandingClaim[];
  storekeepers: Storekeeper[];
  invoices: SettlementInvoice[];
  products: CatalogueProduct[];
  locations: InventoryLocation[];
  role: AppRole;
  idempotencyKey: string;
}) {
  const t = useTranslations("settlement.dispatch");

  const canAssign = role === "cashier";
  const canRelease = role === "manager";

  const awaitingAssignment = invoices.filter(
    (invoice) => !dispatches.some((dispatch) => dispatch.invoiceId === invoice.id),
  );
  const assigned = dispatches.filter((dispatch) => dispatch.status === "assigned");
  const noteRecorded = dispatches.filter((dispatch) => dispatch.status === "note_recorded");
  const released = dispatches.filter((dispatch) => dispatch.status === "released");

  return (
    <div className="flex flex-col gap-6">
      {/* The most dangerous state in the system, made unmistakable (design.md §7.12): goods that
          are settled and still in the yard. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          {t("paidUnreleasedHeading", { count: outstanding.length })}
        </h2>
        {outstanding.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("nothingUnreleased")}</p>
          </Card>
        ) : (
          <Card>
            <ul className="flex flex-col gap-2 text-sm">
              {outstanding.map((claim) => {
                const product = products.find((candidate) => candidate.id === claim.productId);
                return (
                  <li
                    key={claim.allocationId}
                    className="flex flex-wrap items-center justify-between gap-2"
                    data-testid={`unreleased-${claim.allocationId}`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusChip tone="attention">{t("paidNotReleased")}</StatusChip>
                      <span className="fv-identifier text-xs">{claim.invoiceNo}</span>
                      <span>{product ? product.name : claim.productId}</span>
                    </span>
                    <span className="fv-numeric text-xs">
                      {t("outstandingQuantity", {
                        count: claim.outstandingQuantity,
                        days: claim.daysWaiting,
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>

      {canAssign ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">
            {t("awaitingAssignmentHeading", { count: awaitingAssignment.length })}
          </h2>
          {awaitingAssignment.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">{t("nothingAwaitingAssignment")}</p>
            </Card>
          ) : (
            awaitingAssignment.map((invoice) => (
              <AssignCard
                key={invoice.id}
                invoice={invoice}
                outstanding={outstanding.filter((claim) => claim.invoiceId === invoice.id)}
                products={products}
                storekeepers={storekeepers}
                locations={locations}
                idempotencyKey={idempotencyKey}
              />
            ))
          )}
        </section>
      ) : null}

      <Stage
        heading={t("assignedHeading", { count: assigned.length })}
        empty={t("nothingAssigned")}
        dispatches={assigned}
        products={products}
        canRelease={canRelease}
        idempotencyKey={idempotencyKey}
      />

      <Stage
        heading={t("awaitingSignatureHeading", { count: noteRecorded.length })}
        empty={t("nothingAwaitingSignature")}
        dispatches={noteRecorded}
        products={products}
        canRelease={canRelease}
        idempotencyKey={idempotencyKey}
      />

      <Stage
        heading={t("releasedHeading")}
        empty={t("nothingReleased")}
        dispatches={released}
        products={products}
        canRelease={false}
        idempotencyKey={idempotencyKey}
      />
    </div>
  );
}

function Stage({
  heading,
  empty,
  dispatches,
  products,
  canRelease,
  idempotencyKey,
}: {
  heading: string;
  empty: string;
  dispatches: Dispatch[];
  products: CatalogueProduct[];
  canRelease: boolean;
  idempotencyKey: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{heading}</h2>
      {dispatches.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{empty}</p>
        </Card>
      ) : (
        dispatches.map((dispatch) => (
          <DispatchCard
            key={dispatch.id}
            dispatch={dispatch}
            products={products}
            canRelease={canRelease}
            idempotencyKey={idempotencyKey}
          />
        ))
      )}
    </section>
  );
}

function DispatchCard({
  dispatch,
  products,
  canRelease,
  idempotencyKey,
}: {
  dispatch: Dispatch;
  products: CatalogueProduct[];
  canRelease: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const [noteNo, setNoteNo] = useState("");
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"note" | "release", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setNoteNo("");
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, running, result } = action;

  return (
    <Card role="article" aria-label={`${dispatch.invoiceNo} ${dispatch.storekeeperName}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="fv-identifier font-medium">{dispatch.invoiceNo}</span>
              <StatusChip tone={STAGE_TONE[dispatch.status] ?? "neutral"}>
                {t(`settlement.dispatch.status.${dispatch.status}`)}
              </StatusChip>
            </span>
            <span className="text-sm text-muted-foreground">{dispatch.customerName}</span>
            <span className="text-xs text-muted-foreground">
              {t("settlement.dispatch.assignedTo", {
                who: dispatch.storekeeperName,
                location: t(`inventory.stock.locations.${dispatch.sourceLocation}`),
              })}
            </span>
            {dispatch.dispatchNoteNo ? (
              <span className="fv-identifier text-xs text-muted-foreground">
                {t("settlement.dispatch.noteNumber", { no: dispatch.dispatchNoteNo })}
              </span>
            ) : null}
          </div>
        </div>

        <ul className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
          {dispatch.lines.map((line) => {
            const product = products.find((candidate) => candidate.id === line.productId);
            return (
              <li key={line.id} className="flex items-center justify-between gap-3">
                <span>{product ? product.name : line.productId}</span>
                <span className="fv-numeric font-medium">{line.quantity}</span>
              </li>
            );
          })}
        </ul>

        {result.error ? (
          <div className="flex flex-col gap-2">
            <FormError>
              {t(result.error)}
              {result.errorValues?.available !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t("settlementErrors.insufficient_stock_detail", result.errorValues)}
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

        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

        {canRelease && dispatch.status === "assigned" ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <Field>
              <Label htmlFor={`note-${dispatch.id}`}>
                {t("settlement.dispatch.noteNumberLabel")}
              </Label>
              <Input
                id={`note-${dispatch.id}`}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="fv-identifier"
                value={noteNo}
                disabled={pending}
                onChange={(event) => setNoteNo(event.target.value)}
              />
              {/* §14, AC-37: the OMS does not produce the note. Saying so is what stops somebody
                  looking for a print button that will never exist. */}
              <Help>{t("settlement.dispatch.noteNumberHelp")}</Help>
              <FieldError>
                {result.fieldErrors?.noteNo ? t(result.fieldErrors.noteNo) : null}
              </FieldError>
            </Field>

            <div className="flex flex-col gap-2 md:flex-row">
              <Button
                type="button"
                data-testid={`record-note-${dispatch.id}`}
                pending={running === "note"}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => {
                  const data = new FormData();
                  data.set("dispatchId", dispatch.id);
                  data.set("noteNo", noteNo);
                  data.set("idempotencyKey", key);
                  action.run("note", recordDispatchNoteAction, data);
                }}
              >
                {t("settlement.dispatch.recordNote")}
              </Button>

              {/* Disabled with its reason shown, until a dispatch-note number exists
                  (design.md §6.3, §4.4). A temporary state the Manager can resolve. */}
              <Button
                type="button"
                variant="secondary"
                data-testid={`release-${dispatch.id}`}
                disabled
              >
                {t("settlement.dispatch.confirmRelease")}
              </Button>
            </div>
            <Help>{t("settlement.dispatch.blockedByNote")}</Help>
          </div>
        ) : null}

        {canRelease && dispatch.status === "note_recorded" ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div>
              <Button
                type="button"
                data-testid={`release-${dispatch.id}`}
                pending={running === "release"}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => {
                  const data = new FormData();
                  data.set("entityId", dispatch.id);
                  data.set("idempotencyKey", key);
                  action.run("release", confirmReleaseAction, data);
                }}
              >
                {t("settlement.dispatch.confirmRelease")}
              </Button>
            </div>
            {/* The exact consequence, named before it happens (design.md §10.8, §11.8). This is the
                one action in the system that takes stock out of the yard. */}
            <Help>{t("settlement.dispatch.releaseConsequence")}</Help>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** §12.6 step 9. Assignment does not move stock, and the screen says so explicitly (§7.10). */
function AssignCard({
  invoice,
  outstanding,
  products,
  storekeepers,
  locations,
  idempotencyKey,
}: {
  invoice: SettlementInvoice;
  outstanding: OutstandingClaim[];
  products: CatalogueProduct[];
  storekeepers: Storekeeper[];
  locations: InventoryLocation[];
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const [storekeeperId, setStorekeeperId] = useState("");
  const [sourceLocation, setSourceLocation] = useState(locations[0]?.code ?? "");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"assign", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setQuantities({});
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (storekeepers.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("settlement.dispatch.noStorekeepers")}</p>
      </Card>
    );
  }

  return (
    <Card role="article" aria-label={invoice.invoiceNo}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="fv-identifier font-medium">{invoice.invoiceNo}</span>
          <span className="text-sm text-muted-foreground">{invoice.customerName}</span>
        </div>

        {result.error ? (
          <div className="flex flex-col gap-2">
            <FormError>
              {t(result.error)}
              {result.errorValues?.outstanding !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t("settlementErrors.outstanding_detail", result.errorValues)}
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

        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <Label htmlFor={`keeper-${invoice.id}`}>{t("settlement.dispatch.storekeeper")}</Label>
            {/* From the registered list only — a select, never free text (design.md §7.10). */}
            <Select
              id={`keeper-${invoice.id}`}
              value={storekeeperId}
              disabled={pending}
              onChange={(event) => setStorekeeperId(event.target.value)}
            >
              <option value="">{t("settlement.dispatch.chooseStorekeeper")}</option>
              {storekeepers.map((keeper) => (
                <option key={keeper.id} value={keeper.id}>
                  {keeper.fullName} ({keeper.code})
                </option>
              ))}
            </Select>
            <FieldError>
              {result.fieldErrors?.storekeeperId ? t(result.fieldErrors.storekeeperId) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor={`from-${invoice.id}`}>{t("settlement.dispatch.sourceLocation")}</Label>
            <Select
              id={`from-${invoice.id}`}
              value={sourceLocation}
              disabled={pending}
              onChange={(event) => setSourceLocation(event.target.value)}
            >
              {locations.map((location) => (
                <option key={location.code} value={location.code}>
                  {t(`inventory.stock.locations.${location.code}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("settlement.dispatch.whatToFetch")}</h3>
          <FieldError>{result.fieldErrors?.lines ? t(result.fieldErrors.lines) : null}</FieldError>

          {outstanding.map((claim) => {
            const product = products.find((candidate) => candidate.id === claim.productId);
            return (
              <Field key={claim.allocationId}>
                <Label htmlFor={`qty-${claim.allocationId}`}>
                  {product ? product.name : claim.productId}
                </Label>
                <Input
                  id={`qty-${claim.allocationId}`}
                  type="text"
                  inputMode="numeric"
                  className="fv-numeric"
                  value={quantities[claim.allocationId] ?? String(claim.outstandingQuantity)}
                  disabled={pending}
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [claim.allocationId]: event.target.value,
                    }))
                  }
                />
                {/* A partial release is allowed and the remainder stays committed (§12), so the
                    outstanding figure is stated rather than assumed. */}
                <Help>
                  {t("settlement.dispatch.stillOwed", { count: claim.outstandingQuantity })}
                </Help>
              </Field>
            );
          })}
        </div>

        <div>
          <Button
            type="button"
            data-testid={`assign-${invoice.id}`}
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("invoiceId", invoice.id);
              data.set("storekeeperId", storekeeperId);
              data.set("sourceLocation", sourceLocation);
              data.set(
                "lines",
                JSON.stringify(
                  outstanding.map((claim) => ({
                    allocationId: claim.allocationId,
                    quantity:
                      quantities[claim.allocationId] ?? String(claim.outstandingQuantity),
                  })),
                ),
              );
              data.set("idempotencyKey", key);
              action.run("assign", assignDispatchAction, data);
            }}
          >
            {t("settlement.dispatch.assign")}
          </Button>
        </div>

        {/* design.md §7.10: assignment does not move stock, and the screen says so explicitly. */}
        <Help>{t("settlement.dispatch.assignConsequence")}</Help>
      </div>
    </Card>
  );
}
