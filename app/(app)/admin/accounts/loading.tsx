import { getTranslations } from "next-intl/server";

import { LoadingRegion, PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * User Accounts is the one screen in the shell that is genuinely data-backed, and the one whose
 * delay was reported, so it gets a skeleton shaped like what it is replacing rather than the
 * shell's generic one: the header, the create-account card, then account rows.
 *
 * Each row mirrors `AccountsList` — a name, a phone number, three status chips and the actions
 * control on the right — so when the real list lands nothing moves (design.md §12.4, §12.7 rule 3).
 */
export default async function AccountsLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />

      {/* The create-account card: heading, three fields, one action. */}
      <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <Skeleton className="h-6 w-[180px] rounded-md" />
        {[0, 1, 2].map((field) => (
          <div key={field} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-[120px] rounded-sm" />
            <Skeleton className="h-12 w-full rounded-sm md:h-11 xl:h-10" />
          </div>
        ))}
        <Skeleton className="h-12 w-full rounded-md md:h-11 xl:h-10" />
      </div>

      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5 xl:p-6"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[160px] rounded-sm" />
              <Skeleton className="h-4 w-[130px] rounded-sm" />
              <div className="mt-1 flex gap-2">
                <Skeleton className="h-6 w-[90px] rounded-full" />
                <Skeleton className="h-6 w-[70px] rounded-full" />
              </div>
            </div>
            <Skeleton className="h-11 w-[104px] rounded-md md:h-10 xl:h-8" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
