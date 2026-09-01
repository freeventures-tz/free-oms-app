"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/**
 * One page of a queue, and an honest account of the rest.
 *
 * A queue that silently shows the first N records is the failure this exists to prevent: the
 * Cashier sees a short list and has no way to know that the oldest unsettled invoice in the
 * business is on page four. So the count is always stated — "Showing 1–25 of 312" — and the way to
 * the rest is a link, not a scroll.
 *
 * LINKS, NOT BUTTONS, and that is the feedback contract rather than a shortcut (design.md §12.7):
 * a page change is a navigation, the shell marks the destination immediately, and the route's own
 * `loading.tsx` paints a skeleton shaped like the queue while the server answers. Nothing here
 * needs client state, so nothing here can get stuck pending, and nothing here moves — which is
 * what `prefers-reduced-motion` asks of it (§12.7 rule 6).
 */
export function Pager({
  page,
  pageSize,
  total,
  param,
  basePath,
  otherParams = {},
  label,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** The query parameter this pager owns, so two pagers on one screen do not move together. */
  param: string;
  basePath: string;
  /** Every other pager's current page, kept so paging one section does not reset the other. */
  otherParams?: Record<string, number>;
  /** Names the section for assistive technology, because a screen carries more than one. */
  label: string;
}) {
  const t = useTranslations("common.pager");

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  function href(target: number): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(otherParams)) {
      if (value > 1) params.set(key, String(value));
    }
    if (target > 1) params.set(param, String(target));
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  }

  // One page of results needs no controls, but it still needs its count: "3 of 3" and "3 of 300"
  // are different situations and the reader cannot tell them apart from the cards alone.
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3">
      <p className="fv-numeric text-xs text-muted-foreground" data-testid={`pager-count-${param}`}>
        {total === 0 ? t("none") : t("showing", { first, last, total })}
      </p>

      {pages > 1 ? (
        <span className="flex items-center gap-2">
          {current > 1 ? (
            <Button asChild variant="secondary" size="small">
              <Link href={href(current - 1)} data-testid={`pager-previous-${param}`}>
                {t("previous")}
              </Link>
            </Button>
          ) : null}
          {current < pages ? (
            <Button asChild variant="secondary" size="small">
              <Link href={href(current + 1)} data-testid={`pager-next-${param}`}>
                {t("next")}
              </Link>
            </Button>
          ) : null}
        </span>
      ) : null}
    </nav>
  );
}
