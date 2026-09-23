import { integrityOf, type ReportIntegrity } from "@/lib/reports/integrity";
import { requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Reading the daily reports the database writes for itself (product.md §18).
 *
 * There is no write path here and there is no command module beside it, because the application
 * never generates a report: `private.run_scheduled_report(attempt)` does, at 00:01 Africa/Dar_es_Salaam,
 * and it is not reachable through the Data API at all. Everything in this file reads.
 *
 * READS GO THROUGH THE CALLER'S OWN SESSION, like every other list in this application. The
 * `daily_reports` view is `security_invoker`, so the policies on the underlying records decide what
 * comes back: a Cashier or a Sales Representative signed in and asking for a report gets an empty
 * answer from the database itself, whatever the route guard did or failed to do.
 *
 * A FAILED READ IS NOT AN EMPTY ARCHIVE. `requireRows` throws so the shell's error boundary can say
 * the system could not be reached, rather than rendering "no reports yet" during an outage — which
 * would tell a Director the business produced nothing last night.
 */

export type { ReportIntegrity };

/**
 * Who a report was produced for (§18.1). In-app only; there is no address anywhere.
 *
 * `id` IS THE RECIPIENT, and the name is only what they are called. Two colleagues can share a
 * name, and one of them can be renamed; `report_deliveries` is keyed on `(snapshot_id,
 * recipient_id)` for exactly that reason, so the screen carries the same identity the database
 * does rather than inventing a weaker one out of the display text.
 */
export type ReportRecipient = { id: string; name: string; role: AppRole };

export type ReportSummary = {
  runId: string;
  businessDate: string;
  generatedAt: string;
  integrity: ReportIntegrity;
  /** Delivery is what design.md §13.1 asks the list to lead with, so the list carries it. */
  recipientCount: number;
};

export type ReportDetail = Omit<ReportSummary, "recipientCount"> & {
  contentSha256: string;
  content: unknown;
  recipients: ReportRecipient[];
};

/** PostgREST answers a malformed uuid with an error; a wrong link is a 404, not an outage. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `profiles` embed arrives as an object or a one-element array depending on the relationship. */
function personName(embedded: unknown): string {
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  const name = (row as { full_name?: unknown } | null)?.full_name;
  return typeof name === "string" ? name : "";
}

export async function loadReportSummaries(limit = 60): Promise<ReportSummary[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("daily_reports")
      .select("run_id, business_date, generated_at, integrity_ok, snapshot_id")
      .order("business_date", { ascending: false })
      .limit(limit),
    "reports.list",
  );

  // Counted in one further read rather than one per card. Both reads are refused identically to a
  // role that may not see a report, so an empty archive stays empty rather than half-populated.
  const deliveries = requireRows(
    await supabase
      .from("report_deliveries")
      .select("snapshot_id")
      .in("snapshot_id", rows.map((row) => String(row.snapshot_id))),
    "reports.deliveryCounts",
  );

  const counts = new Map<string, number>();
  for (const delivery of deliveries) {
    const key = String(delivery.snapshot_id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return rows.map((row) => ({
    runId: String(row.run_id),
    businessDate: String(row.business_date),
    generatedAt: String(row.generated_at),
    integrity: integrityOf(row.integrity_ok),
    recipientCount: counts.get(String(row.snapshot_id)) ?? 0,
  }));
}

/** One report, or `null` when there is no such report — which is different from a failed read. */
export async function loadReport(runId: string): Promise<ReportDetail | null> {
  if (!UUID.test(runId)) return null;

  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("daily_reports")
      .select("run_id, business_date, generated_at, integrity_ok, snapshot_id, content_sha256, content")
      .eq("run_id", runId)
      .limit(1),
    "reports.detail",
  );

  const row = rows[0];
  if (!row) return null;

  const deliveries = requireRows(
    await supabase
      .from("report_deliveries")
      .select("recipient_id, recipient_role, profiles!inner(full_name)")
      .eq("snapshot_id", String(row.snapshot_id)),
    "reports.deliveries",
  );

  return {
    runId: String(row.run_id),
    businessDate: String(row.business_date),
    generatedAt: String(row.generated_at),
    integrity: integrityOf(row.integrity_ok),
    contentSha256: String(row.content_sha256),
    content: row.content,
    recipients: deliveries
      .map((delivery) => ({
        id: String(delivery.recipient_id),
        name: personName(delivery.profiles),
        role: delivery.recipient_role as AppRole,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
