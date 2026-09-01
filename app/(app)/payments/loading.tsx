import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the settlement queue. A skeleton of the wrong
 * shape buys the first layout shift with a second one (design.md §12.4, §12.7 rule 3).
 */
export default async function Loading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {Array.from({ length: 4 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5 xl:p-6"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-[190px] rounded-sm" />
            <Skeleton className="h-4 w-[140px] rounded-sm" />
            <Skeleton className="h-5 w-[90px] rounded-full" />
          </div>
          <Skeleton className="h-8 w-[150px] rounded-sm" />
        </div>
      ))}
    </LoadingRegion>
  );
}
