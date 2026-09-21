import { getTranslations } from "next-intl/server";

import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like one funding (design.md §12.7 rule 3; review F2 on PR #49): the header with its
 * status chip, the link back, the four figures, the actions card, then the history as a list of
 * compact cards.
 *
 * The figures hold the page's own grid, two columns on a phone and four from `md`, because they
 * are what the reader came for and the part that would jump furthest if the shape were wrong.
 *
 * The actions card is drawn with one control's height and no more. Every reader gets the card,
 * but what is in it depends on the role and the funding's state, neither of which is known until
 * the page arrives; a row of buttons the reader may not be offered would promise too much.
 */
export default async function FundingLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-8 w-[240px] rounded-md" />
          {/* The description is the request's reason: usually one line, at the text's own height. */}
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-[min(280px,80%)] rounded-sm" />
          </div>
        </div>
        <Skeleton className="h-6 w-[88px] shrink-0 rounded-full" />
      </div>

      <Skeleton className="h-4 w-[150px] rounded-sm" />

      <div className="rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="funding-figures-skeleton">
          {Array.from({ length: 4 }, (_, figure) => (
            <div key={figure} className="flex flex-col gap-1">
              <Skeleton className="h-3.5 w-[80px] rounded-sm" />
              <Skeleton className="h-5 w-[110px] max-w-full rounded-sm" />
            </div>
          ))}
        </div>
      </div>

      <div
        className="rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
        data-testid="funding-actions-skeleton"
      >
        <Skeleton className="h-11 w-[160px] rounded-md xl:h-9" />
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-[120px] rounded-sm" />
        <ol className="flex flex-col gap-2" data-testid="funding-history-skeleton">
          {Array.from({ length: 3 }, (_, event) => (
            <li
              key={event}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6"
            >
              <Skeleton className="h-5 w-[min(260px,75%)] rounded-sm" />
              <Skeleton className="h-4 w-[200px] max-w-full rounded-sm" />
            </li>
          ))}
        </ol>
      </div>
    </LoadingRegion>
  );
}
