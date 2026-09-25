import { distinctPurposes, type ImprestCategory } from "@/lib/imprest/spending";
import { pagedQuery, type Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Imprest spending reads, part 1 (product.md §13.3 points 1 and 2, issue #55).
 *
 * A FAILED READ IS NOT AN EMPTY LIST. Every loader throws through `requireRows`, so the shell's
 * error boundary says the page could not be loaded instead of showing nothing waiting or a zero.
 *
 * Which rows come back is decided by the table policy: a Director and the Manager read every
 * disbursement, a Cashier only their own. The figures come from `api.staff_imprest_spending_position`,
 * which hides posted funding and set aside from a Cashier in the database, not only on screen.
 */

export type DisbursementStatus = "proposed" | "approved" | "rejected" | "withdrawn" | "cancelled";

export type Disbursement = {
  id: string;
  disbursementNo: string;
  status: DisbursementStatus;
  version: number;
  amount: number;
  category: ImprestCategory;
  purpose: string;
  proposedBy: string;
  proposedById: string;
  proposedAt: string;
  approvedAt: string | null;
};

export type DisbursementEvent = {
  kind: "proposed" | "approved" | "rejected" | "withdrawn" | "cancelled";
  at: string;
  by: string;
  text: string | null;
};

export type DisbursementDetail = Disbursement & { events: DisbursementEvent[] };

/**
 * The figures of the active fund, or `null` when no fund has been opened yet. For a Cashier,
 * `posted` and `setAside` are `null`: the database does not send them.
 */
export type SpendingPosition = {
  posted: number | null;
  setAside: number | null;
  freeToApprove: number;
};

const num = (value: number | string | null) => (value === null ? null : Number(value));

export async function loadSpendingPosition(): Promise<SpendingPosition | null> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_imprest_spending_position")) as {
      data:
        | { posted_funding_tzs: number | null; set_aside_tzs: number | null; free_to_approve_tzs: number }[]
        | null;
      error: { message: string } | null;
    },
    "imprest.spending_position",
  );
  const row = rows[0];
  if (!row) return null;
  return {
    posted: num(row.posted_funding_tzs),
    setAside: num(row.set_aside_tzs),
    freeToApprove: Number(row.free_to_approve_tzs),
  };
}

const COLUMNS = `
  id, disbursement_no, status, version, amount_tzs, category, purpose, proposed_by, proposed_at,
  approved_by, approved_at, rejected_by, rejected_at, rejection_reason, withdrawn_at,
  withdrawal_reason, cancelled_by, cancelled_at, cancellation_reason
`;

type Row = {
  id: string;
  disbursement_no: string;
  status: DisbursementStatus;
  version: number;
  amount_tzs: number;
  category: ImprestCategory;
  purpose: string;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
};

type Counted = PromiseLike<{
  data: Row[] | null;
  error: { message: string; code?: string } | null;
  count: number | null;
}>;

async function namesFor(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const supabase = await createServerSupabase();
  const rows = requireRows(
    await supabase.from("profiles").select("id, full_name").in("id", unique),
    "imprest.disbursement_names",
  );
  return new Map(rows.map((row) => [String(row.id), String(row.full_name ?? "")]));
}

function fromRow(row: Row, names: Map<string, string>): Disbursement {
  return {
    id: row.id,
    disbursementNo: row.disbursement_no,
    status: row.status,
    version: row.version,
    amount: Number(row.amount_tzs),
    category: row.category,
    purpose: row.purpose,
    proposedBy: names.get(row.proposed_by) ?? "",
    proposedById: row.proposed_by,
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
  };
}

async function page(
  label: string,
  pageNo: number,
  build: (from: number, to: number) => Counted,
): Promise<Page<Disbursement>> {
  const result = await pagedQuery<Row>(pageNo, build, label);
  const names = await namesFor(result.rows.map((row) => row.proposed_by));
  return { ...result, rows: result.rows.map((row) => fromRow(row, names)) };
}

/** Proposals waiting for the Manager, oldest first, with the count of all of them. */
export async function loadAwaitingDecision(pageNo = 1): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  return page("imprest.awaiting_decision", pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .eq("status", "proposed")
      .order("proposed_at", { ascending: true })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
}

/** Approvals not yet cancelled (and, until part 2, not yet paid), longest open first. */
export async function loadOpenApprovals(pageNo = 1): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  return page("imprest.open_approvals", pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .eq("status", "approved")
      .order("approved_at", { ascending: true })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
}

/**
 * The viewer's own disbursements, newest first, in every status. Filtered on the proposer as well
 * as by the policy, so a Manager who somehow reached this list would still see only their own.
 */
export async function loadOwnDisbursements(viewerId: string, pageNo = 1): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  return page("imprest.own_disbursements", pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .eq("proposed_by", viewerId)
      .order("proposed_at", { ascending: false })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
}

/** The last few distinct purposes the viewer typed, newest first, for the propose form. */
export async function loadRecentPurposes(viewerId: string, limit = 6): Promise<string[]> {
  const supabase = await createServerSupabase();
  const rows = requireRows(
    await supabase
      .from("imprest_disbursements")
      .select("purpose")
      .eq("proposed_by", viewerId)
      .order("proposed_at", { ascending: false })
      .order("id")
      .limit(50),
    "imprest.recent_purposes",
  );
  return distinctPurposes(rows.map((row) => String(row.purpose)), limit);
}

/** One disbursement with its history, or `null` when it does not exist or may not be read. */
export async function loadDisbursement(id: string): Promise<DisbursementDetail | null> {
  const supabase = await createServerSupabase();
  const rows = requireRows(
    (await supabase.from("imprest_disbursements").select(COLUMNS).eq("id", id)) as unknown as {
      data: Row[] | null;
      error: { message: string } | null;
    },
    "imprest.disbursement",
  );
  const row = rows[0];
  if (!row) return null;

  const names = await namesFor([row.proposed_by, row.approved_by, row.rejected_by, row.cancelled_by]);
  const who = (person: string | null) => (person ? (names.get(person) ?? "") : "");

  const events: DisbursementEvent[] = [
    { kind: "proposed", at: row.proposed_at, by: who(row.proposed_by), text: row.purpose },
  ];
  if (row.approved_at) {
    events.push({ kind: "approved", at: row.approved_at, by: who(row.approved_by), text: null });
  }
  if (row.rejected_at) {
    events.push({
      kind: "rejected",
      at: row.rejected_at,
      by: who(row.rejected_by),
      text: row.rejection_reason,
    });
  }
  if (row.withdrawn_at) {
    // Only the proposer can withdraw, so the proposer is who did it.
    events.push({
      kind: "withdrawn",
      at: row.withdrawn_at,
      by: who(row.proposed_by),
      text: row.withdrawal_reason,
    });
  }
  if (row.cancelled_at) {
    events.push({
      kind: "cancelled",
      at: row.cancelled_at,
      by: who(row.cancelled_by),
      text: row.cancellation_reason,
    });
  }
  if (events.some((event) => !event.at)) throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement`);
  events.sort((a, b) => a.at.localeCompare(b.at));

  return { ...fromRow(row, names), events };
}
