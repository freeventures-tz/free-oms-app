"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveReceiptAction,
  enterReceiptAction,
  rejectReceiptAction,
  type InventoryActionState,
} from "@/app/(app)/inventory/actions";
import { DecisionControls } from "@/components/inventory/decision-controls";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import type {
  ApprovalState,
  InventoryLocation,
  StockReceipt,
  Supplier,
} from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * A timestamp in the business's own time zone, in the reader's language.
 *
 * `Africa/Dar_es_Salaam` and not the browser's zone, for the same reason the delivery date is
 * decided on the server: an accountability record has to read the same to everybody who opens it.
 *
 * The formatter is built once per locale and kept. Constructing an `Intl.DateTimeFormat` is the
 * expensive half of formatting a date — it resolves locale data every time — and a receiving board
 * renders two timestamps per card for up to two hundred cards, so building one per timestamp is
 * hundreds of resolutions to produce at most two distinct formatters.
 */
const STAMP_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function stampFormatter(locale: string): Intl.DateTimeFormat {
  const tag = locale === "sw" ? "sw-TZ" : "en-GB";
  let formatter = STAMP_FORMATTERS.get(tag);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(tag, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Dar_es_Salaam",
    });
    STAMP_FORMATTERS.set(tag, formatter);
  }
  return formatter;
}

function formatStamp(iso: string, locale: string): string {
  return stampFormatter(locale).format(new Date(iso));
}

/** A line as the person is typing it — strings, because a half-typed number is not a number. */
type DraftLine = {
  key: string;
  productId: string;
  expected: string;
  received: string;
  damaged: string;
  damageNote: string;
};

function emptyLine(): DraftLine {
  return {
    key: crypto.randomUUID(),
    productId: "",
    expected: "",
    received: "",
    damaged: "0",
    damageNote: "",
  };
}

/**
 * Short and excess, worked out while the person types.
 *
 * The DATABASE owns these values — they are generated columns, and product.md §5.2 forbids asking
 * anyone to type them. This is the same arithmetic shown live so the person can see what they are
 * recording before they submit it (design.md §7.14). It is never sent: the command takes expected,
 * received and damaged, and computes the rest itself.
 */
function derive(line: DraftLine) {
  const expected = Number.parseInt(line.expected, 10);
  const received = Number.parseInt(line.received, 10);
  const damaged = Number.parseInt(line.damaged, 10);

  if (!Number.isFinite(expected) || !Number.isFinite(received)) return null;

  const safeDamaged = Number.isFinite(damaged) ? damaged : 0;

  return {
    short: Math.max(expected - received, 0),
    excess: Math.max(received - expected, 0),
    accepted: received - safeDamaged,
  };
}

