"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

/** How many rows a board draws at first, and how many more each press adds. */
export const REVEAL_STEP = 20;

/**
 * The newest rows of a board, with an honest count and a way to the rest.
 *
 * A board that draws every card it holds gets slower with every record the business keeps. On the
 * receiving board each card costs a phone tens of milliseconds, the board holds up to two hundred,
 * and the whole list was drawn again after every save: the wait between the server's answer and
 * the refreshed screen grew from a fraction of a second to several seconds (measured in the delivery
 * benchmark on 3 November 2026). Drawing the first twenty keeps that cost flat.
 *
 * It never shows a short list as if it were the whole one, which is the failure `Pager` exists to
 * prevent: past one step it states "Showing 1–20 of 80" and offers the next step.
 *
 * `Pager` stays the right choice where the server can page the read. This is for a board whose
 * rows are already in hand and only the drawing needs bounding.
 */
export function Reveal<T>({
  rows,
  label,
  name,
  children,
}: {
  rows: T[];
  /** Names the section for assistive technology, because a screen carries more than one. */
  label: string;
  /** Distinguishes this list's count and control from another's on the same screen. */
  name: string;
  children: (row: T) => ReactNode;
}) {
  const t = useTranslations("common.pager");
  const [shown, setShown] = useState(REVEAL_STEP);
  const visible = rows.length > shown ? rows.slice(0, shown) : rows;

  return (
    <>
      {visible.map(children)}
      {rows.length > REVEAL_STEP ? (
        <div role="group" aria-label={label} className="flex flex-wrap items-center justify-between gap-3">
          <p className="fv-numeric text-xs text-muted-foreground" data-testid={`reveal-count-${name}`}>
            {t("showing", { first: 1, last: visible.length, total: rows.length })}
          </p>
          {visible.length < rows.length ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              data-testid={`reveal-more-${name}`}
              onClick={() => setShown((current) => current + REVEAL_STEP)}
            >
              {t("more")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
