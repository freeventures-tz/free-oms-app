import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { FundingActions } from "@/app/(app)/imprest/funding-forms";
import { FundingStatusChip } from "@/app/(app)/imprest/funding-status";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadFunding, type FundingEvent } from "@/lib/imprest/funding";
import { formatTzs } from "@/lib/money";
import { formatBusinessStamp } from "@/lib/time/business-date";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One funding and its whole history (product.md §13.2, AC-49, AC-50).
 *
 * Every figure is its own line: requested, approved (and each increase), each handover, each count
 * that disputed one, and the final receipt. Nothing is collapsed into a single amount, and each
 * line names who recorded it and when.
 */
export default async function FundingPage({ params }: PageProps<"/imprest/[id]">) {
  const viewer = await requireAccess("/imprest");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  // The Cashier reaches /imprest for spending only (issue #55). Funding is not theirs to follow.
  if (viewer.role === "cashier") notFound();

  const funding = await loadFunding(id);
  if (!funding) notFound();

  const t = await getTranslations("imprest");
  const locale = await getLocale();
  const money = (value: number | null) => (value === null ? t("detail.none") : formatTzs(value, locale));

  const figures: [string, string, string][] = [
    ["requested", t("detail.requested"), money(funding.requestedAmount)],
    ["approved", t("detail.approved"), money(funding.approvedAmount)],
    ["provided", t("detail.provided"), money(funding.providedAmount)],
    ["received", t("detail.received"), money(funding.receivedAmount)],
  ];

  return (
    <>
      <PageHeader
        title={funding.fundingNo}
        description={funding.reason}
        action={<FundingStatusChip status={funding.status} />}
      />

      <Link href="/imprest" className="text-sm underline underline-offset-4">
        {t("detail.back")}
      </Link>

      <Card>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="funding-figures">
          {figures.map(([key, label, value]) => (
            <div key={key} className="flex flex-col gap-1" data-testid={`figure-${key}`}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="fv-numeric font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        {funding.status === "disputed" && funding.disputedCounted !== null ? (
          <p className="mt-4 text-sm" data-testid="dispute-summary">
            {t("detail.disputed", {
              provided: money(funding.providedAmount),
              counted: money(funding.disputedCounted),
            })}
          </p>
        ) : null}
      </Card>

      <Card>
        <FundingActions funding={funding} role={viewer.role} />
        {funding.status === "provided" && viewer.role === "director" ? (
          <p className="text-sm text-muted-foreground">{t("detail.awaitingManager")}</p>
        ) : null}
        {funding.status === "disputed" && viewer.role === "manager" ? (
          <p className="text-sm text-muted-foreground">{t("detail.awaitingDirector")}</p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          {t("history.title")}
        </h2>
        <ol className="flex flex-col gap-2" data-testid="funding-history">
          {funding.events.map((event, index) => (
            <li key={index}>
              <Card className="flex flex-col gap-1">
                <span className="font-medium">{eventTitle(t, event, money)}</span>
                <span className="text-sm text-muted-foreground">
                  {event.by} · {formatBusinessStamp(event.at, locale)}
                </span>
                {"text" in event && event.text ? <span className="text-sm">{event.text}</span> : null}
              </Card>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function eventTitle(
  t: Awaited<ReturnType<typeof getTranslations<"imprest">>>,
  event: FundingEvent,
  money: (value: number | null) => string,
): string {
  switch (event.kind) {
    case "requested":
      return t("history.requested", { amount: money(event.amount) });
    case "approved":
      return event.sequence === 1
        ? t("history.approved", { amount: money(event.amount) })
        : t("history.increased", { amount: money(event.amount) });
    case "provided":
      return event.cycle === 1
        ? t("history.provided", { amount: money(event.amount) })
        : t("history.corrected", { amount: money(event.amount) });
    case "mismatch":
      return t(event.amount < event.provided ? "history.shortage" : "history.excess", {
        counted: money(event.amount),
        provided: money(event.provided),
      });
    case "rejected":
      return t("history.rejected");
    case "received":
      return t("history.received", { amount: money(event.amount) });
  }
}
