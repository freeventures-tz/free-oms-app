import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the receiving board: header, then receipt cards carrying a supplier, a delivery
 * reference and a line table. The entry control is not drawn — a Director never sees one, and a
 * skeleton that promises a control the reader will not get is a worse lie than a slower page.
 */
export default async function ReceivingLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {Array.from({ length: 3 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-[200px] rounded-sm" />
            <Skeleton className="h-3.5 w-[140px] rounded-sm" />
            <Skeleton className="h-3.5 w-[160px] rounded-sm" />
          </div>
          <Skeleton className="h-20 w-full rounded-sm" />
        </div>
      ))}
    </LoadingRegion>
  );
}
