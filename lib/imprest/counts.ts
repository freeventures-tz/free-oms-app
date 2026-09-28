import type { CountExplanation, CountOutcome, CountStatus, DailyCount } from "@/lib/imprest/counting";
import type { Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { requireRows } from "@/lib/supabase/query";
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
