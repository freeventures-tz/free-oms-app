import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the production board: header, then batch cards carrying an identifier, a location and
 * a materials table.
 *
 * The entry control is not drawn. A Director never sees one — §4.1 gives production to the Manager
 * — and a skeleton that promises a control the reader will not get is a worse lie than a slower
 * page (design.md §12.7 rule 3).
 *
 * The pager line above each section IS drawn, because it is there for every reader and on every
 * page: paging is a navigation, so this skeleton is what a Manager sees while page two arrives.
 */
export default async function ProductionLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {Array.from({ length: 3 }, (_, card) => (
        <div key={card} className="flex flex-col gap-3">
          <Skeleton className="h-3.5 w-[160px] rounded-sm" />

          <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[180px] rounded-sm" />
              <Skeleton className="h-3.5 w-[150px] rounded-sm" />
              <Skeleton className="h-3.5 w-[130px] rounded-sm" />
            </div>
            <Skeleton className="h-24 w-full rounded-sm" />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}
