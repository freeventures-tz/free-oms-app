import type { Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import type {
  OpenTillDay,
  TillCount,
  TillDayRow,
  TillLine,
  TillOutcome,
  TillStatus,
  VarianceReason,
} from "@/lib/till/counting";

/**
 * Till count reads (issue #83). Every figure here comes from the database; none is typed but the
 * counted ones. A Cashier is sent only the counts they entered, and no expected figure before
 * counting: the database decides both, not this file.
 *
 * A FAILED READ IS NOT AN EMPTY LIST. The loaders throw through `requireRows`, so a day that could
 * not be read is never shown as Not counted, and a count list that could not be read never as empty.
 */

export const TILL_PAGE_SIZE = 10;

type CountRow = {
  id: string;
  business_date: string;
  attempt: number;
  note: string | null;
  late_reason: string | null;
  status: TillStatus;
  version: number;
  counted_by: string;
  counted_at: string;
  lines: { line: string; expected_tzs: number; counted_tzs: number | null; variance_tzs: number | null }[] | null;
  expected_tzs: number | null;
  counted_tzs: number | null;
  variance_tzs: number | null;
  outcome: TillOutcome | null;
  short_tzs: number | null;
  over_tzs: number | null;
  explanation: VarianceReason | null;
  explanation_note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  return_reason: string | null;
  returned_by: string | null;
  returned_at: string | null;
  total: number;
};

const num = (value: number | string | null) => (value === null ? null : Number(value));

function fromRow(row: CountRow): TillCount {
  const lines: TillLine[] = (row.lines ?? []).map((l) => ({
    line: l.line,
    expected: Number(l.expected_tzs),
    counted: num(l.counted_tzs),
    variance: num(l.variance_tzs),
  }));
  return {
    id: row.id,
    businessDate: row.business_date,
    attempt: row.attempt,
    note: row.note,
    lateReason: row.late_reason,
    status: row.status,
    version: row.version,
    countedBy: row.counted_by,
    countedAt: row.counted_at,
    lines,
    expected: Number(row.expected_tzs ?? 0),
    counted: num(row.counted_tzs),
    variance: num(row.variance_tzs),
    outcome: row.outcome,
    short: num(row.short_tzs),
    over: num(row.over_tzs),
    explanation: row.explanation,
    explanationNote: row.explanation_note,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    returnReason: row.return_reason,
    returnedBy: row.returned_by,
    returnedAt: row.returned_at,
  };
}

async function readCounts(limit: number, offset: number, businessDate: string | null, what: string) {
  const api = await userApi();
  return requireRows(
    (await api.rpc("staff_till_counts", {
      p_limit: limit,
      p_offset: offset,
      p_business_date: businessDate,
    })) as { data: CountRow[] | null; error: { message: string } | null },
    what,
  );
}

/** One page of counts, most recently entered first. A Cashier's page holds only their own. */
export async function loadTillCounts(page: number): Promise<Page<TillCount>> {
  const rows = await readCounts(TILL_PAGE_SIZE, (page - 1) * TILL_PAGE_SIZE, null, "till.counts");
  return {
    rows: rows.map(fromRow),
    page,
    pageSize: TILL_PAGE_SIZE,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

/** Every count of one business day the viewer may read, most recently entered first. */
export async function loadTillDayCounts(businessDate: string): Promise<TillCount[]> {
  return (await readCounts(100, 0, businessDate, "till.day_counts")).map(fromRow);
}

export type TillExpectedLine = { line: string; expected: number; payments: number };

/**
 * What the till should hold for a day as it stands now, per payment method. Directors and the
 * Manager only: the database refuses the Cashier, who counts without seeing it.
 */
export async function loadTillExpected(businessDate: string): Promise<TillExpectedLine[]> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_till_expected", { p_business_date: businessDate })) as {
      data: { line: string; expected_tzs: number; payments: number }[] | null;
      error: { message: string } | null;
    },
    "till.expected",
  );
  return rows.map((r) => ({ line: r.line, expected: Number(r.expected_tzs), payments: Number(r.payments) }));
}

