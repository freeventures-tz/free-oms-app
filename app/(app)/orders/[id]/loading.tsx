import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Shaped like the order detail: header, a state card, then the quotation with its line table. */
export default async function OrderDetailLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-5 w-[120px] rounded-full" />
        <Skeleton className="h-3.5 w-[190px] rounded-sm" />
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-5 w-[150px] rounded-sm" />
        <Skeleton className="h-24 w-full rounded-sm" />
        <Skeleton className="h-5 w-[140px] self-end rounded-sm" />
      </div>
    </LoadingRegion>
  );
}
