import type {
  CountExplanation,
  CountOutcome,
  CountStatus,
  DailyCount,
  OpenDay,
  ResolvedCountAlert,
} from "@/lib/imprest/counting";
import type { Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Daily imprest count reads (product.md §13.7 and §15, issue #68).
 *
 * Expected cash, posted balance minus awaiting verification, is kept with each count as it stood,
 * so a count's variance never shifts. Every figure here comes from the database; none is typed.
 *
 * A FAILED READ IS NOT AN EMPTY LIST. The loaders throw through `requireRows`, so a day that could
 * not be read is never shown as Not counted, and a flag list that could not be read never as empty.
 */

export const COUNT_PAGE_SIZE = 10;

type CountRow = {
  id: string;
  business_date: string;
  attempt: number;
  counted_tzs: number;
  note: string | null;
  posted_balance_tzs: number | null;
  awaiting_verification_tzs: number | null;
  expected_tzs: number;
  variance_tzs: number;
  status: CountStatus;
  version: number;
  counted_by: string;
  counted_at: string;
  outcome: CountOutcome | null;
  explanation: CountExplanation | null;
  explanation_note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  return_reason: string | null;
  returned_by: string | null;
  returned_at: string | null;
  needs_director_decision: boolean | null;
  late_reason: string | null;
  total: number;
};

const num = (value: number | string | null) => (value === null ? null : Number(value));

function fromRow(row: CountRow): DailyCount {
  return {
    id: row.id,
    businessDate: row.business_date,
    attempt: row.attempt,
    counted: Number(row.counted_tzs),
    note: row.note,
    postedBalance: num(row.posted_balance_tzs),
    awaitingVerification: num(row.awaiting_verification_tzs),
    expected: Number(row.expected_tzs),
    variance: Number(row.variance_tzs),
    status: row.status,
    version: row.version,
    countedBy: row.counted_by,
    countedAt: row.counted_at,
    outcome: row.outcome,
    explanation: row.explanation,
    explanationNote: row.explanation_note,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    returnReason: row.return_reason,
    returnedBy: row.returned_by,
    returnedAt: row.returned_at,
    needsDirectorDecision: row.needs_director_decision,
    lateReason: row.late_reason,
  };
}

/**
 * One page of counts, most recent first, for every imprest role. The first page holds today's
 * counts when there are any, since a day has only a handful.
 */
export async function loadCounts(page: number): Promise<Page<DailyCount>> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_imprest_counts", {
      p_limit: COUNT_PAGE_SIZE,
      p_offset: (page - 1) * COUNT_PAGE_SIZE,
    })) as { data: CountRow[] | null; error: { message: string } | null },
    "imprest.counts",
  );
  return {
    rows: rows.map(fromRow),
    page,
    pageSize: COUNT_PAGE_SIZE,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

/**
 * Every count of one business day, most recently entered first. Today's card reads this rather than
 * a page of the history, so late counts entered after today's never push today off it (issue #69).
 */
export async function loadDayCounts(businessDate: string): Promise<DailyCount[]> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_imprest_counts", {
      p_limit: 100,
      p_offset: 0,
      p_business_date: businessDate,
    })) as { data: CountRow[] | null; error: { message: string } | null },
    "imprest.day_counts",
  );
  return rows.map(fromRow);
}

export type CountFlag = {
  id: string;
  businessDate: string;
  kind: "count_shortage" | "count_excess";
  amount: number;
  raisedAt: string;
};

/**
 * The flags a confirmed shortage or excess raised to the Directors (§13.7, AC-58), most recent
 * first. The table's policy lets only a Director read them.
 */
export async function loadCountFlags(limit = 10): Promise<CountFlag[]> {
  const supabase = await createServerSupabase();
  const rows = requireRows(
    (await supabase
      .from("imprest_count_flags")
      .select("id, business_date, kind, amount_tzs, raised_at")
      .order("raised_at", { ascending: false })
      .limit(limit)) as {
      data:
        | { id: string; business_date: string; kind: CountFlag["kind"]; amount_tzs: number; raised_at: string }[]
        | null;
      error: { message: string } | null;
    },
    "imprest.count_flags",
  );
  return rows.map((r) => ({
    id: r.id,
    businessDate: r.business_date,
    kind: r.kind,
    amount: Number(r.amount_tzs),
    raisedAt: r.raised_at,
  }));
}

