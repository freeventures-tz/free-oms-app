"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { recordOpeningStockAction, type InventoryActionState } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label, Select } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import type { InventoryLocation, LedgerEntry, StockBalance } from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * Stock per location, as cards on every tier (design.md §3.5, §7.13).
 *
 * A table would win on a desktop and lose on the phone this is mostly used from, and the
 * information per product — a name, a counting unit, a quantity — fits a card comfortably at every
 * width. Each card expands into the movements behind its number, which is the traceability
 * principle made visible: every quantity can be walked back to the document that justifies it.
 */
export function StockBoard({
  locations,
  balances,
  curing,
  movements,
  products,
  units,
  openingStockKeys,
  canRecordOpeningStock,
  idempotencyKey,
}: {
  locations: InventoryLocation[];
  balances: StockBalance[];
  /** Bricks inside their curing period: physically here, and sellable by nobody (§8, AC-44). */
  curing: StockBalance[];
  movements: LedgerEntry[];
  products: CatalogueProduct[];
  units: Unit[];
  openingStockKeys: string[];
  canRecordOpeningStock: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations("inventory.stock");
  const locale = useLocale();

  const [activeLocation, setActiveLocation] = useState(locations[0]?.code ?? "");

  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const entered = new Set(openingStockKeys);

  const balanceFor = new Map(
    balances.map((balance) => [`${balance.productId}:${balance.locationCode}`, balance]),
  );

  const curingFor = new Map(
    curing.map((balance) => [`${balance.productId}:${balance.locationCode}`, balance]),
  );

  // Every product is listed at the active location, including the ones holding none. A product
  // missing from the list because its balance is zero would be indistinguishable from a product
  // that does not exist, and a Manager looking for cement needs to be told there is none rather
  // than left to wonder whether they mistyped.
  const rows = products
    .filter((product) => product.isActive)
    .map((product) => ({
      product,
      balance: balanceFor.get(`${product.id}:${activeLocation}`) ?? null,
      // Kept apart from the balance on purpose: §8 makes Available and Curing two states, and
      // one number covering both would be the merge the document forbids.
      curing: curingFor.get(`${product.id}:${activeLocation}`)?.quantity ?? 0,
      openingStockEntered: entered.has(`${product.id}:${activeLocation}`),
    }));

  const total = rows.reduce((sum, row) => sum + (row.balance?.quantity ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Location tabs. On a phone they scroll inside their own container rather than making the
          page scroll sideways (design.md §3.5). */}
      <div className="-mx-1 overflow-x-auto px-1">
        <div role="tablist" aria-label={t("locationTabs")} className="flex gap-2">
          {locations.map((location) => (
            <button
              key={location.code}
              type="button"
              role="tab"
              aria-selected={location.code === activeLocation}
              data-testid={`location-tab-${location.code}`}
              onClick={() => setActiveLocation(location.code)}
              className={
                location.code === activeLocation
                  ? "min-h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground xl:min-h-10"
                  : "min-h-11 shrink-0 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground xl:min-h-10"
              }
            >
              {t(`locations.${location.code}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("physicalOnly")} · {t("totalUnits", { count: total })}
      </p>

      {canRecordOpeningStock ? (
        <OpeningStockForm
          products={products.filter((product) => product.isActive)}
          units={units}
          locationCode={activeLocation}
          alreadyEntered={entered}
          initialKey={idempotencyKey}
        />
      ) : null}

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <StockRow
            key={row.product.id}
            product={row.product}
            unitName={
              unitsByCode.has(row.product.unitCode)
                ? unitLabel(unitsByCode.get(row.product.unitCode)!, locale)
                : row.product.unitCode
            }
            quantity={row.balance?.quantity ?? 0}
            curing={row.curing}
            openingStockEntered={row.openingStockEntered}
            movements={movements.filter(
              (movement) =>
                movement.productId === row.product.id &&
                movement.locationCode === activeLocation,
            )}
            productsById={productsById}
          />
        ))}
      </div>
    </div>
  );
}

function StockRow({
  product,
  unitName,
  quantity,
  curing,
  openingStockEntered,
  movements,
}: {
  product: CatalogueProduct;
  unitName: string;
  quantity: number;
  curing: number;
  openingStockEntered: boolean;
  movements: LedgerEntry[];
  productsById: Map<string, CatalogueProduct>;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);

  const identity = [product.name, product.specification, product.unitContent]
    .filter(Boolean)
    .join(" ");

  return (
    <Card role="article" aria-label={identity}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {product.name}
            {product.specification ? (
              <span className="fv-identifier ml-2 text-sm text-muted-foreground">
                {product.specification}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("catalogue.unitLabel")}: {unitName}
          </p>
          {product.unitContent ? (
            <p className="text-xs text-muted-foreground">
              {t("catalogue.contentLabel")}: {product.unitContent}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col items-start gap-2 md:items-end">
          <p
            className="fv-numeric text-lg font-semibold"
            data-testid="stock-quantity"
            data-quantity={quantity}
          >
            {t("inventory.stock.quantityWithUnit", { count: quantity, unit: unitName })}
          </p>

          {/* Physically here and sellable by nobody (§8, §11.4, AC-44). Shown as its OWN figure,
              never added to the one above: this page says it shows what is at the location, and
              leaving curing bricks out of it would make that sentence false the moment a batch
              was approved — while adding them in would offer twenty bricks for sale that no
              Manager has inspected. */}
          {curing > 0 ? (
            <p
              className="fv-numeric text-xs text-muted-foreground"
              data-testid="stock-curing"
              data-quantity={curing}
            >
              {t("inventory.stock.curingWithUnit", { count: curing, unit: unitName })}
            </p>
          ) : null}

          {/* "Nobody has counted this yet" and "we counted, and there is none" are different
              answers and must not look alike. Without an opening-stock entry a zero is the first,
              and saying so is the difference between a gap and a fact. */}
          {quantity === 0 && !openingStockEntered ? (
            <StatusChip tone="attention">{t("inventory.stock.notCounted")}</StatusChip>
          ) : null}

          {movements.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="small"
              aria-expanded={expanded}
              data-testid={`movements-${product.id}`}
              onClick={() => setExpanded((value) => !value)}
            >
              {t("inventory.stock.movements", { count: movements.length })}
            </Button>
          ) : null}
        </div>
      </div>

      {expanded && movements.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {movements.map((movement) => (
            <li key={movement.id} className="flex flex-col gap-0.5 text-xs">
              <span className="flex items-center gap-2">
                <span className="fv-numeric font-medium">
                  {movement.quantityDelta > 0 ? "+" : ""}
                  {movement.quantityDelta}
                </span>
                <span>{t(`inventory.movementKind.${movement.movementKind}`)}</span>
              </span>
              {/* Cause, actor and authorisation on every movement — the traceability principle of
                  product.md §1, and what AC-82 asks the ledger to prove. */}
              <span className="text-muted-foreground">
                {t("inventory.stock.movementBy", {
                  actor: movement.actorName,
                  approver: movement.approverName,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * Opening stock — Director only, once per product and location.
 *
 * The product picker offers only pairs that have NOT been entered yet, because there is no second
 * entry: correcting one is a manual stock adjustment (product.md §4.1), which has its own screen
 * and its own Director approval. Offering a product that would be refused would be a control that
 * exists to say no.
 */
function OpeningStockForm({
  products,
  units,
  locationCode,
  alreadyEntered,
  initialKey,
}: {
  products: CatalogueProduct[];
  units: Unit[];
  locationCode: string;
  alreadyEntered: Set<string>;
  initialKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);

  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));
  const available = products.filter(
    (product) => !alreadyEntered.has(`${product.id}:${locationCode}`),
  );

  const action = useGuardedAction<"save", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setProductId("");
        setQuantity("");
        setNote("");
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (available.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("inventory.openingStock.allEntered")}</p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {t("inventory.openingStock.open")}
        </Button>
      </div>
    );
  }

  const selected = products.find((product) => product.id === productId) ?? null;
  const selectedUnit =
    selected && unitsByCode.has(selected.unitCode)
      ? unitLabel(unitsByCode.get(selected.unitCode)!, locale)
      : null;

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("inventory.openingStock.heading")}</h2>
      <Help className="mt-1">{t("inventory.openingStock.help")}</Help>

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

        <Field>
          <Label htmlFor="opening-product">{t("inventory.openingStock.product")}</Label>
          <Select
            id="opening-product"
            value={productId}
            disabled={pending}
            onChange={(event) => setProductId(event.target.value)}
          >
            <option value="">{t("inventory.openingStock.choose")}</option>
            {available.map((product) => (
              <option key={product.id} value={product.id}>
                {[product.name, product.specification, product.unitContent]
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
          <Label htmlFor="opening-quantity">
            {selectedUnit
              ? t("inventory.openingStock.quantityIn", { unit: selectedUnit })
              : t("inventory.openingStock.quantity")}
          </Label>
          <Input
            id="opening-quantity"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="fv-numeric"
            value={quantity}
            disabled={pending}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <Help>{t("inventory.openingStock.quantityHelp")}</Help>
          <FieldError>
            {result.fieldErrors?.quantity ? t(result.fieldErrors.quantity) : null}
          </FieldError>
        </Field>

        <Field>
          <Label htmlFor="opening-note">{t("inventory.openingStock.note")}</Label>
          <Input
            id="opening-note"
            type="text"
            autoComplete="off"
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
          <Help>{t("inventory.openingStock.noteHelp")}</Help>
        </Field>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="saveOpeningStock"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("productId", productId);
              data.set("locationCode", locationCode);
              data.set("quantity", quantity);
              data.set("note", note);
              data.set("idempotencyKey", idempotencyKey);
              action.run("save", recordOpeningStockAction, data);
            }}
          >
            {t("inventory.openingStock.submit")}
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
