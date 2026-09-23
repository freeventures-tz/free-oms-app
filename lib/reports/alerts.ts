import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The alert a Director or the Manager sees when a night produced no report at all (product.md §18).
 *
 * ONE ALERT, ONE MEANING. `report_failure_alerts` carries exactly one kind of row today: every
 * scheduled attempt at a business date failed, and there is no report for it. The type is written
 * as a closed set rather than as `string` so that adding a second kind of alert later is a compiler
 * error at every place that renders one, instead of a row that renders as nothing.
 *
 * THERE IS NO WRITE PATH HERE, and there is deliberately no Retry and no Generate. Nothing in the
 * application can produce, resolve or dismiss one of these: the database raises the alert when the
 * last scheduled attempt fails, and it stops being unresolved only if the business date it names
 * gets a report. A control that implied otherwise would tell a Director they had fixed a night that
 * is still missing.
 *
 * A FAILED READ IS NOT AN EMPTY ALERT LIST, AND NEITHER IS A ROW THIS BUILD CANNOT READ. Both
 * throw, so the shell's error boundary says the system could not be reached — because "no
 * unresolved failures" and "we could not find out" are opposite answers, and the reassuring one
 * must never be shown for the other.
 */

export type ReportAlertType = "scheduled_report_failed";
export type ReportAlertPriority = "high";

export type ReportFailureAlert = {
  id: string;
  /** The night that has no report. This is what the reader acts on, so it is never optional. */
  businessDate: string;
  type: ReportAlertType;
  priority: ReportAlertPriority;
  raisedAt: string;
};

/** The shapes the database actually produces. A value that is not one of these is not readable. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, not merely four digits and two dashes: `2026-02-31` is not a night. */
function isRealDate(value: string): boolean {
  if (!BUSINESS_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * An ISO-8601 instant of the shape PostgREST actually returns for a `timestamptz`, with the
 * timezone required.
 *
 * `2026-08-28T21:30:00Z`, `2026-08-28T21:30:00.123456+00:00` and `2026-08-29T00:30:00+03:00` are
 * all real answers from this database. A space instead of `T` is accepted because `psql` and some
 * client paths render it that way; nothing else is.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A real instant, not merely something `Date` will swallow.
 *
 * `new Date(value)` was the whole check here, and it is far too generous to be one. It accepts
 * `"0"` and `"123"` as years, `"August 28, 2026"` as a locale string whose meaning depends on the
 * runtime, and a bare `"2026-08-28T21:30:00"` with no zone at all — which JavaScript then reads in
 * the SERVER's timezone, so a report's raised time would silently shift by three hours between a
 * developer's machine and a UTC host. Worst of all it accepts `"2026-02-31T00:00:00Z"`, rolling it
 * forward to 3 March without a word, exactly as `lib/time/business-date.ts` records `new Date` doing to
 * a wall-clock date.
 *
 * So the shape is matched first, and then the parts are checked to be the day and time they claim:
 * a value that round-trips to the same instant is a real one, and `2026-02-31` cannot.
 */
function isInstant(value: string): boolean {
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;

  // Rolled-over dates and times are caught here: 31 February parses, and then reports March.
  const utc = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );

  return (
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day) &&
    utc.getUTCHours() === Number(hour) &&
    utc.getUTCMinutes() === Number(minute) &&
    utc.getUTCSeconds() === Number(second)
  );
}

/**
 * A row as the view returns it, turned into the alert the screen renders — or a thrown failure.
 *
 * IT THROWS RATHER THAN DROPPING THE ROW, and the earlier version of this function returned `null`
 * instead. Dropping was wrong in the one direction that matters here: the only rows this view
 * returns are UNRESOLVED TOTAL FAILURES, so a row the build cannot read is a night with no report
 * that the reader is then not told about. Silently rendering four alerts where the database sent
 * five is the same lie as rendering none during an outage — design.md §12.7 rule 7 forbids both,
 * and it forbids them for the same reason.
 *
 * IT CHECKS THE VALUES, NOT ONLY THE TYPES. `typeof x === "string"` accepted `""` as an id and
 * `"nonsense"` as a night, which is how a broken row reaches the screen looking finished: an empty
 * `key` collapses two alerts into one React child, and a date that is not a date renders as
 * `Invalid Date` next to the words "has no report". A value that cannot be what it claims to be is
 * a failed read, and is treated as one.
 *
 * The throw carries `DATA_UNAVAILABLE`, so it reaches the page-level "could not be reached" state
 * by the same route a refused query does, and the reader gets a screen that says so and offers a
 * retry rather than a quietly short list.
 *
 * NEITHER THE MESSAGE NOR THE LOG CARRIES A VALUE FROM THE ROW — only the NAMES of the fields that
 * failed, which are column names and already in the source. An earlier version logged
 * `type=${row.alert_type} priority=${row.priority}` while claiming beside it that nothing from the
 * row was included; the claim was about the thrown message and quietly untrue of the log. Field
 * names are what an operator needs to find the bad row anyway — the value is in the database, where
 * they can read it with the right to do so.
 */
