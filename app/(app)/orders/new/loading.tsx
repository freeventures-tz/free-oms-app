import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Shaped like the order form: header, a customer field, one item block, and the running total. */
export default async function NewOrderLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-4 w-[120px] rounded-sm" />
        <Skeleton className="h-12 w-full rounded-sm md:h-11 xl:h-10" />
        <Skeleton className="h-4 w-[90px] rounded-sm" />
        <Skeleton className="h-32 w-full rounded-sm" />
        <Skeleton className="h-6 w-[160px] self-end rounded-sm" />
        <Skeleton className="h-12 w-full rounded-md md:h-11 xl:h-10" />
      </div>
    </LoadingRegion>
  );
}