/** The most open days or resolved alerts one page shows. Every page says how many there are. */
export const OPEN_DAY_PAGE_SIZE = 10;

type OpenDayRow = {
  business_date: string;
  state: string;
  waiting_since: string;
  not_counted_since: string | null;
  awaiting_since: string | null;
  latest_count_id: string | null;
  latest_status: CountStatus | null;
  latest_return_reason: string | null;
  total: number;
};

/**
 * A row this build cannot place is a failed read, never a dropped one: dropping it would hide the
 * very day the list exists to name (§15.2a).
 */
function unreadable(what: string, field: string): never {
  console.error(`[data] ${what} returned a row this build cannot render; unusable field: ${field}`);
  throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
}

/**
 * One page of a list whose rows carry the whole list's `total`.
 *
 * AN EMPTY PAGE PAST THE FIRST IS NOT AN EMPTY LIST. A confirmation can empty the page a link was
 * built for, and reading its missing total as zero would say every day is closed while earlier
 * pages still hold open ones. So the first page is read for the total, and the last page that
 * still has rows is returned in place of the one asked for.
 */
async function readPage<R extends { total: number }, T>(
  fn: string,
  what: string,
  page: number,
  map: (row: R) => T,
): Promise<Page<T>> {
  const api = await userApi();
  const fetchPage = async (p: number) =>
    requireRows(
      (await api.rpc(fn, {
        p_limit: OPEN_DAY_PAGE_SIZE,
        p_offset: (p - 1) * OPEN_DAY_PAGE_SIZE,
      })) as { data: R[] | null; error: { message: string } | null },
      what,
    );

  let current = page;
  let rows = await fetchPage(page);
  if (rows.length === 0 && page > 1) {
    const first = await fetchPage(1);
    const total = first.length > 0 ? Number(first[0].total) : 0;
    current = Math.max(1, Math.ceil(total / OPEN_DAY_PAGE_SIZE));
    rows = current === 1 ? first : await fetchPage(current);
  }
  return {
    rows: rows.map(map),
    page: current,
    pageSize: OPEN_DAY_PAGE_SIZE,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

/**
 * One page of the days that are not closed, oldest first (issue #69, §15.2a): Not counted, or a
 * count waiting for the Manager. Directors and the Manager read them as open alerts; the Cashier
 * reads them to count a missed day late.
 */
export function loadOpenDays(page: number): Promise<Page<OpenDay>> {
  const what = "imprest.open_count_days";
  return readPage<OpenDayRow, OpenDay>("staff_imprest_open_count_days", what, page, (row) => {
    if (row.state !== "not_counted" && row.state !== "awaiting_confirmation") unreadable(what, "state");
    if (typeof row.waiting_since !== "string") unreadable(what, "waiting_since");
    return {
      businessDate: row.business_date,
      state: row.state,
      waitingSince: row.waiting_since,
      notCountedSince: row.not_counted_since,
      awaitingSince: row.awaiting_since,
      latestCountId: row.latest_count_id,
      latestStatus: row.latest_status,
      latestReturnReason: row.latest_return_reason,
    };
  });
}

type AlertRow = {
  kind: string;
  business_date: string;
  count_id: string | null;
  attempt: number | null;
  raised_at: string;
  resolved_at: string;
  resolution: string;
  total: number;
};

const RESOLUTIONS = new Set(["counted_late", "confirmed", "sent_back"]);

/** One page of resolved count alerts, most recently resolved first. Directors and the Manager. */
export function loadAlertHistory(page: number): Promise<Page<ResolvedCountAlert>> {
  const what = "imprest.count_alert_history";
  return readPage<AlertRow, ResolvedCountAlert>("staff_imprest_count_alert_history", what, page, (row) => {
    if (row.kind !== "not_counted" && row.kind !== "awaiting_confirmation") unreadable(what, "kind");
    if (!RESOLUTIONS.has(row.resolution)) unreadable(what, "resolution");
    return {
      kind: row.kind,
      businessDate: row.business_date,
      countId: row.count_id,
      attempt: row.attempt,
      raisedAt: row.raised_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution as ResolvedCountAlert["resolution"],
    };
  });
}
