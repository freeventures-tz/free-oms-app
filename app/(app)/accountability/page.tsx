import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { DecisionQueue } from "@/app/(app)/accountability/decision-queue";
import { Card, PageHeader } from "@/components/ui/surface";
import { loadAccountabilityQueue } from "@/lib/accountability/decisions";
import { requireAccess } from "@/lib/auth/guard";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";

/**
 * Accountability decisions (issue #84, design.md §7B.10). Directors only: the route, the navigation
 * and the database all name the same role.
 *
 * Every imprest unexplained loss and confirmed count shortage waits here until a Director records
 * who is accountable. The screen says, before the form and inside it, that a decision has no
 * payroll effect (product.md §15).
 */
export default async function AccountabilityPage() {
  await requireAccess("/accountability");
  const t = await getTranslations("accountability");
  const locale = await getLocale();
  const queue = await loadAccountabilityQueue();

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />

      <DecisionQueue undecided={queue.undecided} staff={queue.staff} />

      <section className="flex flex-col gap-3" aria-labelledby="decided-heading" data-testid="decided">
        <h2 id="decided-heading" className="text-lg font-semibold">
          {t("decided.title")}
        </h2>
        {queue.decided.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("decided.empty")}</p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {queue.decided.map((d) => (
              <li key={d.id}>
                <Card className="flex flex-col gap-2" data-testid="decision">
                  <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
                    <span className="font-medium">{t(`subject.${d.subjectType}`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("decided.by", { name: d.decidedBy, when: formatBusinessStamp(d.decidedAt, locale) })}
                    </span>
                  </div>
                  <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted-foreground">
                    <span className="break-words">
                      {d.disbursementId ? (
                        <Link className="underline" href={`/imprest/disbursements/${d.disbursementId}`}>
                          {d.disbursementNo}
                        </Link>
                      ) : d.businessDate ? (
                        t("decided.countOf", { date: formatBusinessDate(d.businessDate, locale) })
                      ) : null}
                    </span>
                    <span className="fv-numeric font-semibold text-foreground">{formatTzs(d.amount, locale)}</span>
                  </p>
                  <p className="text-sm whitespace-pre-line break-words">{d.decision}</p>
                  <p className="text-sm text-muted-foreground">
                    {d.nobodyIdentified
                      ? t("decided.nobody")
                      : t("decided.responsible", { names: d.responsible.map((s) => s.name).join(", ") })}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
