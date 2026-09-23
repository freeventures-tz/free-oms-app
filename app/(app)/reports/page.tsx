import { getTranslations } from "next-intl/server";

import { ReportFailureAlerts } from "@/app/(app)/reports/report-alerts";
import { ReportList } from "@/app/(app)/reports/report-list";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadReportFailureAlerts } from "@/lib/reports/alerts";
import { loadReportSummaries } from "@/lib/reports/reports";

/**
 * Daily reports (product.md §18).
 *
 * NOBODY WORKS THIS SCREEN. It has no control on it at all, because there is nothing here to
 * decide: the report was written by the database at 00:01 and cannot be changed, re-run or removed
 * from the application. §18.1 names its readers — both Directors and the Manager — and the route,
 * the navigation and the database policies all name the same two.
 *
 * A NIGHT WITH NO REPORT IS STATED BEFORE THE ONES THAT HAVE ONE. The archive lists what exists,
 * so a business date whose four scheduled attempts all failed would otherwise be a silent gap in a
 * list of dates. The alerts read first and render first, and both reads throw rather than return
 * nothing when the database cannot be reached — so an outage is one page-level failure, not a
 * reassuring empty archive above a reassuring absence of warnings.
 */
export default async function ReportsPage() {
  await requireAccess("/reports");
  const t = await getTranslations("reports");

  // Both at once, and both throw. `Promise.all` rejects on the first failure, so an outage that
  // breaks either read reaches the error boundary rather than half-rendering the page.
  const [alerts, reports] = await Promise.all([loadReportFailureAlerts(), loadReportSummaries()]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <ReportFailureAlerts alerts={alerts} />
      <ReportList reports={reports} />
    </>
  );
}
