import { notFound } from "next/navigation";

import { ReportView } from "@/app/(app)/reports/[id]/report-view";
import { requireAccess } from "@/lib/auth/guard";
import { loadReport } from "@/lib/reports/reports";

/**
 * One day's report, as it was written (product.md §18.3).
 *
 * Everything on the screen comes out of the stored snapshot. Nothing is recomputed from live data,
 * which is the whole point of a snapshot: a report read months later shows the business as it was
 * that night, and a correction made since produces an amended VERSION rather than quietly editing
 * this one.
 */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("/reports");
  const { id } = await params;

  const report = await loadReport(id);

  // A genuine absence, not a failed read: `loadReport` throws for the second, so this is safe to
  // treat as "there is no such report" rather than as "we could not find out".
  if (!report) notFound();

  return <ReportView report={report} />;
}
