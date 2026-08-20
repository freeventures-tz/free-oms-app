"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { setPriceAction, type CatalogueActionState } from "@/app/(app)/settings/products/actions";
import { PriceHistory } from "@/app/(app)/settings/products/price-history";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, PriceHistoryEntry, Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import { formatTzs } from "@/lib/money";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * The catalogue, as cards on every tier (design.md §3.5).
 *
 * A table would win on a desktop and lose badly on the phone this is mostly used from, and the
 * information per product is small enough — a name, a unit, a price — that a card carries it
 * comfortably at every width. `TZS` sits in the value here rather than in a column header (§8.5)
 * precisely because there is no column header on a phone.
 */
export function ProductList({
  products,
  units,
  history,
  canEdit,
}: {
  products: CatalogueProduct[];
  units: Unit[];
  history: Record<string, PriceHistoryEntry[]>;
  canEdit: boolean;
}) {
  const t = useTranslations("catalogue");
  // Every unit, including the retired ones. A card that could not name its own counting unit would
  // be a worse answer than naming one nobody may choose again.
  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));

  if (products.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("productCount", { count: products.length })}</p>
      {products.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          unit={unitsByCode.get(product.unitCode) ?? null}
          history={history[product.id] ?? []}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

function ProductRow({
  product,
  unit,
  history,
  canEdit,
}: {
  product: CatalogueProduct;
  unit: Unit | null;
  history: PriceHistoryEntry[];
  canEdit: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);

  // Name and grade together, because that pair IS the product (product.md §6). As the card's
  // accessible name it gives a screen reader the context for every control inside it — "Set price"
  // on its own says nothing about which product — and it is what tells the two Nondo 12 mm rows
  // apart for anybody navigating by landmark.
  const identity = [product.name, product.specification, product.unitContent]
    .filter(Boolean)
    .join(" ");

  // The label the Director typed for this language. A unit that has somehow gone missing falls back
  // to its code rather than to an empty line: an unreadable answer beats a silent one.
  const unitName = unit ? unitLabel(unit, locale) : product.unitCode;

  return (
    <Card role="article" aria-label={identity}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {product.name}
            {product.specification ? (
              // Part of the product's identity, not a footnote: "Nondo 12 mm BS 300" and
              // "Nondo 12 mm BS 500" are different things to sell (product.md §6).
              <span className="fv-identifier ml-2 text-sm text-muted-foreground">
                {product.specification}
              </span>
            ) : null}
          </p>
          {/* Two separate facts, shown separately (product.md §6, design.md §7.12a). What the yard
              COUNTS is one line; what one of them HOLDS is another. Running them together as
              "50 kg bag" is exactly the ambiguity this stage exists to remove — a movement of 40
              against it reads as 40 bags or 2 000 kg depending on the reader. */}
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
          {product.priceTzs === null ? (
            // A missing price is a NAMED state, never a zero. Nothing may be sold at a price no
            // Director approved, so the screen says so in words rather than showing "TZS 0".
            <StatusChip tone="attention">{t("catalogue.noPrice")}</StatusChip>
          ) : (
            <div className="flex flex-col items-start gap-0.5 md:items-end">
              <p className="fv-numeric text-lg font-semibold">
                {formatTzs(product.priceTzs, locale)}
              </p>
              {/* A price is the price of ONE counting unit (product.md §6.1 rule 1), and the screen
                  says which one rather than leaving it to be assumed. */}
              <p className="text-xs text-muted-foreground">
                {t("catalogue.priceLabelPerUnit", { unit: unitName })}
              </p>
            </div>
          )}

          {/* Hidden from a Manager, not greyed out (design.md §4.3, §4.4). */}
          {canEdit ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              aria-expanded={editing}
              onClick={() => setEditing((value) => !value)}
            >
              {product.priceTzs === null ? t("catalogue.price.set") : t("catalogue.price.change")}
            </Button>
          ) : null}
        </div>
      </div>

      {product.priceTzs === null ? (
        <Help className="mt-2">{t("catalogue.noPriceHelp")}</Help>
      ) : null}

      {editing && canEdit ? (
        <PriceForm product={product} onDone={() => setEditing(false)} />
      ) : null}

      {/* Readable by a Manager too: history is a record, and only the CHANGING of it is
          Director-only (product.md §4.4). */}
      <PriceHistory entries={history} />
    </Card>
  );
}

function PriceForm({ product, onDone }: { product: CatalogueProduct; onDone: () => void }) {
  const t = useTranslations();
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");

  /**
   * ONE idempotency key per interaction, minted when the form opens and reused for every attempt
   * on it — including a retry after a failure. Two taps therefore address the same price entry
   * rather than writing two rows into permanent history.
   *
   * Minted in an initialiser rather than during render, so the server and the client never disagree
   * about it; a hydration mismatch here would silently defeat the protection.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"save", CatalogueActionState>({
    failureKey: "catalogueErrors.generic",
  });
  const { pending, result } = action;

  if (result.successKey) {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <p className="text-sm text-success">{t(result.successKey)}</p>
        <Button type="button" variant="secondary" size="small" className="mt-3" onClick={onDone}>
          {t("common.close")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">{t("catalogue.price.heading")}</h3>

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

      <Field>
        <Label htmlFor={`price-${product.id}`}>{t("catalogue.price.amount")}</Label>
        <Input
          id={`price-${product.id}`}
          // `inputMode="numeric"` gives a phone the digit keypad; `type="text"` keeps the grouping
          // separators people naturally type from being rejected by the browser before we see them.
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="fv-numeric"
          value={price}
          disabled={pending}
          onChange={(event) => setPrice(event.target.value)}
        />
        <Help>{t("catalogue.price.amountHelp")}</Help>
        <FieldError>
          {result.fieldErrors?.price ? t(result.fieldErrors.price) : null}
        </FieldError>
      </Field>

      <Field>
        <Label htmlFor={`reason-${product.id}`}>{t("catalogue.price.reason")}</Label>
        <Input
          id={`reason-${product.id}`}
          type="text"
          autoComplete="off"
          value={reason}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
        />
        <Help>{t("catalogue.price.reasonHelp")}</Help>
        <FieldError>
          {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
        </FieldError>
      </Field>

      <div className="flex flex-col gap-3 md:flex-row">
        <Button
          type="button"
          pending={pending}
          pendingLabel={t("common.loading")}
          onClick={() => {
            const data = new FormData();
            data.set("productId", product.id);
            data.set("price", price);
            data.set("reason", reason);
            data.set("idempotencyKey", idempotencyKey);
            action.run("save", setPriceAction, data);
          }}
        >
          {t("catalogue.price.submit")}
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={onDone}>
          {t("catalogue.price.cancel")}
        </Button>
      </div>
    </div>
  );
}
