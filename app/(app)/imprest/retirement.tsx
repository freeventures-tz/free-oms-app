import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { DecideRetirement, SubmitRetirement } from "@/app/(app)/imprest/retirement-forms";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { AppRole } from "@/lib/auth/roles";
import {
  deficitOf,
  type FundState,
  type RetiredFund,
  type RetirementBlocker,
  type Unresolved,
} from "@/lib/imprest/retirement";
import type { Page } from "@/lib/settlement/settlement";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";

/**
 * Retirement on the imprest screen (product.md §13.8, design.md §7B.12, issue #72).
 *
 * The Manager submits; a Director approves or rejects. Whatever the fund still carries unresolved is
 * shown FIRST, above the figures, with the words that retirement does not resolve it. A deficit is
 * the unexplained losses and count shortages in full; a count excess is shown beside it and never
 * subtracted. Every figure is the database's.
 */

function blockerHref(b: RetirementBlocker): string {
  if (b.kind === "funding") return `/imprest/${b.id}`;
  if (b.kind === "count") return "/imprest#daily-count";
  return `/imprest/disbursements/${b.id}`;
}

/** What retirement leaves as it is: the deficit, each loss and shortage, and the Not counted days. */
export async function UnresolvedItems({ unresolved, testId = "retirement-unresolved" }: { unresolved: Unresolved; testId?: string }) {
  const t = await getTranslations("imprest.retirement.unresolved");
  const locale = await getLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  const deficit = deficitOf(unresolved);
  const empty =
    unresolved.losses.length === 0 &&
    unresolved.shortages.length === 0 &&
    unresolved.notCountedDays.length === 0 &&
    unresolved.excesses === 0;

  if (empty) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-none`}>
        {t("none")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-danger/40 p-4" data-testid={testId} role="region" aria-label={t("title")}>
      <div className="flex items-center gap-2">
        <TriangleAlert aria-hidden className="size-4 text-danger" />
        <h3 className="font-semibold">{t("title")}</h3>
      </div>
      <p className="text-sm">{t("notResolved")}</p>
      {deficit > 0 ? (
        <p className="fv-numeric text-lg font-semibold text-danger" data-testid={`${testId}-deficit`}>
          {t("deficit", { amount: tzs(deficit) })}
        </p>
      ) : null}
      {unresolved.losses.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("losses", { count: unresolved.losses.length })}</h4>
          <ul className="flex flex-col gap-1 text-sm" data-testid={`${testId}-losses`}>
            {unresolved.losses.map((l) => (
              <li key={l.postingId}>
                <Link href={`/imprest/disbursements/${l.disbursementId}`} className="underline underline-offset-4">
                  {l.disbursementNo}
                </Link>{" "}
                <span className="fv-numeric">{tzs(l.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {unresolved.shortages.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("shortages", { count: unresolved.shortages.length })}</h4>
          <ul className="flex flex-col gap-1 text-sm" data-testid={`${testId}-shortages`}>
            {unresolved.shortages.map((s) => (
              <li key={s.countId}>
                {formatBusinessDate(s.businessDate, locale)} <span className="fv-numeric">{tzs(s.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {unresolved.excesses > 0 ? (
        <p className="fv-numeric text-sm" data-testid={`${testId}-excess`}>
          {t("excess", { amount: tzs(unresolved.excesses) })}
        </p>
      ) : null}
      {unresolved.notCountedDays.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("notCounted", { count: unresolved.notCountedDays.length })}</h4>
          <p className="text-sm" data-testid={`${testId}-not-counted`}>
            {unresolved.notCountedDays.map((d) => formatBusinessDate(d, locale)).join(", ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The balance carried into the active fund, shown until it is retired in turn. */
export async function CarriedBalance({ opening }: { opening: NonNullable<FundState["opening"]> }) {
  const t = await getTranslations("imprest.retirement");
  const locale = await getLocale();
  return (
    <Card className="flex flex-col gap-1" data-testid="carried-balance">
      <span className="text-sm text-muted-foreground">{t("carried.label")}</span>
      <span className="fv-numeric text-xl font-semibold">{formatTzs(opening.amount, locale)}</span>
      <span className="text-sm">
        {t("carried.help", { date: formatBusinessStamp(opening.retiredAt, locale) })}{" "}
        <Link href={`/imprest/funds/${opening.fromFundId}`} className="underline underline-offset-4">
          {t("carried.open")}
        </Link>
      </span>
    </Card>
  );
}

export async function RetirementSection({ role, state }: { role: AppRole; state: FundState }) {
  const t = await getTranslations("imprest.retirement");
  const locale = await getLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  const readiness = state.readiness;
  const open = state.retirement;
  if (!readiness) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="retirement-heading" data-testid="retirement">
      <h2 id="retirement-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <Card className="flex flex-col gap-4">
        {open ? (
          <div className="flex flex-col gap-4" data-testid="retirement-open">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <span className="text-sm">
                {t("submittedBy", { name: open.submittedBy, when: formatBusinessStamp(open.submittedAt, locale) })}
              </span>
              <StatusChip tone="attention">
                <span data-testid="retirement-status">{t("waiting")}</span>
              </StatusChip>
            </div>
            <UnresolvedItems unresolved={{ ...readiness.unresolved, notCountedDays: open.notCountedDays }} />
            <p className="text-sm" data-testid="retirement-reason">
              {t("reasonLine", { reason: open.reason })}
            </p>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="retirement-figures">
              <div className="flex flex-col gap-0.5">
                <dt className="text-sm text-muted-foreground">{t("figures.funding")}</dt>
                <dd className="fv-numeric text-lg font-semibold">{tzs(open.postedFunding)}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-sm text-muted-foreground">{t("figures.counted", { date: formatBusinessDate(open.businessDate, locale) })}</dt>
                <dd className="fv-numeric text-lg font-semibold">{tzs(open.count.counted)}</dd>
              </div>
              <div className="flex flex-col gap-0.5" data-testid="retirement-closing">
                <dt className="text-sm text-muted-foreground">{t("figures.closing")}</dt>
                <dd className="fv-numeric text-lg font-semibold">{tzs(open.closingBalance)}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">{t("carryHelp", { amount: tzs(open.closingBalance) })}</p>
            {role === "director" ? (
              <DecideRetirement retirement={{ id: open.id, version: open.version }} />
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="retirement-waiting-manager">
                {t("waitingManager")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4" data-testid="retirement-readiness">
            <p className="text-sm">{t(role === "manager" ? "help.manager" : "help.director")}</p>
            {state.lastRejected ? (
              <p className="text-sm" data-testid="retirement-rejected">
                {t("rejected", {
                  name: state.lastRejected.decidedBy,
                  when: formatBusinessStamp(state.lastRejected.decidedAt, locale),
                  reason: state.lastRejected.reason,
                })}
              </p>
            ) : null}
            <UnresolvedItems unresolved={readiness.unresolved} />
            {readiness.blockers.length > 0 ? (
              <div className="flex flex-col gap-1" data-testid="retirement-blockers">
                <h3 className="font-semibold">{t("blockers.title", { count: readiness.blockers.length })}</h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {readiness.blockers.map((b) => (
                    <li key={`${b.kind}-${b.id}`} data-testid={`blocker-${b.kind}`}>
                      <Link href={blockerHref(b)} className="underline underline-offset-4">
                        {b.kind === "count" ? formatBusinessDate(b.number, locale) : b.number}
                      </Link>{" "}
                      {t(`blockers.${b.kind}`)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-sm" data-testid="retirement-count">
              {readiness.count === null || readiness.count.status !== "confirmed"
                ? t("count.required")
                : readiness.count.closesFund
                  ? t("count.ready", { amount: tzs(readiness.count.counted) })
                  : t("count.beforeLastPosting")}
            </p>
            {role === "manager" &&
            readiness.blockers.length === 0 &&
            readiness.count?.status === "confirmed" &&
            readiness.count.closesFund ? (
              <SubmitRetirement countId={readiness.count.id} />
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}

export async function RetiredFundsList({
  page,
  otherParams,
}: {
  page: Page<RetiredFund>;
  otherParams: Record<string, number>;
}) {
  const t = await getTranslations("imprest.retirement.retired");
  const locale = await getLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="retired-heading" data-testid="retired-funds">
      <h2 id="retired-heading" className="text-lg font-semibold">
        {t("title", { count: page.total })}
      </h2>
      {page.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {page.rows.map((f) => {
            const deficit = f.lossesWaitingAmount + f.shortagesWaitingAmount;
            return (
              <li key={f.fundId}>
                <Link
                  href={`/imprest/funds/${f.fundId}`}
                  className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
                  data-testid={`retired-fund-${f.fundId}`}
                >
                  <Card className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">
                        {t("dates", {
                          opened: formatBusinessStamp(f.openedAt, locale),
                          retired: formatBusinessStamp(f.retiredAt, locale),
                        })}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t("people", { submitted: f.submittedBy, approved: f.approvedBy })}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {deficit > 0 ? (
                          <StatusChip tone="danger">{t("deficit", { amount: tzs(deficit) })}</StatusChip>
                        ) : null}
                        {f.lossesWaiting > 0 ? (
                          <StatusChip tone="attention">{t("losses", { count: f.lossesWaiting })}</StatusChip>
                        ) : null}
                        {f.shortagesWaiting > 0 ? (
                          <StatusChip tone="attention">{t("shortages", { count: f.shortagesWaiting })}</StatusChip>
                        ) : null}
                        {f.notCountedDays > 0 ? (
                          <StatusChip tone="danger">{t("notCounted", { count: f.notCountedDays })}</StatusChip>
                        ) : null}
                        {deficit === 0 && f.notCountedDays === 0 ? (
                          <StatusChip tone="success">{t("clear")}</StatusChip>
                        ) : null}
                      </span>
                    </div>
                    <span className="fv-numeric text-sm font-medium" data-testid="retired-closing">
                      {t("closing", { amount: tzs(f.closingBalance) })}
                    </span>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        page={page.page}
        pageSize={page.pageSize}
        total={page.total}
        param="retired"
        basePath="/imprest"
        label={t("title", { count: page.total })}
        otherParams={otherParams}
      />
    </section>
  );
}
