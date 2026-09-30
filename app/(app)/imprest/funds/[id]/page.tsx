import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { CountStateChip } from "@/app/(app)/imprest/daily-count";
import { UnresolvedItems } from "@/app/(app)/imprest/retirement";
import { Card, PageHeader, StatusChip } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadFundRecord } from "@/lib/imprest/retirement";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One imprest fund's whole record, read-only (product.md §13.8, design.md §7B.12, issue #72).
 *
 * What the fund still carries unresolved comes first, with the words that retirement does not
 * resolve it. Then the figures in the order design.md gives them, every retirement submitted, the
 * days, counts, fundings and postings. Nothing here can be changed: a retired fund takes no new row.
 */
export default async function FundRecordPage({ params }: PageProps<"/imprest/funds/[id]">) {
  const viewer = await requireAccess("/imprest");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  // The closing and opening balances are posted figures, which the Cashier is not shown.
  if (viewer.role === "cashier") notFound();

  const record = await loadFundRecord(id);
  if (!record) notFound();

  const t = await getTranslations("imprest.fundRecord");
  const r = await getTranslations("imprest.retirement");
  const locale = await getLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  const f = record.figures;

  const figures: [string, string, string][] = [
    ["opening", t("figures.opening"), tzs(f.opening)],
    ["funding", t("figures.funding"), tzs(f.postedFunding)],
    ["expenses", t("figures.expenses"), tzs(f.expenses)],
    ["losses", t("figures.losses"), tzs(f.losses)],
    ["shortages", t("figures.shortages"), tzs(f.shortages)],
    ["excesses", t("figures.excesses"), tzs(f.excesses)],
    ["closing", t(record.isActive ? "figures.balance" : "figures.closing"), tzs(f.postedBalance)],
  ];

  return (
    <>
      <PageHeader
        title={record.retiredAt ? t("titleRetired", { date: stamp(record.retiredAt) }) : t("titleActive")}
        description={t("description", { opened: stamp(record.openedAt) })}
        action={
          <StatusChip tone={record.isActive ? "neutral" : "attention"}>
            <span data-testid="fund-status">{t(record.isActive ? "active" : "retired")}</span>
          </StatusChip>
        }
      />

      <Link href="/imprest" className="text-sm underline underline-offset-4">
        {t("back")}
      </Link>

      <Card className="flex flex-col gap-3">
        <UnresolvedItems unresolved={record.unresolved} testId="fund-unresolved" />
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("figures.title")}</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="fund-figures">
          {figures.map(([key, label, value]) => (
            <div key={key} className="flex flex-col gap-1" data-testid={`fund-figure-${key}`}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="fv-numeric font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        {record.carriedFrom ? (
          <p className="text-sm">
            {t("carriedFrom", { amount: tzs(record.carriedFrom.amount) })}{" "}
            <Link href={`/imprest/funds/${record.carriedFrom.fundId}`} className="underline underline-offset-4">
              {t("openFund")}
            </Link>
          </p>
        ) : null}
        {record.carriedInto ? (
          <p className="text-sm" data-testid="fund-carried-into">
            {t("carriedInto", { amount: tzs(record.carriedInto.amount), when: stamp(record.carriedInto.postedAt) })}
          </p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="fund-retirements">
        <h2 id="fund-retirements" className="text-lg font-semibold">
          {t("retirements")}
        </h2>
        {record.retirements.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noRetirement")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {record.retirements.map((x) => (
              <li key={x.id} data-testid={`fund-retirement-${x.status}`}>
                <Card className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="text-sm">{r("submittedBy", { name: x.submittedBy, when: stamp(x.submittedAt) })}</span>
                    <StatusChip tone={x.status === "approved" ? "success" : x.status === "rejected" ? "danger" : "attention"}>
                      {t(`status.${x.status}`)}
                    </StatusChip>
                  </div>
                  <p className="text-sm">{r("reasonLine", { reason: x.reason })}</p>
                  <p className="fv-numeric text-sm">
                    {t("closingAt", { amount: tzs(x.closingBalance), date: formatBusinessDate(x.businessDate, locale) })}
                  </p>
                  {x.notCountedDays.length > 0 ? (
                    <p className="text-sm">
                      {t("listedNotCounted", {
                        days: x.notCountedDays.map((d) => formatBusinessDate(d, locale)).join(", "),
                      })}
                    </p>
                  ) : null}
                  {x.decidedBy && x.decidedAt ? (
                    <p className="text-sm">
                      {x.status === "rejected"
                        ? t("rejectedBy", { name: x.decidedBy, when: stamp(x.decidedAt), reason: x.rejectionReason ?? "" })
                        : t("approvedBy", { name: x.decidedBy, when: stamp(x.decidedAt) })}
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="fund-days">
        <h2 id="fund-days" className="text-lg font-semibold">
          {t("days")}
        </h2>
        {record.days.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noDays")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="fund-days">
            {record.days.map((d) => (
              <li key={d.businessDate} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                {formatBusinessDate(d.businessDate, locale)} <CountStateChip state={d.state} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="fund-counts">
        <h2 id="fund-counts" className="text-lg font-semibold">
          {t("counts")}
        </h2>
        {record.counts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCounts")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="fund-counts">
            {record.counts.map((c) => (
              <li key={c.id}>
                <Card className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <span className="text-sm">
                    {t("countLine", {
                      date: formatBusinessDate(c.businessDate, locale),
                      attempt: c.attempt,
                      name: c.countedBy,
                    })}
                    {c.lateReason ? ` ${t("late", { reason: c.lateReason })}` : ""}
                  </span>
                  <span className="fv-numeric text-sm">
                    {t("countFigures", { counted: tzs(c.counted), expected: tzs(c.expected) })}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="fund-fundings">
        <h2 id="fund-fundings" className="text-lg font-semibold">
          {t("fundings")}
        </h2>
        {record.fundings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noFundings")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="fund-fundings">
            {record.fundings.map((x) => (
              <li key={x.id}>
                <Link href={`/imprest/${x.id}`} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2">
                  <Card className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="text-sm font-medium">{x.fundingNo}</span>
                    <span className="fv-numeric text-sm">
                      {x.received === null
                        ? t("fundingRequested", { amount: tzs(x.requested) })
                        : t("fundingReceived", { amount: tzs(x.received) })}
                    </span>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="fund-postings">
        <h2 id="fund-postings" className="text-lg font-semibold">
          {t("postings")}
        </h2>
        {record.postings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noPostings")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="fund-postings">
            {record.postings.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 text-sm md:flex-row md:items-center md:justify-between">
                <span>
                  <Link href={`/imprest/disbursements/${p.disbursementId}`} className="underline underline-offset-4">
                    {p.disbursementNo}
                  </Link>{" "}
                  {t(`posting.${p.kind}.${p.entry}`)} · {stamp(p.postedAt)}
                </span>
                <span className="fv-numeric">{tzs(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
