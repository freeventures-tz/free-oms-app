import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the orders list: header, filter chips, then a card per order carrying a number, a
 * state and a total. A skeleton of the wrong shape buys the first layout shift with a second one
 * (design.md §12.4, §12.7 rule 3).
 */
export default async function OrdersLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, chip) => (
          <Skeleton key={chip} className="h-11 w-[96px] rounded-md xl:h-10" />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, row) => (
          <div
            key={row}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[170px] rounded-sm" />
              <Skeleton className="h-4 w-[130px] rounded-sm" />
            </div>
            <Skeleton className="h-6 w-[130px] rounded-sm" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
