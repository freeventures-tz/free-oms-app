import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { Disbursement, DisbursementStatus, SpendingPosition } from "@/lib/imprest/disbursements";
import { openFor } from "@/lib/imprest/spending";
import type { Page } from "@/lib/settlement/settlement";
import { formatTzs } from "@/lib/money";
import { formatBusinessStamp } from "@/lib/time/business-date";

/**
 * Imprest spending on the imprest screen (issue #55): the figures, and the lists of disbursements.
 *
 * Every figure here is calculated by the database on each read, never typed and never stored
 * (AC-99). The Cashier is sent Free to approve alone, so the other two cannot be shown to them
 * even by mistake.
 */

const TONES = {
  proposed: "attention",
  approved: "neutral",
  rejected: "danger",
  withdrawn: "neutral",
  cancelled: "neutral",
} as const;

export async function DisbursementStatusChip({ status }: { status: DisbursementStatus }) {
  const t = await getTranslations("imprest.spending.status");
  return <StatusChip tone={TONES[status]}>{t(status)}</StatusChip>;
}

type Figure = { key: string; label: string; value: number; help: string; testId: string };

/**
 * Posted imprest funding keeps its released label and its `funding-total` hook; the two new
 * figures sit beside it. With no fund open there is nothing to calculate, which is said in words
 * rather than shown as zeros.
 */
export async function SpendingFigures({ position }: { position: SpendingPosition | null }) {
  const t = await getTranslations("imprest");
  const locale = await getLocale();

  if (!position) {
    return (
      <Card className="flex flex-col gap-1" data-testid="spending-figures">
        <p className="text-sm text-muted-foreground" data-testid="no-fund">
          {t("spending.figures.noFund")}
        </p>
      </Card>
    );
  }

  const figures: Figure[] = [];
  if (position.posted !== null) {
    figures.push({
      key: "posted",
      label: t("total.label"),
      value: position.posted,
      help: t("total.help"),
      testId: "funding-total",
    });
  }
  if (position.setAside !== null) {
    figures.push({
      key: "setAside",
      label: t("spending.figures.setAside"),
      value: position.setAside,
      help: t("spending.figures.setAsideHelp"),
      testId: "set-aside-total",
    });
  }
  figures.push({
    key: "free",
    label: t("spending.figures.free"),
    value: position.freeToApprove,
    help: t("spending.figures.freeHelp"),
    testId: "free-to-approve",
  });

  return (
    <Card data-testid="spending-figures">
      <h2 className="sr-only">{t("spending.figures.heading")}</h2>
      <dl className={`grid grid-cols-1 gap-4 ${figures.length > 1 ? "md:grid-cols-3" : ""}`}>
        {figures.map((f) => (
          <div key={f.key} className="flex flex-col gap-1" data-testid={f.testId}>
            <dt className="text-sm text-muted-foreground">{f.label}</dt>
            <dd className="fv-numeric text-2xl font-semibold">{formatTzs(f.value, locale)}</dd>
            <dd className="text-xs text-muted-foreground">{f.help}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * One list of disbursements. `showOpenFor` adds how long each approval has been open: approvals
 * do not expire in this release, so the age is shown instead (issue #55 AC 7).
 */
export async function DisbursementList({
  id,
  title,
  empty,
  page,
  param,
  showOpenFor = false,
  showProposer = true,
}: {
  id: string;
  title: string;
  empty: string;
  page: Page<Disbursement>;
  param: string;
  showOpenFor?: boolean;
  showProposer?: boolean;
}) {
  const t = await getTranslations("imprest.spending");
  const locale = await getLocale();
  const now = new Date();

  const age = (since: string) => {
    const { unit, count } = openFor(since, now);
    if (unit === "days") return t("lists.openDays", { count });
    if (unit === "hours") return t("lists.openHours", { count });
    return t("lists.openMinutes", { count });
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-heading`} data-testid={id}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {title}
      </h2>
      {page.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {page.rows.map((d) => (
            <li key={d.id}>
              <Link
                href={`/imprest/disbursements/${d.id}`}
                className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
                data-testid={`disbursement-${d.disbursementNo}`}
              >
                <Card className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{d.purpose}</span>
                    <span className="text-sm text-muted-foreground">
                      {d.disbursementNo} · {t(`category.${d.category}`)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {showProposer ? `${d.proposedBy} · ` : ""}
                      {formatBusinessStamp(d.proposedAt, locale)}
                    </span>
                  </div>
                  <div className="flex flex-col items-start gap-1 md:items-end">
                    <DisbursementStatusChip status={d.status} />
                    <span className="fv-numeric text-sm font-medium">{formatTzs(d.amount, locale)}</span>
                    {showOpenFor && d.status === "approved" && d.approvedAt ? (
                      <span className="text-xs text-muted-foreground" data-testid="open-for">
                        {age(d.approvedAt)}
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
        page={page.page}
        pageSize={page.pageSize}
        total={page.total}
        param={param}
        basePath="/imprest"
        label={title}
      />
    </section>
  );
}
