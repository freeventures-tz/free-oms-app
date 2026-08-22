import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the stock board it replaces: header, location tabs, then a row per product carrying
 * a name, its counting unit and a quantity. A skeleton of the wrong shape buys the first layout
 * shift with a second one (design.md §12.4, §12.7 rule 3).
 */
export default async function InventoryLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex gap-2">
        {Array.from({ length: 3 }, (_, tab) => (
          <Skeleton key={tab} className="h-11 w-[110px] rounded-md xl:h-10" />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, row) => (
          <div
            key={row}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[180px] rounded-sm" />
              <Skeleton className="h-3.5 w-[110px] rounded-sm" />
            </div>
            <Skeleton className="h-6 w-[120px] rounded-sm" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
