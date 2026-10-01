import { getTranslations } from "next-intl/server";

import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the till screen: header, today's card with its six payment-method rows, then a list
 * heading and compact cards. The count form is not drawn: only the Cashier gets one, and a skeleton
 * cannot know who is reading without the session lookup it stands in for.
 */
export default async function TillLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-[200px] rounded-md" />
        <Skeleton className="h-3.5 w-[min(760px,95%)] rounded-sm" />
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <Skeleton className="h-4 w-[140px] rounded-sm" />
          <Skeleton className="h-6 w-[120px] rounded-full" />
        </div>
        <Skeleton className="h-4 w-[min(520px,90%)] rounded-sm" />
        {Array.from({ length: 6 }, (_, row) => (
          <Skeleton key={row} className="h-9 w-full rounded-md" />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-[180px] rounded-sm" />
        {Array.from({ length: 3 }, (_, row) => (
          <Skeleton key={row} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </LoadingRegion>
  );
}
