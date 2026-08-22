import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Shaped like the transfer board: header, then cards carrying a direction and their lines. */
export default async function TransfersLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {Array.from({ length: 3 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
        >
          <Skeleton className="h-5 w-[220px] rounded-sm" />
          <Skeleton className="h-3.5 w-[150px] rounded-sm" />
          <Skeleton className="h-12 w-full rounded-sm" />
        </div>
      ))}
    </LoadingRegion>
  );
}
