"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import type { PriceHistoryEntry } from "@/lib/catalogue/catalogue";
import { formatTzs } from "@/lib/money";

/**
 * Immutable selling-price history (product.md §4.4).
 *
 * Readable by a Manager as well as a Director: it is a record, and only the CHANGING of a price is
 * Director-only. Nothing here offers an edit or a delete, because none exists — the database
 * refuses both for every role, including its own definer owner.
 *
 * Collapsed by default. On a phone the current price is the answer someone came for; the history
 * is the answer to a different question, and putting it in the way of the first would make a list
 * of twenty-one products unreadable.
 */
export function PriceHistory({ entries }: { entries: PriceHistoryEntry[] }) {
  const t = useTranslations("catalogue.price");
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="min-h-11 text-sm font-medium text-bronze-text underline-offset-4 hover:underline xl:min-h-8"
      >
        {t("historyShow")} ({entries.length})
      </button>

      {open ? (
        <ol className="mt-2 flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-0.5">
              <p className="fv-numeric text-sm font-medium">
                {formatTzs(entry.priceTzs, locale)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {entry.previousPriceTzs === null
                    ? t("historyFirst")
                    : t("historyFrom", { price: formatTzs(entry.previousPriceTzs, locale) })}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {t("setBy", { who: entry.setByName })} ·{" "}
                <time dateTime={entry.effectiveAt}>
                  {new Intl.DateTimeFormat(locale === "sw" ? "sw-TZ" : "en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "Africa/Dar_es_Salaam",
                  }).format(new Date(entry.effectiveAt))}
                </time>
              </p>
              <p className="text-xs text-foreground/80">{entry.reason}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