export function ReceivingBoard({
  receipts,
  suppliers,
  products,
  units,
  locations,
  canEnter,
  canApprove,
  idempotencyKey,
  today,
}: {
  receipts: StockReceipt[];
  suppliers: Supplier[];
  products: CatalogueProduct[];
  units: Unit[];
  locations: InventoryLocation[];
  canEnter: boolean;
  canApprove: boolean;
  idempotencyKey: string;
  /** Today in `Africa/Dar_es_Salaam`, as `YYYY-MM-DD`, decided on the server. */
  today: string;
}) {
  const t = useTranslations("inventory.receiving");

  const pending = receipts.filter((receipt) => receipt.approval.status === "pending");
  const settled = receipts.filter((receipt) => receipt.approval.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {canEnter ? (
        <NewReceiptForm
          suppliers={suppliers}
          products={products}
          units={units}
          locations={locations}
          initialKey={idempotencyKey}
          today={today}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("pendingHeading", { count: pending.length })}</h2>
        {pending.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("noPending")}</p>
          </Card>
        ) : (
          pending.map((receipt) => (
            <ReceiptCard
              key={receipt.id}
              receipt={receipt}
              products={products}
              units={units}
              canApprove={canApprove}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("settledHeading")}</h2>
        {settled.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("noSettled")}</p>
          </Card>
        ) : (
          settled.map((receipt) => (
            <ReceiptCard
              key={receipt.id}
              receipt={receipt}
              products={products}
              units={units}
              canApprove={false}
            />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * What was decided about a receipt, by whom, in what role, and when (product.md §4.2, §4.3).
 *
 * Rendered only once a decision exists. Every part is read from the record rather than assumed:
 * an approval and a rejection are different outcomes with different consequences, and a decision
 * missing its decider is shown as the plain outcome rather than as a sentence with a blank in it.
 */
function DecisionRecord({
  approval,
  receiptId,
}: {
  approval: ApprovalState;
  receiptId: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const approved = approval.status === "approved";
  // Everything that is neither approved nor pending — rejected, cancelled, expired, superseded —
  // is a settled decision in which nothing was approved, and reads as one (§4.3).
  const attributed = approval.decidedByName && approval.decidedRole;

  return (
    <div
      className="flex flex-col items-start gap-1"
      data-testid={`decision-record-${receiptId}`}
      data-outcome={approved ? "approved" : "rejected"}
      // The machine-readable instant beside the rendered one, so a reader in either language and a
      // test in neither are looking at the same fact.
      data-decided-at={approval.decidedAt ?? undefined}
      data-decided-role={approval.decidedRole ?? undefined}
    >
      <StatusChip tone={approved ? "success" : "danger"}>
        {attributed
          ? t(approved ? "inventory.status.approvedByRole" : "inventory.status.rejectedByRole", {
              who: approval.decidedByName!,
              role: t(`admin.roles.${approval.decidedRole}`),
            })
          : t(approved ? "inventory.status.approved" : "inventory.status.rejected")}
      </StatusChip>

      {approval.decidedAt ? (
        <p className="text-xs text-muted-foreground">
          {t("inventory.status.decidedAt", {
            when: formatStamp(approval.decidedAt, locale),
          })}
        </p>
      ) : null}

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

function ReceiptCard({
  receipt,
  products,
  units,
  canApprove,
}: {
  receipt: StockReceipt;
  products: CatalogueProduct[];
  units: Unit[];
  canApprove: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const productsById = new Map(products.map((product) => [product.id, product]));
  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));

  const totalShort = receipt.lines.reduce((sum, line) => sum + line.shortQuantity, 0);
  const totalDamaged = receipt.lines.reduce((sum, line) => sum + line.damagedQuantity, 0);

  return (
    <Card role="article" aria-label={`${receipt.supplierName} ${receipt.deliveryNoteRef}`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <p className="font-medium">{receipt.supplierName}</p>
            <p className="text-xs text-muted-foreground">
              {t("inventory.receiving.deliveryNote")}:{" "}
              <span className="fv-identifier">{receipt.deliveryNoteRef}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`inventory.stock.locations.${receipt.locationCode}`)} · {receipt.deliveryDate}
            </p>
            {/* Entered by and decided by are shown as DISTINCT facts, each with its own person,
                role and moment (design.md §7.14, product.md §4.2). Entry is never evidence that
                anything was approved, so it carries its own timestamp even while nobody has
                decided yet. */}
            <p className="text-xs text-muted-foreground" data-testid={`entry-record-${receipt.id}`}>
              {t("inventory.receiving.enteredBy", {
                who: receipt.enteredByName,
                role: t(`admin.roles.${receipt.enteredRole}`),
              })}{" "}
              ·{" "}
              <time dateTime={receipt.enteredAt}>{formatStamp(receipt.enteredAt, locale)}</time>
            </p>
          </div>

          <div className="shrink-0">
            {/* A settled receipt is a RECORD, not a control. `DecisionControls` renders the two
                buttons and the pending state; once a decision exists the card owns the answer,
                which is why the whole record — who, in what role, and when — is written here and
                the shared badge is not also rendered. Two elements both reading "Approved by" would
                say the same fact twice and agree only by accident. */}
            {receipt.approval.status === "pending" ? (
              <DecisionControls
                entityId={receipt.id}
                approval={receipt.approval}
                canDecide={canApprove}
                approveAction={approveReceiptAction}
                rejectAction={rejectReceiptAction}
                approveLabel={t("inventory.receiving.approve")}
                approveConsequence={t("inventory.receiving.approveConsequence")}
              />
            ) : (
              <DecisionRecord approval={receipt.approval} receiptId={receipt.id} />
            )}
          </div>
        </div>

        {/* The wide grid scrolls inside its own container; the page body never scrolls sideways
            (design.md §3.5). */}
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.product")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.expected")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.received")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.short")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.excess")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("inventory.receiving.damaged")}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t("inventory.receiving.accepted")}
                </th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line) => {
                const product = productsById.get(line.productId);
                const unit = product ? unitsByCode.get(product.unitCode) : undefined;
                return (
                  <tr key={line.id} className="border-t border-border">
                    <td className="py-2 pr-3">
                      {product
                        ? [product.name, product.specification].filter(Boolean).join(" ")
                        : line.productId}
                      {unit ? (
                        <span className="ml-1 text-muted-foreground">
                          ({unitLabel(unit, locale)})
                        </span>
                      ) : null}
                    </td>
                    <td className="fv-numeric py-2 pr-3">{line.expectedQuantity}</td>
                    <td className="fv-numeric py-2 pr-3">{line.receivedQuantity}</td>
                    <td className="fv-numeric py-2 pr-3">
                      {line.shortQuantity > 0 ? (
                        <span className="font-medium text-danger">{line.shortQuantity}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="fv-numeric py-2 pr-3">{line.excessQuantity}</td>
                    <td className="fv-numeric py-2 pr-3">{line.damagedQuantity}</td>
                    <td className="fv-numeric py-2 font-medium">{line.acceptedQuantity}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* A shortage is never rounded away, netted against an excess, or discarded (§9.1, AC-28).
            Saying it out loud on the card is what stops it being a number in a column nobody
            reads. */}
        {totalShort > 0 ? (
          <StatusChip tone="danger">
            {t("inventory.receiving.shortageRecorded", { count: totalShort })}
          </StatusChip>
        ) : null}
        {totalDamaged > 0 ? (
          <StatusChip tone="attention">
            {t("inventory.receiving.damagedRecorded", { count: totalDamaged })}
          </StatusChip>
        ) : null}
      </div>
    </Card>
  );
}

function NewReceiptForm({
  suppliers,
  products,
  units,
  locations,
  initialKey,
  today,
}: {
  suppliers: Supplier[];
  products: CatalogueProduct[];
  units: Unit[];
  locations: InventoryLocation[];
  initialKey: string;
  today: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [locationCode, setLocationCode] = useState(locations[0]?.code ?? "");
  // The business's today, not the device's. Computed on the server and handed down, so a phone set
  // to another zone cannot offer yesterday as today (lib/time/business-date.ts).
  const [deliveryDate, setDeliveryDate] = useState(today);
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);

  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));

  const action = useGuardedAction<"save", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      // Rotated only after a SUCCESS. A refusal leaves every value and the key exactly as they
      // were, so a corrected retry addresses the same intended receipt rather than becoming a
      // second one (design.md §12.7).
      if (outcome.successKey) {
        setSupplierId("");
        // The date the SERVER computed as this command succeeded, not the one this page was
        // rendered with. They differ when the form has been open across midnight in Dar es Salaam,
        // and the `today` prop is then a day stale — falling back to it only if the response
        // carried nothing, which no successful receipt does.
        setDeliveryDate(outcome.businessDate ?? today);
        setDeliveryNoteRef("");
        setLines([emptyLine()]);
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (suppliers.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("inventory.receiving.noSuppliers")}</p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div>
        <Button type="button" id="newReceipt" onClick={() => setOpen(true)}>
          {t("inventory.receiving.new")}
        </Button>
      </div>
    );
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("inventory.receiving.newHeading")}</h2>
      {/* Stated while the record is pending, not discovered afterwards (design.md §7.14). */}
      <Help className="mt-1">{t("inventory.receiving.noStockYet")}</Help>

      <div className="mt-4 flex flex-col gap-4">
        {result.error ? (
          <div className="flex flex-col gap-3">
            <FormError>{t(result.error)}</FormError>
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
            <Label htmlFor="receipt-supplier">{t("inventory.receiving.supplier")}</Label>
            <Select
              id="receipt-supplier"
              value={supplierId}
              disabled={pending}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">{t("inventory.receiving.chooseSupplier")}</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
            <FieldError>
              {result.fieldErrors?.supplierId ? t(result.fieldErrors.supplierId) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="receipt-location">{t("inventory.receiving.location")}</Label>
            <Select
              id="receipt-location"
              value={locationCode}
              disabled={pending}
              onChange={(event) => setLocationCode(event.target.value)}
            >
              {locations.map((location) => (
                <option key={location.code} value={location.code}>
                  {t(`inventory.stock.locations.${location.code}`)}
                </option>
              ))}
            </Select>
            <FieldError>
              {result.fieldErrors?.locationCode ? t(result.fieldErrors.locationCode) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="receipt-date">{t("inventory.receiving.deliveryDate")}</Label>
            <Input
              id="receipt-date"
              type="date"
              value={deliveryDate}
              disabled={pending}
              onChange={(event) => setDeliveryDate(event.target.value)}
            />
            <FieldError>
              {result.fieldErrors?.deliveryDate ? t(result.fieldErrors.deliveryDate) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="receipt-note-ref">{t("inventory.receiving.deliveryNote")}</Label>
            <Input
              id="receipt-note-ref"
              type="text"
              autoComplete="off"
              className="fv-identifier"
              value={deliveryNoteRef}
              disabled={pending}
              onChange={(event) => setDeliveryNoteRef(event.target.value)}
            />
            <Help>{t("inventory.receiving.deliveryNoteHelp")}</Help>
            <FieldError>
              {result.fieldErrors?.deliveryNoteRef ? t(result.fieldErrors.deliveryNoteRef) : null}
            </FieldError>
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("inventory.receiving.lines")}</h3>
          <FieldError>{result.fieldErrors?.lines ? t(result.fieldErrors.lines) : null}</FieldError>

          {lines.map((line, index) => {
            const derived = derive(line);
            const product = products.find((candidate) => candidate.id === line.productId);
            const unit =
              product && unitsByCode.has(product.unitCode)
                ? unitLabel(unitsByCode.get(product.unitCode)!, locale)
                : null;

            return (
              <div
                key={line.key}
                className="flex flex-col gap-3 rounded-sm border border-border p-3"
              >
                <Field>
                  <Label htmlFor={`line-product-${line.key}`}>
                    {t("inventory.receiving.product")}
                  </Label>
                  <Select
                    id={`line-product-${line.key}`}
                    value={line.productId}
                    disabled={pending}
                    onChange={(event) => updateLine(line.key, { productId: event.target.value })}
                  >
                    <option value="">{t("inventory.receiving.chooseProduct")}</option>
                    {products.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {[candidate.name, candidate.specification, candidate.unitContent]
                          .filter(Boolean)
                          .join(" · ")}
                      </option>
                    ))}
                  </Select>
                  <FieldError>
                    {result.fieldErrors?.[`lines.${index}.productId`]
                      ? t(result.fieldErrors[`lines.${index}.productId`])
                      : null}
                  </FieldError>
                </Field>

                <div className="grid gap-3 md:grid-cols-3">
                  <Field>
                    <Label htmlFor={`line-expected-${line.key}`}>
                      {unit
                        ? t("inventory.receiving.expectedIn", { unit })
                        : t("inventory.receiving.expected")}
                    </Label>
                    <Input
                      id={`line-expected-${line.key}`}
                      type="text"
                      inputMode="numeric"
                      className="fv-numeric"
                      value={line.expected}
                      disabled={pending}
                      onChange={(event) => updateLine(line.key, { expected: event.target.value })}
                    />
                    <FieldError>
                      {result.fieldErrors?.[`lines.${index}.expectedQuantity`]
                        ? t(result.fieldErrors[`lines.${index}.expectedQuantity`])
                        : null}
                    </FieldError>
                  </Field>

                  <Field>
                    <Label htmlFor={`line-received-${line.key}`}>
                      {t("inventory.receiving.received")}
                    </Label>
                    <Input
                      id={`line-received-${line.key}`}
                      type="text"
                      inputMode="numeric"
                      className="fv-numeric"
                      value={line.received}
                      disabled={pending}
                      onChange={(event) => updateLine(line.key, { received: event.target.value })}
                    />
                    <FieldError>
                      {result.fieldErrors?.[`lines.${index}.receivedQuantity`]
                        ? t(result.fieldErrors[`lines.${index}.receivedQuantity`])
                        : null}
                    </FieldError>
                  </Field>

                  <Field>
                    <Label htmlFor={`line-damaged-${line.key}`}>
                      {t("inventory.receiving.damaged")}
                    </Label>
                    <Input
                      id={`line-damaged-${line.key}`}
                      type="text"
                      inputMode="numeric"
                      className="fv-numeric"
                      value={line.damaged}
                      disabled={pending}
                      onChange={(event) => updateLine(line.key, { damaged: event.target.value })}
                    />
                    <FieldError>
                      {result.fieldErrors?.[`lines.${index}.damagedQuantity`]
                        ? t(result.fieldErrors[`lines.${index}.damagedQuantity`])
                        : null}
                    </FieldError>
                  </Field>
                </div>

                {/* Read-only, and there is no field to type them into. product.md §5.2 lists
                    supplier shortages and excesses among the values a user must never be asked
                    for, and the database computes them as generated columns. */}
                {derived ? (
                  <p
                    className="fv-numeric text-xs text-muted-foreground"
                    data-testid={`line-derived-${index}`}
                  >
                    {t("inventory.receiving.derived", {
                      short: derived.short,
                      excess: derived.excess,
                      accepted: derived.accepted,
                    })}
                  </p>
                ) : null}

                {line.damaged !== "" && line.damaged !== "0" ? (
                  <Field>
                    <Label htmlFor={`line-damage-note-${line.key}`}>
                      {t("inventory.receiving.damageNote")}
                    </Label>
                    <Input
                      id={`line-damage-note-${line.key}`}
                      type="text"
                      autoComplete="off"
                      value={line.damageNote}
                      disabled={pending}
                      onChange={(event) =>
                        updateLine(line.key, { damageNote: event.target.value })
                      }
                    />
                    <Help>{t("inventory.receiving.damageNoteHelp")}</Help>
                  </Field>
                ) : null}

                {lines.length > 1 ? (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={pending}
                      onClick={() =>
                        setLines((current) => current.filter((item) => item.key !== line.key))
                      }
                    >
                      {t("inventory.receiving.removeLine")}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}

          <div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              id="addLine"
              disabled={pending}
              onClick={() => setLines((current) => [...current, emptyLine()])}
            >
              {t("inventory.receiving.addLine")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="submitReceipt"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("supplierId", supplierId);
              data.set("locationCode", locationCode);
              data.set("deliveryDate", deliveryDate);
              data.set("deliveryNoteRef", deliveryNoteRef);
              data.set(
                "lines",
                JSON.stringify(
                  lines.map((line) => ({
                    productId: line.productId,
                    expectedQuantity: line.expected,
                    receivedQuantity: line.received,
                    damagedQuantity: line.damaged === "" ? "0" : line.damaged,
                    damageNote: line.damageNote,
                  })),
                ),
              );
              data.set("idempotencyKey", idempotencyKey);
              action.run("save", enterReceiptAction, data);
            }}
          >
            {t("inventory.receiving.submit")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
