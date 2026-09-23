"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { IntegrityChip } from "@/app/(app)/reports/report-chips";
import { Card } from "@/components/ui/surface";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";
import type { ReportSummary } from "@/lib/reports/reports";

/**
 * The archive: one card per business day, newest first (design.md §3.5, §7.21).
 *
 * THE ORDER OF A CARD IS §7.21'S: date, then delivery, then the integrity finding. Delivery leads
 * because it is the thing a Director would act on (§13.1) — and because a report nobody received is
 * a different failure from a report that reads oddly.
 *
 * The integrity chip carries a shape and a word as well as a tone (§11.5). A column of cards read
 * on a phone is scanned as a column of colours, and this is the one chip in the system whose
 * meaning is a warning — so the shield says it before any of the text is read, and it still says it
 * to a reader who cannot separate red from green.
 *
 * "No reports yet" is only ever reached with a successful, genuinely empty read: `loadReportSummaries`
 * throws on a failed one, and the shell's error boundary says so instead (§12.5, §12.7 rule 7).
 */
export function ReportList({ reports }: { reports: ReportSummary[] }) {
  const t = useTranslations("reports");
  const locale = useLocale();

  if (reports.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="fv-numeric text-sm text-muted-foreground">
        {t("count", { count: reports.length })}
      </p>

      <div className="flex flex-col gap-3">
        {reports.map((report) => (
          <Card key={report.runId} role="article" aria-label={report.businessDate}>
            <Link
              href={`/reports/${report.runId}`}
              data-testid={`report-${report.businessDate}`}
              className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium">
                  {formatBusinessDate(report.businessDate, locale)}
                </span>
                <span className="fv-numeric text-sm text-muted-foreground">
                  {t("deliveredTo", { count: report.recipientCount })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t("generatedAt")}: {formatBusinessStamp(report.generatedAt, locale)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <IntegrityChip integrity={report.integrity} />
                <span className="text-sm font-medium text-primary">{t("open")}</span>
              </div>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
