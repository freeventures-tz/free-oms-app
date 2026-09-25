import { getTranslations } from "next-intl/server";

import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the imprest screen: header, the figures card (posted funding, set aside and free to
 * approve; issue #55), then a list heading, compact cards and the pager count (design.md §12.7
 * rule 3; review F2 on PR #49). A Cashier is sent Free to approve alone, so their card is shorter
 * than this one; the skeleton cannot know the role without the session lookup it stands in for.
 *
 * Each card is laid out as the real one is: stacked on a phone, and from `md` a row with the
 * number, requester and reason on the left and the status and amounts on the right.
 *
 * The request form is not drawn. Only the Manager gets one, and a skeleton cannot know who is
 * reading without waiting for the very session lookup it stands in for. The production board
 * settled the same question the same way: a Director never sees the control, and a skeleton that
 * promises a control the reader will not get is a worse lie than a Manager's form arriving late.
 */
export default async function ImprestLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-[220px] rounded-md" />
        <TextLines lineClass="h-5" barClass="h-3.5" />
      </div>

      <div className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-3 md:p-5 xl:p-6">
        {Array.from({ length: 3 }, (_, figure) => (
          <div
            key={figure}
            className="flex flex-col gap-1"
            data-testid={figure === 0 ? "funding-total-skeleton" : undefined}
          >
            <Row className="h-5">
              <Skeleton className="h-3.5 w-[160px] rounded-sm" />
            </Row>
            <Row className="h-8">
              <Skeleton className="h-7 w-[140px] rounded-md" />
            </Row>
            <Row className="h-4">
              <Skeleton className="h-3 w-[90%] rounded-sm" />
            </Row>
            <Row className="h-4">
              <Skeleton className="h-3 w-[60%] rounded-sm" />
            </Row>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-[180px] rounded-sm" />

        <ul className="flex flex-col gap-3" data-testid="funding-list-skeleton">
          {Array.from({ length: 4 }, (_, row) => (
            <li
              key={row}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between md:p-5 xl:p-6"
            >
              <div className="flex flex-col gap-1">
                <Skeleton className="h-5 w-[170px] rounded-sm" />
                <Skeleton className="h-4 w-[190px] rounded-sm" />
                <Skeleton className="h-4 w-[min(240px,70%)] rounded-sm" />
              </div>
              <div className="flex flex-col items-start gap-1 md:items-end">
                <Skeleton className="h-6 w-[88px] rounded-full" />
                <Skeleton className="h-4 w-[150px] rounded-sm" />
              </div>
            </li>
          ))}
        </ul>

        <Skeleton className="h-3.5 w-[120px] rounded-sm" />
      </div>
    </LoadingRegion>
  );
}

function Row({ className, children }: { className: string; children: React.ReactNode }) {
  return <div className={`flex items-center ${className}`}>{children}</div>;
}

/**
 * A sentence of about 110 to 130 characters in either locale, as the page description and the
 * total's explanation both are: three lines on a phone, two on a tablet, one on a desktop. Each
 * line holds the real line's height, so the content below lands where it will stay.
 */
function TextLines({ lineClass, barClass }: { lineClass: string; barClass: string }) {
  return (
    <div className="flex flex-col">
      <Row className={lineClass}>
        <Skeleton className={`${barClass} w-[min(760px,95%)] rounded-sm`} />
      </Row>
      <Row className={`${lineClass} xl:hidden`}>
        <Skeleton className={`${barClass} w-[90%] rounded-sm`} />
      </Row>
      <Row className={`${lineClass} md:hidden`}>
        <Skeleton className={`${barClass} w-[50%] rounded-sm`} />
      </Row>
    </div>
  );
}
