import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Shaped like the corrections board: header, then cards carrying a product, a delta and a reason. */
export default async function AdjustmentsLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {Array.from({ length: 3 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
        >
          <Skeleton className="h-5 w-[190px] rounded-sm" />
          <Skeleton className="h-4 w-[120px] rounded-sm" />
          <Skeleton className="h-3.5 w-[240px] rounded-sm" />
        </div>
      ))}
    </LoadingRegion>
  );
}
