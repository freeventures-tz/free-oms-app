"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveAdjustmentAction,
  enterAdjustmentAction,
  rejectAdjustmentAction,
  type InventoryActionState,
} from "@/app/(app)/inventory/actions";
import { DecisionControls } from "@/components/inventory/decision-controls";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import type { InventoryLocation, StockAdjustment, StockBalance } from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

export function AdjustmentBoard({
  adjustments,
  products,
  units,
  locations,
  balances,
  canEnter,
  canDecide,
  idempotencyKey,
}: {
  adjustments: StockAdjustment[];
  products: CatalogueProduct[];
  units: Unit[];
  locations: InventoryLocation[];
  balances: StockBalance[];
  canEnter: boolean;
  canDecide: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations("inventory.adjustments");

  const pending = adjustments.filter((entry) => entry.approval.status === "pending");
  const settled = adjustments.filter((entry) => entry.approval.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {canEnter ? (
        <NewAdjustmentForm
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
          pending.map((adjustment) => (
            <AdjustmentCard
              key={adjustment.id}
              adjustment={adjustment}
              products={products}
              units={units}
              canDecide={canDecide}
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
          settled.map((adjustment) => (
            <AdjustmentCard
              key={adjustment.id}
              adjustment={adjustment}
              products={products}
              units={units}
              canDecide={false}
            />
          ))
        )}
      </section>
    </div>
  );
}

function AdjustmentCard({
  adjustment,
  products,
  units,
  canDecide,
}: {
  adjustment: StockAdjustment;
  products: CatalogueProduct[];
  units: Unit[];
  canDecide: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const product = products.find((candidate) => candidate.id === adjustment.productId);
  const unit = product ? units.find((candidate) => candidate.code === product.unitCode) : undefined;
  const identity = product
    ? [product.name, product.specification, product.unitContent].filter(Boolean).join(" ")
    : adjustment.productId;

  return (
    <Card role="article" aria-label={identity}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{identity}</p>
          <p className="fv-numeric text-sm">
            {adjustment.quantityDelta > 0 ? "+" : ""}
            {adjustment.quantityDelta}
            {unit ? ` ${unitLabel(unit, locale)}` : ""}{" "}
            <span className="text-muted-foreground">
              {t(`inventory.stock.locations.${adjustment.locationCode}`)}
            </span>
          </p>
          {/* The explanation IS the document for this movement, so it is shown, not tucked away. */}
          <p className="text-xs text-muted-foreground">{adjustment.reason}</p>
          <p className="text-xs text-muted-foreground">
            {t("inventory.adjustments.enteredBy", { who: adjustment.enteredByName })}
          </p>
        </div>

        <div className="shrink-0">
          <DecisionControls
            entityId={adjustment.id}
            approval={adjustment.approval}
            canDecide={canDecide}
            approveAction={approveAdjustmentAction}
            rejectAction={rejectAdjustmentAction}
            approveLabel={t("inventory.adjustments.approve")}
            approveConsequence={t("inventory.adjustments.approveConsequence")}
          />
        </div>
      </div>
    </Card>
  );
}

function NewAdjustmentForm({
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
  const [productId, setProductId] = useState("");
  const [locationCode, setLocationCode] = useState(locations[0]?.code ?? "");
  const [quantityDelta, setQuantityDelta] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);

  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));
  const balanceAt = new Map(
    balances.map((balance) => [`${balance.productId}:${balance.locationCode}`, balance.quantity]),
  );

  const action = useGuardedAction<"save", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setProductId("");
        setQuantityDelta("");
        setReason("");
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (!open) {
    return (
      <div>
        <Button type="button" id="newAdjustment" onClick={() => setOpen(true)}>
          {t("inventory.adjustments.new")}
        </Button>
      </div>
    );
  }

  const current = productId ? (balanceAt.get(`${productId}:${locationCode}`) ?? 0) : null;
  const product = products.find((candidate) => candidate.id === productId);
  const unit =
    product && unitsByCode.has(product.unitCode)
      ? unitLabel(unitsByCode.get(product.unitCode)!, locale)
      : null;

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("inventory.adjustments.newHeading")}</h2>
      <Help className="mt-1">{t("inventory.adjustments.noStockYet")}</Help>

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
            <Label htmlFor="adjust-product">{t("inventory.adjustments.product")}</Label>
            <Select
              id="adjust-product"
              value={productId}
              disabled={pending}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">{t("inventory.adjustments.chooseProduct")}</option>
              {products.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {[candidate.name, candidate.specification, candidate.unitContent]
                    .filter(Boolean)
                    .join(" · ")}
                </option>
              ))}
            </Select>
            <FieldError>
              {result.fieldErrors?.productId ? t(result.fieldErrors.productId) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="adjust-location">{t("inventory.adjustments.location")}</Label>
            <Select
              id="adjust-location"
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
          </Field>
        </div>

        {current !== null ? (
          <p className="fv-numeric text-sm text-muted-foreground" data-testid="adjust-current">
            {t("inventory.adjustments.currently", {
              count: current,
              unit: unit ?? "",
            })}
          </p>
        ) : null}

        <Field>
          <Label htmlFor="adjust-delta">{t("inventory.adjustments.delta")}</Label>
          <Input
            id="adjust-delta"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="fv-numeric"
            value={quantityDelta}
            disabled={pending}
            onChange={(event) => setQuantityDelta(event.target.value)}
          />
          <Help>{t("inventory.adjustments.deltaHelp")}</Help>
          <FieldError>
            {result.fieldErrors?.quantityDelta ? t(result.fieldErrors.quantityDelta) : null}
          </FieldError>
        </Field>

        <Field>
          <Label htmlFor="adjust-reason">{t("inventory.adjustments.reason")}</Label>
          <Input
            id="adjust-reason"
            type="text"
            autoComplete="off"
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
          />
          <Help>{t("inventory.adjustments.reasonHelp")}</Help>
          <FieldError>
            {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
          </FieldError>
        </Field>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="submitAdjustment"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("productId", productId);
              data.set("locationCode", locationCode);
              data.set("quantityDelta", quantityDelta);
              data.set("reason", reason);
              data.set("idempotencyKey", idempotencyKey);
              action.run("save", enterAdjustmentAction, data);
            }}
          >
            {t("inventory.adjustments.submit")}
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