type DayRow = {
  business_date: string;
  state: string;
  not_counted_since: string | null;
  awaiting_since: string | null;
  latest_id: string | null;
  latest_status: TillStatus | null;
  latest_return_reason: string | null;
  total: number;
};

const DAY_STATES = new Set(["due", "not_counted", "awaiting_confirmation", "balanced", "shortage", "excess"]);

function dayFromRow(row: DayRow, what: string): TillDayRow {
  // A row this build cannot place is a failed read, never a dropped one: dropping it would hide the
  // very day the screen exists to name.
  if (!DAY_STATES.has(row.state)) {
    console.error(`[data] ${what} returned a row this build cannot render; unusable field: state`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  return {
    businessDate: row.business_date,
    state: row.state as TillDayRow["state"],
    notCountedSince: row.not_counted_since,
    awaitingSince: row.awaiting_since,
    latestId: row.latest_id,
    latestStatus: row.latest_status,
    latestReturnReason: row.latest_return_reason,
  };
}

async function readDays(args: Record<string, unknown>, what: string): Promise<TillDayRow[]> {
  const api = await userApi();
  return requireRows(
    (await api.rpc("staff_till_days", args)) as { data: DayRow[] | null; error: { message: string } | null },
    what,
  ).map((row) => dayFromRow(row, what));
}

/**
 * Today as the database resolves it: the most recent business day of the till. The page takes its
 * date from this row rather than from the server's own clock, so a request that straddles midnight
 * in Dar es Salaam shows the day the database will accept a count for. `null` only before the
 * first day counting started, which cannot happen after release day.
 */
export async function loadTillToday(): Promise<TillDayRow | null> {
  const [day] = await readDays({ p_limit: 1, p_offset: 0, p_open_only: false }, "till.today");
  return day ?? null;
}

/**
 * The oldest day whose count waits for the Manager, whatever page of open days it falls on, so
 * many older Not counted days can never push it out of sight.
 */
export async function loadOldestWaitingDay(): Promise<TillDayRow | null> {
  const [day] = await readDays(
    { p_limit: 1, p_offset: 0, p_open_only: true, p_state: "awaiting_confirmation" },
    "till.oldest_waiting",
  );
  return day ?? null;
}

/**
 * One page of the days that are not closed, oldest first (§15.2a): Not counted, or a count waiting
 * for the Manager. An empty page past the first is read again from the last page that has rows, so
 * a confirmation that empties the page a link was built for never reads as "every day is closed".
 */
export async function loadOpenTillDays(page: number): Promise<Page<OpenTillDay>> {
  const api = await userApi();
  const what = "till.open_days";
  const fetchPage = async (p: number) =>
    requireRows(
      (await api.rpc("staff_till_days", {
        p_limit: TILL_PAGE_SIZE,
        p_offset: (p - 1) * TILL_PAGE_SIZE,
        p_open_only: true,
      })) as { data: DayRow[] | null; error: { message: string } | null },
      what,
    );

  let current = page;
  let rows = await fetchPage(page);
  if (rows.length === 0 && page > 1) {
    const first = await fetchPage(1);
    const total = first.length > 0 ? Number(first[0].total) : 0;
    current = Math.max(1, Math.ceil(total / TILL_PAGE_SIZE));
    rows = current === 1 ? first : await fetchPage(current);
  }
  return {
    rows: rows.map((row) => {
      const day = dayFromRow(row, what);
      if (day.state !== "not_counted" && day.state !== "awaiting_confirmation") {
        console.error(`[data] ${what} returned a closed day in the open list`);
        throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
      }
      return { ...day, state: day.state };
    }),
    page: current,
    pageSize: TILL_PAGE_SIZE,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}
