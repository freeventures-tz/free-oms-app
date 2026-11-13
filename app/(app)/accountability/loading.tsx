import { getTranslations } from "next-intl/server";

import { CardSkeleton, LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Shaped like the screen: a heading, three waiting subjects, a heading and two decisions. */
export default async function AccountabilityLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />
      <Skeleton className="h-6 w-[220px] rounded-sm" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, row) => (
          <CardSkeleton key={row} lines={3} />
        ))}
      </div>
      <Skeleton className="h-6 w-[160px] rounded-sm" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 2 }, (_, row) => (
          <CardSkeleton key={row} lines={2} />
        ))}
      </div>
    </LoadingRegion>
  );
}
