"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import {
  assignDispatchAction,
  confirmReleaseAction,
  recordDispatchNoteAction,
  type SettlementActionState,
} from "@/app/(app)/payments/actions";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct } from "@/lib/catalogue/catalogue";
import type { InventoryLocation } from "@/lib/inventory/inventory";
import type { AppRole } from "@/lib/auth/roles";
import type {
  AssignableInvoice,
  Dispatch,
  DispatchQueue,
  StorekeeperOption,
} from "@/lib/settlement/settlement";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/** design.md §7.9: the queue is grouped by stage, so a person sees only their own next action. */
const STAGE_TONE: Record<string, "neutral" | "success" | "attention" | "danger"> = {
  assigned: "attention",
  note_recorded: "attention",
  released: "success",
  cancelled: "danger",
};

const DISPATCH_PATH = "/dispatch";

/** A key belongs to one card and one command. See the note in `payment-queue.tsx`. */
function newKey(): string {
  return crypto.randomUUID();
}

export function DispatchBoard({
  queue,
  storekeepers,
  products,
  locations,
  role,
}: {
  queue: DispatchQueue;
  /** Three fields, and the loader selects only those three (design.md §7.10). */
  storekeepers: StorekeeperOption[];
  products: CatalogueProduct[];
  locations: InventoryLocation[];
  role: AppRole;
}) {
  const t = useTranslations("settlement.dispatch");

  const canAssign = role === "cashier";
  const canRelease = role === "manager";

  const { live, released, outstanding, assignable } = queue;

  const assigned = live.filter((dispatch) => dispatch.status === "assigned");
  const noteRecorded = live.filter((dispatch) => dispatch.status === "note_recorded");

  return (
    <div className="flex flex-col gap-6">
      {/* The most dangerous state in the system, made unmistakable (design.md §7.12): goods that
          are settled and still in the yard. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          {t("paidUnreleasedHeading", { count: outstanding.total })}
        </h2>
        <Pager
          page={outstanding.page}
          pageSize={outstanding.pageSize}
          total={outstanding.total}
          param="unreleased"
          basePath={DISPATCH_PATH}
          otherParams={{ released: released.page }}
          label={t("paidUnreleasedHeading", { count: outstanding.total })}
        />
        {outstanding.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("nothingUnreleased")}</p>
          </Card>
        ) : (
          <Card>
            <ul className="flex flex-col gap-2 text-sm">
              {outstanding.rows.map((claim) => {
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
            {t("awaitingAssignmentHeading", { count: assignable.length })}
          </h2>
          {assignable.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">{t("nothingAwaitingAssignment")}</p>
            </Card>
          ) : (
            assignable.map((invoice) => (
              <AssignCard
                key={invoice.invoiceId}
                invoice={invoice}
                products={products}
                storekeepers={storekeepers}
                locations={locations}
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
      />

      <Stage
        heading={t("awaitingSignatureHeading", { count: noteRecorded.length })}
        empty={t("nothingAwaitingSignature")}
        dispatches={noteRecorded}
        products={products}
        canRelease={canRelease}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("releasedHeading")}</h2>
        <Pager
          page={released.page}
          pageSize={released.pageSize}
          total={released.total}
          param="released"
          basePath={DISPATCH_PATH}
          otherParams={{ unreleased: outstanding.page }}
          label={t("releasedHeading")}
        />
        {released.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("nothingReleased")}</p>
          </Card>
        ) : (
          released.rows.map((dispatch) => (
            <DispatchCard
              key={dispatch.id}
              dispatch={dispatch}
              products={products}
              canRelease={false}
            />
          ))
        )}
      </section>
    </div>
  );
}

function Stage({
  heading,
  empty,
  dispatches,
  products,
  canRelease,
}: {
  heading: string;
  empty: string;
  dispatches: Dispatch[];
  products: CatalogueProduct[];
  canRelease: boolean;
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
}: {
  dispatch: Dispatch;
  products: CatalogueProduct[];
  canRelease: boolean;
}) {
  const t = useTranslations();
  const [noteNo, setNoteNo] = useState("");
  const [confirming, setConfirming] = useState(false);

  // Two commands on this card, two keys. Recording the note and confirming the release are
  // different operations, and one key between them is claimed by whichever runs first.
  const [noteKey, setNoteKey] = useState(newKey);
  const [releaseKey, setReleaseKey] = useState(newKey);
  const lastRan = useRef<"note" | "release" | null>(null);

  const action = useGuardedAction<"note" | "release", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (!outcome.successKey) return;
      if (lastRan.current === "note") {
        setNoteNo("");
        setNoteKey(newKey());
      } else if (lastRan.current === "release") {
        setConfirming(false);
        setReleaseKey(newKey());
      }
    },
  });
  const { pending, running, result } = action;

  const quantity = dispatch.lines.reduce((total, line) => total + line.quantity, 0);

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

        {result.error && !confirming ? (
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
                  data.set("idempotencyKey", noteKey);
                  lastRan.current = "note";
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
                disabled={pending}
                onClick={() => setConfirming(true)}
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

      {/* §11.8 names confirming a signed release as an action that requires an explicit
          confirmation, because it is the one place stock leaves and it cannot be undone. */}
      <ConfirmSheet
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) action.clear();
        }}
        title={t("settlement.dispatch.releaseTitle")}
        consequence={t("settlement.dispatch.releaseConfirmConsequence", {
          count: quantity,
          who: dispatch.customerName,
          location: t(`inventory.stock.locations.${dispatch.sourceLocation}`),
        })}
        confirmLabel={t("settlement.dispatch.confirmReleaseYes")}
        confirmId={`confirm-release-${dispatch.id}`}
        cancelLabel={t("common.cancel")}
        variant="danger"
        pending={running === "release"}
        pendingLabel={t("common.loading")}
        onConfirm={() => {
          const data = new FormData();
          data.set("entityId", dispatch.id);
          data.set("idempotencyKey", releaseKey);
          lastRan.current = "release";
          action.run("release", confirmReleaseAction, data);
        }}
      >
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
      </ConfirmSheet>
    </Card>
  );
}

