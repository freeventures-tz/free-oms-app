"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveTransferAction,
  enterTransferAction,
  rejectTransferAction,
  type InventoryActionState,
} from "@/app/(app)/inventory/actions";
import { DecisionControls } from "@/components/inventory/decision-controls";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import type { InventoryLocation, StockBalance, StockTransfer } from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

type DraftLine = { key: string; productId: string; quantity: string };

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: "", quantity: "" };
}

export function TransferBoard({
  transfers,
  products,
  units,
  locations,
  balances,
  canManage,
  idempotencyKey,
}: {
  transfers: StockTransfer[];
  products: CatalogueProduct[];
  units: Unit[];
  locations: InventoryLocation[];
  balances: StockBalance[];
  canManage: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations("inventory.transfers");

  const pending = transfers.filter((transfer) => transfer.approval.status === "pending");
  const settled = transfers.filter((transfer) => transfer.approval.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {canManage ? (
        <NewTransferForm
          products={products}
          units={units}
          locations={locations}
          balances={balances}
          initialKey={idempotencyKey}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("pendingHeading", { count: pending.length })}</h2>
        {pending.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("noPending")}</p>
          </Card>
        ) : (
          pending.map((transfer) => (
            <TransferCard
              key={transfer.id}
              transfer={transfer}
              products={products}
              units={units}
              canApprove={canManage}
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
          settled.map((transfer) => (
            <TransferCard
              key={transfer.id}
              transfer={transfer}
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

function TransferCard({
  transfer,
  products,
  units,
  canApprove,
}: {
  transfer: StockTransfer;
  products: CatalogueProduct[];
  units: Unit[];
  canApprove: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const productsById = new Map(products.map((product) => [product.id, product]));
  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));

  return (
    <Card
      role="article"
      aria-label={`${t(`inventory.stock.locations.${transfer.fromLocation}`)} → ${t(
        `inventory.stock.locations.${transfer.toLocation}`,
      )}`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            {/* Direction with a visible indicator, not two names the reader has to order
                themselves (design.md §7.15). */}
            <p className="font-medium">
              {t(`inventory.stock.locations.${transfer.fromLocation}`)}
              <span aria-hidden className="mx-2">
                →
              </span>
              {t(`inventory.stock.locations.${transfer.toLocation}`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("inventory.transfers.enteredBy", { who: transfer.enteredByName })}
            </p>
            {transfer.note ? (
              <p className="text-xs text-muted-foreground">{transfer.note}</p>
            ) : null}
          </div>

          <div className="shrink-0">
            <DecisionControls
              entityId={transfer.id}
              approval={transfer.approval}
              canDecide={canApprove}
              approveAction={approveTransferAction}
              rejectAction={rejectTransferAction}
              approveLabel={t("inventory.transfers.approve")}
              approveConsequence={t("inventory.transfers.approveConsequence")}
            />
          </div>
        </div>

        <ul className="flex flex-col gap-1 border-t border-border pt-3 text-xs">
          {transfer.lines.map((line) => {
            const product = productsById.get(line.productId);
            const unit = product ? unitsByCode.get(product.unitCode) : undefined;
            return (
              <li key={line.id} className="flex items-center justify-between gap-3">
                <span>
                  {product
                    ? [product.name, product.specification, product.unitContent]
                        .filter(Boolean)
                        .join(" · ")
                    : line.productId}
                </span>
                <span className="fv-numeric font-medium">
                  {unit
                    ? t("inventory.stock.quantityWithUnit", {
                        count: line.quantity,
                        unit: unitLabel(unit, locale),
                      })
                    : line.quantity}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

function NewTransferForm({
  products,
  units,
  locations,
  balances,
  initialKey,
}: {
  products: CatalogueProduct[];
  units: Unit[];
  locations: InventoryLocation[];
  balances: StockBalance[];
  initialKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [fromLocation, setFromLocation] = useState(locations[0]?.code ?? "");
  const [toLocation, setToLocation] = useState(locations[1]?.code ?? "");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);

  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));
  const balanceAt = new Map(
    balances.map((balance) => [`${balance.productId}:${balance.locationCode}`, balance.quantity]),
  );

  const action = useGuardedAction<"save", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setNote("");
        setLines([emptyLine()]);
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (!open) {
    return (
      <div>
        <Button type="button" id="newTransfer" onClick={() => setOpen(true)}>
          {t("inventory.transfers.new")}
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
      <h2 className="text-sm font-semibold">{t("inventory.transfers.newHeading")}</h2>
      <Help className="mt-1">{t("inventory.transfers.noStockYet")}</Help>

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
            <Label htmlFor="transfer-from">{t("inventory.transfers.from")}</Label>
            <Select
              id="transfer-from"
              value={fromLocation}
              disabled={pending}
              onChange={(event) => setFromLocation(event.target.value)}
            >
              {locations.map((location) => (
                <option key={location.code} value={location.code}>
                  {t(`inventory.stock.locations.${location.code}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field>
            <Label htmlFor="transfer-to">{t("inventory.transfers.to")}</Label>
            <Select
              id="transfer-to"
              value={toLocation}
              disabled={pending}
              onChange={(event) => setToLocation(event.target.value)}
            >
              {locations.map((location) => (
                <option key={location.code} value={location.code}>
                  {t(`inventory.stock.locations.${location.code}`)}
                </option>
              ))}
            </Select>
            <FieldError>
              {result.fieldErrors?.toLocation ? t(result.fieldErrors.toLocation) : null}
            </FieldError>
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("inventory.transfers.lines")}</h3>
          <FieldError>{result.fieldErrors?.lines ? t(result.fieldErrors.lines) : null}</FieldError>

          {lines.map((line, index) => {
            const product = products.find((candidate) => candidate.id === line.productId);
            const unit =
              product && unitsByCode.has(product.unitCode)
                ? unitLabel(unitsByCode.get(product.unitCode)!, locale)
                : null;
            const atSource = line.productId
              ? (balanceAt.get(`${line.productId}:${fromLocation}`) ?? 0)
              : null;

            return (
              <div
                key={line.key}
                className="flex flex-col gap-3 rounded-sm border border-border p-3"
              >
                <Field>
                  <Label htmlFor={`transfer-product-${line.key}`}>
                    {t("inventory.transfers.product")}
                  </Label>
                  <Select
                    id={`transfer-product-${line.key}`}
                    value={line.productId}
                    disabled={pending}
                    onChange={(event) => updateLine(line.key, { productId: event.target.value })}
                  >
                    <option value="">{t("inventory.transfers.chooseProduct")}</option>
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

                <Field>
                  <Label htmlFor={`transfer-quantity-${line.key}`}>
                    {unit
                      ? t("inventory.transfers.quantityIn", { unit })
                      : t("inventory.transfers.quantity")}
                  </Label>
                  <Input
                    id={`transfer-quantity-${line.key}`}
                    type="text"
                    inputMode="numeric"
                    className="fv-numeric"
                    value={line.quantity}
                    disabled={pending}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                  />
                  {/* The limit shown BEFORE submission, per design.md §7.15. It is a guide, not the
                      control: stock can move between now and approval, so the binding check is the
                      one the database makes at the moment the balances change. */}
                  {atSource !== null ? (
                    <Help data-testid={`transfer-available-${index}`}>
                      {t("inventory.transfers.availableAtSource", {
                        count: atSource,
                        location: t(`inventory.stock.locations.${fromLocation}`),
                      })}
                    </Help>
                  ) : null}
                  <FieldError>
                    {result.fieldErrors?.[`lines.${index}.quantity`]
                      ? t(result.fieldErrors[`lines.${index}.quantity`])
                      : null}
                  </FieldError>
                </Field>

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
                      {t("inventory.transfers.removeLine")}
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
              id="addTransferLine"
              disabled={pending}
              onClick={() => setLines((current) => [...current, emptyLine()])}
            >
              {t("inventory.transfers.addLine")}
            </Button>
          </div>
        </div>

        <Field>
          <Label htmlFor="transfer-note">{t("inventory.transfers.note")}</Label>
          <Input
            id="transfer-note"
            type="text"
            autoComplete="off"
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
          <Help>{t("inventory.transfers.noteHelp")}</Help>
        </Field>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="submitTransfer"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("fromLocation", fromLocation);
              data.set("toLocation", toLocation);
              data.set("note", note);
              data.set(
                "lines",
                JSON.stringify(
                  lines.map((line) => ({
                    productId: line.productId,
                    quantity: line.quantity,
                  })),
                ),
              );
              data.set("idempotencyKey", idempotencyKey);
              action.run("save", enterTransferAction, data);
            }}
          >
            {t("inventory.transfers.submit")}
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
