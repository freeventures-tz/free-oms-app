import { integrityOf, type ReportIntegrity } from "@/lib/reports/integrity";
import {
  DATA_UNAVAILABLE,
  requireRows,
  type QueryResult,
} from "@/lib/supabase/query";
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

/**
 * The most delivery rows one request asks for: `max_rows` in `supabase/config.toml`, as for the
 * alert list. It sets how many rows travel per round trip and nothing more; the exact count decides
 * when the read is finished (see `readDeliveries`).
 */
export const DELIVERY_PAGE_SIZE = 1000;

type DeliveryCursor = { snapshotId: string; recipientId: string };
type DeliveryRow = Record<string, unknown> & {
  snapshot_id: string;
  recipient_id: string;
};

/**
 * Every delivery of the given snapshots that the caller may see, in pages.
 *
 * ONE UNPAGED READ WAS SHORT WITHOUT SAYING SO. PostgREST answers at most `max_rows` rows with HTTP
 * 200 and no error, so 60 reports with 17 recipients each came back as 1,000 of 1,020 rows, and the
 * cards past the cut read 14 and 0 recipients. The same three rules as `loadReportFailureAlerts`
 * make this read trustworthy instead:
 *
 *   1. KEYSET on `(snapshot_id, recipient_id)`, which the table holds unique, so a page boundary can
 *      neither skip a delivery nor repeat one.
 *   2. THE EXACT COUNT DECIDES COMPLETION, never a page that merely looks short — a lowered API cap
 *      makes every page short.
 *   3. ANY DOUBT FAILS THE WHOLE READ: a refused page, a missing count, an empty page while rows
 *      remain, a row out of order, repeated, or without real ids. A partial count is never shown
 *      as a whole one.
 *
 * The caller's own session still does the reading, so RLS decides what "every delivery" means.
 */
async function readDeliveries(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  snapshotIds: string[],
  columns: string,
  what: string,
): Promise<DeliveryRow[]> {
  function fail(detail: string): never {
    console.error(`[data] ${what} ${detail}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }

  // Every id reaches a filter below, so none is used before it is known to be a uuid.
  if (!snapshotIds.every((id) => UUID.test(id))) fail("was asked for a snapshot id that is not a uuid");
  if (snapshotIds.length === 0) return [];

  const rows: DeliveryRow[] = [];
  let cursor: DeliveryCursor | null = null;

  for (;;) {
    let query = supabase
      .from("report_deliveries")
      .select(["snapshot_id", "recipient_id", columns].filter(Boolean).join(", "), { count: "exact" })
      .in("snapshot_id", snapshotIds)
      .order("snapshot_id", { ascending: true })
      .order("recipient_id", { ascending: true })
      .limit(DELIVERY_PAGE_SIZE);

    if (cursor) {
      query = query.or(
        `snapshot_id.gt.${cursor.snapshotId},` +
          `and(snapshot_id.eq.${cursor.snapshotId},recipient_id.gt.${cursor.recipientId})`,
      );
    }

    const result = await query;
    const page = requireRows(result as QueryResult<Record<string, unknown>>, what);
    const remaining = result.count;

    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0) {
      fail("returned a page without an exact count");
    }
    if (page.length > remaining || (page.length === 0 && remaining > 0)) {
      fail(`returned ${page.length} rows against a count of ${remaining}`);
    }

    for (const row of page) {
      const snapshotId = row.snapshot_id;
      const recipientId = row.recipient_id;
      if (typeof snapshotId !== "string" || !UUID.test(snapshotId)) fail("returned a row without a snapshot id");
      if (typeof recipientId !== "string" || !UUID.test(recipientId)) fail("returned a row without a recipient id");

      // Postgres orders a uuid by its bytes, which is the order of its lower-case hex text.
      const next = { snapshotId: snapshotId.toLowerCase(), recipientId: recipientId.toLowerCase() };
      if (
        cursor &&
        !(next.snapshotId > cursor.snapshotId ||
          (next.snapshotId === cursor.snapshotId && next.recipientId > cursor.recipientId))
      ) {
        fail("returned a row out of order or twice");
      }

      rows.push({ ...row, snapshot_id: snapshotId, recipient_id: recipientId });
      cursor = next;
    }

    if (page.length === remaining) return rows;
  }
}

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

  // Counted in one further read rather than one per card, paged so that no card is short (see
  // `readDeliveries`). Both reads are refused identically to a role that may not see a report, so an
  // empty archive stays empty rather than half-populated.
  const deliveries = await readDeliveries(
    supabase,
    rows.map((row) => String(row.snapshot_id)),
    "",
    "reports.deliveryCounts",
  );

  const counts = new Map<string, number>();
  for (const delivery of deliveries) {
    const key = delivery.snapshot_id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return rows.map((row) => ({
    runId: String(row.run_id),
    businessDate: String(row.business_date),
    generatedAt: String(row.generated_at),
    integrity: integrityOf(row.integrity_ok),
    recipientCount: counts.get(String(row.snapshot_id).toLowerCase()) ?? 0,
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

  // Paged for the same reason as the counts: a recipient list is as long as the Directors and
  // Managers on the night, and nothing caps that at one API response.
  const deliveries = await readDeliveries(
    supabase,
    [String(row.snapshot_id)],
    "recipient_role, profiles!inner(full_name)",
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