export function toReportFailureAlert(row: {
  id?: unknown;
  business_date?: unknown;
  alert_type?: unknown;
  priority?: unknown;
  raised_at?: unknown;
}): ReportFailureAlert {
  const invalid: string[] = [];

  if (typeof row.id !== "string" || !UUID.test(row.id)) invalid.push("id");
  if (typeof row.business_date !== "string" || !isRealDate(row.business_date)) {
    invalid.push("business_date");
  }
  if (row.alert_type !== "scheduled_report_failed") invalid.push("alert_type");
  if (row.priority !== "high") invalid.push("priority");
  if (typeof row.raised_at !== "string" || !isInstant(row.raised_at)) invalid.push("raised_at");

  if (invalid.length > 0) {
    console.error(
      `[data] reports.failureAlerts returned a row this build cannot render; ` +
        `unusable fields: ${invalid.join(", ")}`,
    );
    throw new Error(`${DATA_UNAVAILABLE}: reports.failureAlerts`);
  }

  return {
    id: row.id as string,
    businessDate: row.business_date as string,
    type: "scheduled_report_failed",
    priority: "high",
    raisedAt: row.raised_at as string,
  };
}

/**
 * The most rows one request asks for. It equals `max_rows` in `supabase/config.toml`, which is the
 * API's own ceiling on any single response.
 *
 * IT IS NOT WHAT DECIDES THAT THE LIST IS FINISHED. If the API's ceiling were lowered below this,
 * a page would come back shorter than requested while rows still remained, and "a short page is the
 * last page" would silently drop them. Completion is decided by the exact count PostgREST returns
 * beside each page instead (see `loadReportFailureAlerts`), so this number only sets how many rows
 * travel per round trip.
 */
export const ALERT_PAGE_SIZE = 1000;

/** The position after which the next page starts: the last alert already read. */
type Cursor = { businessDate: string; id: string };

/**
 * Whether `next` comes strictly after `previous` in the list's order: newest night first, and on
 * the same night by id. Postgres orders a uuid by its bytes, which is the order of its lower-case
 * hex text, so the comparison here is the database's own.
 */
function comesAfter(previous: Cursor, next: Cursor): boolean {
  if (next.businessDate !== previous.businessDate) return next.businessDate < previous.businessDate;
  return next.id.toLowerCase() > previous.id.toLowerCase();
}

/**
 * Every unresolved scheduled-report failure, newest night first.
 *
 * The view already excludes a business date that has since been reported, so "unresolved" is
 * decided by the database from the runs themselves rather than by a flag anybody can set.
 *
 * THERE IS NO DISPLAY LIMIT, and that is a decision about what this list IS rather than an
 * omission. It holds at most one row per business date on which all four scheduled attempts failed
 * — a set that only grows while the business is going unreported, and that empties itself the
 * moment a date is reported. A cap would have silently hidden the oldest missing nights behind a
 * number nobody chose, on the one screen whose entire job is to say that a night is missing.
 *
 * THE API HAS A LIMIT EVEN SO, and one request is not the whole list. PostgREST answers at most
 * `max_rows` rows with HTTP 200 and no error, so a single unpaged read of 1,001 alerts returned
 * 1,000 and looked complete — the oldest night vanished from the screen meant to name it. The list
 * is therefore read in pages, and three rules make the result trustworthy:
 *
 *   1. KEYSET, NOT OFFSET. Each page starts strictly after the last alert already read, ordered by
 *      business date and then id, which is unique. An offset would skip a row whenever a night was
 *      reported between two pages; a cursor cannot, and it cannot return a row twice.
 *   2. THE COUNT DECIDES COMPLETION. Every page asks for the exact number of alerts at or after its
 *      cursor, computed by the same statement as the rows. The read ends only when a page holds
 *      every row that remained — never because a page merely looked short.
 *   3. ANY DOUBT FAILS THE WHOLE READ. A refused page, a missing count, a row out of order or
 *      repeated, a page that is empty while rows remain, or a row this build cannot read throws
 *      `DATA_UNAVAILABLE`. A partial list is never returned as a complete one.
 *
 * Paging does not make the read a single snapshot: an alert raised for a newer night while later
 * pages are still being read appears on the next load, exactly as it would had it been raised a
 * moment after a one-request read.
 */
export async function loadReportFailureAlerts(): Promise<ReportFailureAlert[]> {
  const supabase = await createServerSupabase();
  const alerts: ReportFailureAlert[] = [];
  let cursor: Cursor | null = null;

  for (;;) {
    let query = supabase
      .from("report_failure_alerts")
      .select("id, business_date, alert_type, priority, raised_at", { count: "exact" })
      .order("business_date", { ascending: false })
      .order("id", { ascending: true })
      .limit(ALERT_PAGE_SIZE);

    // Both values were checked as a real date and a uuid when their row was mapped, so nothing
    // unvalidated is ever written into the filter.
    if (cursor) {
      query = query.or(
        `business_date.lt.${cursor.businessDate},` +
          `and(business_date.eq.${cursor.businessDate},id.gt.${cursor.id})`,
      );
    }

    const result = await query;
    const rows = requireRows(result, "reports.failureAlerts");
    const remaining = result.count;

    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0) {
      console.error("[data] reports.failureAlerts returned a page without an exact count");
      throw new Error(`${DATA_UNAVAILABLE}: reports.failureAlerts`);
    }
    if (rows.length > remaining || (rows.length === 0 && remaining > 0)) {
      console.error(
        `[data] reports.failureAlerts returned ${rows.length} rows against a count of ${remaining}`,
      );
      throw new Error(`${DATA_UNAVAILABLE}: reports.failureAlerts`);
    }

    for (const row of rows) {
      const alert = toReportFailureAlert(row as Parameters<typeof toReportFailureAlert>[0]);
      if (cursor && !comesAfter(cursor, alert)) {
        console.error("[data] reports.failureAlerts returned a row out of order or twice");
        throw new Error(`${DATA_UNAVAILABLE}: reports.failureAlerts`);
      }
      alerts.push(alert);
      cursor = { businessDate: alert.businessDate, id: alert.id };
    }

    if (rows.length === remaining) return alerts;
  }
}
