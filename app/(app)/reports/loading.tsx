import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the report archive, line for line (design.md §12.4, §12.7 rule 3).
 *
 * A CARD HAS FIVE THINGS ON IT, and the skeleton promises all five: the business date, how many
 * people the report reached, the time it was generated, the integrity chip, and the word that opens
 * it. A placeholder that promises two of them is a page that jumps as the third and fourth arrive —
 * and on a phone, where the card is one column, a missing line moves everything below it.
 *
 * No filter row and no button, because the screen has neither: a skeleton that promises a control
 * the reader will not get is worse than a slower page.
 *
 * The responsive rule is the card's own — stacked on a phone, one row from `md` with the chip and
 * the Open label pushed to the end — so the placeholder reflows at the same width the real thing
 * does.
 */
export default async function ReportsLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <Skeleton className="h-4 w-[110px] rounded-sm" />

      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, row) => (
          <div
            key={row}
            data-testid="report-card-skeleton"
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              {/* The business date, which is what the card is called. */}
              <Skeleton className="h-5 w-[210px] rounded-sm" />
              {/* Delivery leads the rest of the card (design.md §13.1, §7.21). */}
              <Skeleton className="h-4 w-[130px] rounded-sm" />
              {/* And the time it was written. */}
              <Skeleton className="h-4 w-[190px] rounded-sm" />
            </div>

            <div className="flex items-center gap-3">
              {/* The integrity chip: a pill, because that is what arrives here. */}
              <Skeleton className="h-6 w-[110px] rounded-full" />
              {/* And the word that opens the report. */}
              <Skeleton className="h-4 w-[46px] rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