/**
 * §12.6 step 9. Assignment does not move stock, and the screen says so explicitly (§7.10).
 *
 * IT REAPPEARS AFTER A PARTIAL RELEASE, which is the whole point of `assignableQuantity`. §12
 * leaves the remainder committed when only part of a dispatch goes out, and the Cashier has to be
 * able to assign that remainder — otherwise a customer who collected half their order could never
 * be given the other half without somebody editing the database.
 */
function AssignCard({
  invoice,
  products,
  storekeepers,
  locations,
}: {
  invoice: AssignableInvoice;
  products: CatalogueProduct[];
  storekeepers: StorekeeperOption[];
  locations: InventoryLocation[];
}) {
  const t = useTranslations();
  const [storekeeperId, setStorekeeperId] = useState("");
  const [sourceLocation, setSourceLocation] = useState(locations[0]?.code ?? "");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newKey);

  const action = useGuardedAction<"assign", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setQuantities({});
        setKey(newKey());
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
            <Label htmlFor={`keeper-${invoice.invoiceId}`}>
              {t("settlement.dispatch.storekeeper")}
            </Label>
            {/* From the registered list only — a select, never free text (design.md §7.10). */}
            <Select
              id={`keeper-${invoice.invoiceId}`}
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
            <Label htmlFor={`from-${invoice.invoiceId}`}>
              {t("settlement.dispatch.sourceLocation")}
            </Label>
            <Select
              id={`from-${invoice.invoiceId}`}
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

          {invoice.lines.map((line) => {
            const product = products.find((candidate) => candidate.id === line.productId);
            return (
              <Field key={line.allocationId}>
                <Label htmlFor={`qty-${line.allocationId}`}>
                  {product ? product.name : line.productId}
                </Label>
                <Input
                  id={`qty-${line.allocationId}`}
                  type="text"
                  inputMode="numeric"
                  className="fv-numeric"
                  value={quantities[line.allocationId] ?? String(line.assignableQuantity)}
                  disabled={pending}
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [line.allocationId]: event.target.value,
                    }))
                  }
                />
                {/* A partial release is allowed and the remainder stays committed (§12), so the
                    figure that is still ASSIGNABLE is stated rather than assumed — what is owed,
                    less whatever an in-progress dispatch already claims. */}
                <Help>
                  {t("settlement.dispatch.stillOwed", { count: line.assignableQuantity })}
                </Help>
              </Field>
            );
          })}
        </div>

        <div>
          <Button
            type="button"
            data-testid={`assign-${invoice.invoiceId}`}
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("invoiceId", invoice.invoiceId);
              data.set("storekeeperId", storekeeperId);
              data.set("sourceLocation", sourceLocation);
              data.set(
                "lines",
                JSON.stringify(
                  invoice.lines.map((line) => ({
                    allocationId: line.allocationId,
                    quantity:
                      quantities[line.allocationId] ?? String(line.assignableQuantity),
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
