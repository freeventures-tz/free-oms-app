import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";
import { REPORT_SECTION_COUNT } from "@/lib/reports/report-content";

/**
 * Shaped like one report, card for card (design.md §12.4, §12.7 rule 3).
 *
 * A SKELETON IS A PROMISE ABOUT WHAT ARRIVES. This one used to promise a header, one card and six
 * section cards; the page then delivered a header, an integrity card, a delivery card, an overview
 * and seventeen sections, so everything below the fold jumped as it loaded and the reader's thumb
 * landed on the wrong thing. What stands in for the page has to have the page's shape:
 *
 *   · the back link;
 *   · the integrity card — heading, chip, sentence, and the long fingerprint line;
 *   · the delivery card — heading, sentence, and three recipient lines;
 *   · the overview — four figures, two abreast on a phone and four across from `xl`;
 *   · every section, laid out the way the loaded page lays them out: collapsed to a heading row on
 *     a phone, open in two columns from `md`.
 *
 * THE SECTION COUNT IS IMPORTED, not typed in again. Seventeen is a fact about the report, and a
 * skeleton holding its own copy of it is a skeleton that stops matching the first time a section is
 * added — silently, because nothing fails when a placeholder is the wrong length.
 */
export default async function ReportLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <Skeleton className="h-4 w-[100px] rounded-sm" />

      {/* Integrity: heading and chip on one line, the finding under it, the fingerprint last. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-[130px] rounded-sm" />
          <Skeleton className="h-6 w-[92px] rounded-full" />
        </div>
        <Skeleton className="h-4 w-full max-w-[420px] rounded-sm" />
        <Skeleton className="h-3 w-full max-w-[520px] rounded-sm" />
      </div>

      {/* Delivery: who the report was written for. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-5 w-[86px] rounded-sm" />
        <Skeleton className="h-4 w-full max-w-[300px] rounded-sm" />
        {Array.from({ length: 3 }, (_, line) => (
          <Skeleton key={line} className="h-3.5 w-[190px] rounded-sm" />
        ))}
      </div>

      {/* The overview, which is what a phone reader sees first. */}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-5 w-[110px] rounded-sm" />
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, figure) => (
            <div key={figure} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-[88px] rounded-sm" />
              <Skeleton className="h-4 w-[104px] rounded-sm" />
            </div>
          ))}
        </div>
        <Skeleton className="h-4 w-full max-w-[360px] rounded-sm" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: REPORT_SECTION_COUNT }, (_, card) => (
          <div
            key={card}
            className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
          >
            {/* The heading row, which is all a collapsed section shows. */}
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-5 w-[150px] rounded-sm" />
              <Skeleton className="size-4 shrink-0 rounded-sm" />
            </div>

            {/* The body: hidden on a phone exactly as the collapsed sections are. */}
            <div className="hidden flex-col gap-2 md:flex">
              {Array.from({ length: 4 }, (_, line) => (
                <div key={line} className="flex items-center justify-between gap-4">
                  <Skeleton className="h-3.5 w-[130px] rounded-sm" />
                  <Skeleton className="h-3.5 w-[70px] rounded-sm" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
