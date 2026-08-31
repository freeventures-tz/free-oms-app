"use client";

import { Minus, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, Help, Input, Label } from "@/components/ui/field";
import { StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import { formatTzs } from "@/lib/money";
import type { Availability } from "@/lib/sales/sales";
import { cn } from "@/lib/utils";

/**
 * The order line editor, shared by Create New Order and by revising a quotation.
 *
 * design.md §7.4 and §10.1 govern the two controls here, and both are about typing as little as
 * possible (product.md §5):
 *
 *   PRODUCT — search with typeahead, results as selectable cards. Not a dropdown: a `<select>` of
 *   twenty-one products is a scroll on a phone, and it hides the price and what is left to sell
 *   until after the choice is made.
 *
 *   QUANTITY — a stepper, plus numeric entry. §14.1 says shortcut chips are configured by a
 *   Director per product and that the interface MUST NOT SHIP INVENTED DEFAULTS. No product carries
 *   configured shortcuts in this release and there is no store for "recently used", so there are no
 *   chips at all — a guessed 10/20/50 row would be exactly the invention that rule forbids.
 */

export type DraftLine = { key: string; productId: string; quantity: string };

export function emptyDraft(): DraftLine[] {
  return [];
}

export function draftFrom(lines: { productId: string; quantity: number }[]): DraftLine[] {
  return lines.map((line) => ({
    key: crypto.randomUUID(),
    productId: line.productId,
    quantity: String(line.quantity),
  }));
}

/** Every total on screen is calculated from the approved price (product.md §5.2). */
export function draftSubtotal(lines: DraftLine[], products: CatalogueProduct[]): number {
  return lines.reduce((sum, line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const quantity = Number.parseInt(line.quantity, 10);
    if (!product || product.priceTzs === null || !Number.isFinite(quantity)) return sum;
    return sum + product.priceTzs * quantity;
  }, 0);
}

export function productLabel(product: CatalogueProduct): string {
  return [product.name, product.specification, product.unitContent].filter(Boolean).join(" · ");
}

/**
 * Search-first product selection (design.md §7.4, §10.1).
 *
 * A product already on the order is still offered, and selecting it moves focus to that line rather
 * than adding a second one: `duplicate_product_line` is a refusal the database makes, and walking
 * somebody into it is worse than not offering the tap.
 */
export function ProductPicker({
  products,
  availability,
  chosen,
  disabled,
  onSelect,
  idPrefix,
}: {
  products: CatalogueProduct[];
  availability: Availability[];
  chosen: string[];
  disabled?: boolean;
  onSelect: (productId: string) => void;
  idPrefix: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [query, setQuery] = useState("");

  const availableFor = useMemo(
    () => new Map(availability.map((row) => [row.productId, row])),
    [availability],
  );

  const needle = query.trim().toLowerCase();
  const results = products.filter((product) =>
    needle.length === 0 ? true : productLabel(product).toLowerCase().includes(needle),
  );

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <Label htmlFor={`${idPrefix}-product-search`}>{t("sales.newOrder.product")}</Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={`${idPrefix}-product-search`}
            type="search"
            autoComplete="off"
            className="pl-9"
            placeholder={t("sales.newOrder.searchProduct")}
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </Field>

      {results.length === 0 ? (
        <Help>{t("sales.newOrder.noProductResults")}</Help>
      ) : (
        <ul
          className="flex max-h-80 flex-col gap-2 overflow-y-auto"
          data-testid={`${idPrefix}-product-results`}
        >
          {results.map((product) => {
            const stock = availableFor.get(product.id);
            const already = chosen.includes(product.id);

            return (
              <li key={product.id}>
                {/* A selectable card, not an option: the price and what is left to sell are part of
                    the choice, and a `<select>` hides both until after it is made. */}
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={already}
                  onClick={() => onSelect(product.id)}
                  className={cn(
                    "flex w-full min-h-11 flex-col gap-1 rounded-md border p-3 text-left transition-colors",
                    "hover:bg-[color-mix(in_srgb,var(--fv-periwinkle)_20%,transparent)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    "disabled:pointer-events-none disabled:opacity-50",
                    already ? "border-primary bg-vanilla/40" : "border-border bg-card",
                  )}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{productLabel(product)}</span>
                    {product.priceTzs === null ? (
                      <StatusChip tone="attention">{t("sales.newOrder.noPrice")}</StatusChip>
                    ) : (
                      <span className="fv-numeric text-sm">
                        {formatTzs(product.priceTzs, locale)}
                      </span>
                    )}
                  </span>
                  {stock ? (
                    // Available, not physical — §8.1. The two differ when somebody else has already
                    // claimed some, and quoting against the wrong one sells stock twice.
                    <span className="text-xs text-muted-foreground">
                      {t("sales.newOrder.available", {
                        count: stock.available,
                        physical: stock.physical,
                      })}
                    </span>
                  ) : null}
                  {already ? (
                    <span className="text-xs text-muted-foreground">
                      {t("sales.newOrder.alreadyOnOrder")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function OrderLineList({
  lines,
  products,
  units,
  availability,
  disabled,
  fieldErrors,
  idPrefix,
  onChange,
}: {
  lines: DraftLine[];
  products: CatalogueProduct[];
  units: Unit[];
  availability: Availability[];
  disabled?: boolean;
  fieldErrors?: Record<string, string>;
  idPrefix: string;
  onChange: (lines: DraftLine[]) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const unitsByCode = useMemo(() => new Map(units.map((unit) => [unit.code, unit])), [units]);
  const availableFor = useMemo(
    () => new Map(availability.map((row) => [row.productId, row])),
    [availability],
  );

  function update(key: string, patch: Partial<DraftLine>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function step(line: DraftLine, by: number) {
    const current = Number.parseInt(line.quantity, 10);
    const next = Math.max(1, (Number.isFinite(current) ? current : 0) + by);
    update(line.key, { quantity: String(next) });
  }

  if (lines.length === 0) {
    return <Help>{t("sales.newOrder.empty")}</Help>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {lines.map((line, index) => {
        const product = products.find((candidate) => candidate.id === line.productId);
        const stock = line.productId ? availableFor.get(line.productId) : undefined;
        const unit =
          product && unitsByCode.has(product.unitCode)
            ? unitLabel(unitsByCode.get(product.unitCode)!, locale)
            : null;
        const quantity = Number.parseInt(line.quantity, 10);
        const lineTotal =
          product?.priceTzs != null && Number.isFinite(quantity)
            ? product.priceTzs * quantity
            : null;

        return (
          <li
            key={line.key}
            className="flex flex-col gap-3 rounded-md border border-border p-3"
            data-testid={`${idPrefix}-line-${index}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="text-sm font-medium">
                {product ? productLabel(product) : t("sales.newOrder.chooseProduct")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="small"
                id={`${idPrefix}RemoveItem${index}`}
                disabled={disabled}
                onClick={() => onChange(lines.filter((item) => item.key !== line.key))}
              >
                {t("sales.newOrder.removeItem")}
              </Button>
            </div>

            {product && product.priceTzs === null ? (
              <StatusChip tone="attention">{t("sales.newOrder.noPrice")}</StatusChip>
            ) : null}

            <Field>
              <Label htmlFor={`${idPrefix}-quantity-${line.key}`}>
                {unit ? t("sales.newOrder.quantityIn", { unit }) : t("sales.newOrder.quantity")}
              </Label>
              {/* Stepper plus numeric entry (§10.1). Two taps for the common case, and the field is
                  still there for the uncommon one. */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  id={`${idPrefix}Decrease${index}`}
                  aria-label={t("sales.newOrder.decrease")}
                  disabled={disabled}
                  onClick={() => step(line, -1)}
                >
                  <Minus aria-hidden="true" />
                </Button>
                <Input
                  id={`${idPrefix}-quantity-${line.key}`}
                  type="text"
                  inputMode="numeric"
                  className="fv-numeric w-24 text-center"
                  value={line.quantity}
                  disabled={disabled}
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  id={`${idPrefix}Increase${index}`}
                  aria-label={t("sales.newOrder.increase")}
                  disabled={disabled}
                  onClick={() => step(line, 1)}
                >
                  <Plus aria-hidden="true" />
                </Button>
              </div>
              {stock ? (
                <Help data-testid={`order-available-${index}`}>
                  {t("sales.newOrder.available", {
                    count: stock.available,
                    physical: stock.physical,
                  })}
                </Help>
              ) : null}
              <FieldError>
                {fieldErrors?.[`lines.${index}.quantity`]
                  ? t(fieldErrors[`lines.${index}.quantity`])
                  : null}
              </FieldError>
            </Field>

            {lineTotal !== null ? (
              <p
                className="fv-numeric text-sm text-muted-foreground"
                data-testid={`order-line-total-${index}`}
              >
                {t("sales.newOrder.lineTotal", { total: formatTzs(lineTotal, locale) })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
