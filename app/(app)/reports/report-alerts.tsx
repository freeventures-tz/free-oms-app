import { TriangleAlert } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { formatBusinessDate } from "@/lib/time/business-date";
import type { ReportFailureAlert } from "@/lib/reports/alerts";

/**
 * A night with no report at all, said at the top of the archive (product.md §18, design.md §12.5).
 *
 * A SERVER COMPONENT, like the list below it. Nothing on this region is interactive — no state, no
 * effect, no handler, nothing that reacts to anything — so shipping it to the browser bought a
 * client bundle, a `NextIntlClientProvider` dependency and a hydration boundary in exchange for
 * nothing at all. It renders where its data already is.
 *
 * WHY IT IS ABOVE THE LIST AND NOT IN IT. A missing report has no card, because there is no report:
 * the archive below is a list of what exists, and a reader scanning it for last night would find
 * yesterday simply absent and conclude nothing happened. The absence has to be stated where it
 * cannot be scrolled past.
 *
 * THREE CHANNELS, NOT ONE (design.md §11.5). A triangle, the words "not written", and the danger
 * tone. The colour is the last of the three and carries nothing on its own — this is read on a
 * phone in a yard, in daylight, by whoever is awake, and one of them will be colour-blind.
 *
 * IT SAYS WHICH NIGHT, ALWAYS. "A report failed" is not actionable; "Friday 28 August has no
 * report" is. The date is formatted the same way the archive cards format theirs, so the two agree
 * on how a business day is written.
 *
 * THERE IS NO CONTROL ON IT. No Retry, no Generate, no dismiss — issue #19 gives the application
 * none of those, and a button that only looked like one would be the worst thing on this screen: a
 * Director tapping it and being told nothing happened would reasonably conclude the report was on
 * its way. The alert is a statement of fact and it stays until the night it names has a report.
 *
 * `role="alert"`, WHICH IS THIS PROJECT'S ASSERTIVE SEMANTICS. `FormError`, `FieldError` and the
 * shell's own `error.tsx` all use it, and `FormSuccess` and `Skeleton` use the polite `role=
 * "status"` — the split is by whether the message is a failure, not by when it arrived. An earlier
 * version reasoned from arrival time and chose `status`, which put the one region on this screen
 * that reports a business failure into the same politeness class as a loading skeleton. A screen
 * reader user should not have to reach this by exploration: the business has no record of a day's
 * trading, and that interrupts.
 */
export async function ReportFailureAlerts({ alerts }: { alerts: ReportFailureAlert[] }) {
  if (alerts.length === 0) return null;

  const t = await getTranslations("reports.failureAlert");
  const locale = await getLocale();

  return (
    <section
      role="alert"
      aria-labelledby="missing-report-alerts-heading"
      data-testid="missing-report-alerts"
      className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 md:p-5 xl:p-6"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <h2 id="missing-report-alerts-heading" className="font-semibold text-danger">
            {t("heading")}
          </h2>
          <p className="text-sm text-foreground">{t("priority")}</p>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {alerts.map((alert) => (
          <li
            key={alert.id}
            data-testid={`missing-report-alert-${alert.businessDate}`}
            className="flex flex-col gap-1"
          >
            <span className="font-medium">
              {t("missingDate", { date: formatBusinessDate(alert.businessDate, locale) })}
            </span>
            <span className="text-sm text-muted-foreground">{t("everyAttemptFailed")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
