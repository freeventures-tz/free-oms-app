import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the supplier list it replaces: header, then rows carrying a name and a state chip.
 *
 * The add-supplier card is NOT drawn. A Manager never sees it, and a skeleton that promises a
 * control the reader will not get is a worse lie than a slower page (design.md §12.4).
 */
export default async function SuppliersLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, row) => (
          <div
            key={row}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[200px] rounded-sm" />
              <Skeleton className="h-5 w-[70px] rounded-full" />
            </div>
            <Skeleton className="h-11 w-[120px] rounded-md md:h-10 xl:h-8" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
