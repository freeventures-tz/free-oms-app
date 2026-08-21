import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the catalogue it replaces: header, then product rows carrying a name, a unit and a
 * price. A skeleton of the wrong shape buys the first layout shift with a second one
 * (design.md §12.4, §12.7 rule 3).
 *
 * The add-product card is NOT drawn here. A Manager never sees it, and a skeleton that promises a
 * control the reader will not get is a worse lie than a slower page.
 */
export default async function ProductsLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      <div className="flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, row) => (
          <div
            key={row}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[180px] rounded-sm" />
              {/* Two lines under the name, because a card now carries two facts about measurement:
                  what it is counted by, and what one of those holds (product.md §6). Most of the
                  catalogue has both, so a two-line skeleton would buy the first layout shift with
                  a second one (design.md §12.7 rule 3). */}
              <Skeleton className="h-3.5 w-[110px] rounded-sm" />
              <Skeleton className="h-3.5 w-[90px] rounded-sm" />
            </div>
            <div className="flex flex-col gap-1.5 md:items-end">
              <Skeleton className="h-6 w-[140px] rounded-sm" />
              <Skeleton className="h-3.5 w-[100px] rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
