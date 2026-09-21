import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { RequestFundingForm } from "@/app/(app)/imprest/funding-forms";
import { FundingStatusChip } from "@/app/(app)/imprest/funding-status";
import { Pager } from "@/components/ui/pager";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadFundingPosition, loadFundings } from "@/lib/imprest/funding";
import { formatTzs } from "@/lib/money";
import { pageNumber } from "@/lib/settlement/settlement";
import { formatBusinessStamp } from "@/lib/time/business-date";

/**
 * Imprest funding (product.md §13.2, issue #48).
 *
 * The Manager requests and confirms; a Director decides, provides and corrects. Both reach this
 * route. A Cashier's imprest work is spending, which is not built, so the route is not offered to
 * them yet even though the read policy would allow it.
 *
 * The total is posted funding: confirmed receipts only. It is labelled as exactly that, because a
 * reader could otherwise take it for the cash in the tin or for what may be spent.
 */
export default async function ImprestPage({ searchParams }: PageProps<"/imprest">) {
  const viewer = await requireAccess("/imprest");
  const t = await getTranslations("imprest");
  const locale = await getLocale();
  const page = pageNumber((await searchParams).page);

  const [posted, fundings] = await Promise.all([loadFundingPosition(), loadFundings(page)]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />

      <Card className="flex flex-col gap-1" data-testid="funding-total">
        <p className="text-sm text-muted-foreground">{t("total.label")}</p>
        <p className="fv-numeric text-2xl font-semibold">{formatTzs(posted ?? 0, locale)}</p>
        <p className="text-xs text-muted-foreground">
          {posted === null ? t("total.noFund") : t("total.help")}
        </p>
      </Card>

      {viewer.role === "manager" ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("request.title")}</h2>
          <RequestFundingForm />
        </Card>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="funding-list-heading">
        <h2 id="funding-list-heading" className="text-lg font-semibold">
          {t("list.title")}
        </h2>
        {fundings.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {fundings.rows.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/imprest/${f.id}`}
                  className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
                  data-testid={`funding-${f.fundingNo}`}
                >
                  <Card className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{f.fundingNo}</span>
                      <span className="text-sm text-muted-foreground">
                        {f.requestedBy} · {formatBusinessStamp(f.requestedAt, locale)}
                      </span>
                      <span className="text-sm">{f.reason}</span>
                    </div>
                    <div className="flex flex-col items-start gap-1 md:items-end">
                      <FundingStatusChip status={f.status} />
                      <span className="fv-numeric text-sm">
                        {t("list.requested", { amount: formatTzs(f.requestedAmount, locale) })}
                      </span>
                      {f.receivedAmount !== null ? (
                        <span className="fv-numeric text-sm font-medium">
                          {t("list.received", { amount: formatTzs(f.receivedAmount, locale) })}
                        </span>
                      ) : null}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={fundings.page}
          pageSize={fundings.pageSize}
          total={fundings.total}
          param="page"
          basePath="/imprest"
          label={t("list.title")}
        />
      </section>
    </>
  );
}
