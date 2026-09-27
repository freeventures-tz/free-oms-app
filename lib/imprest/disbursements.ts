import { distinctPurposes, type ImprestCategory, type NoReceiptReason } from "@/lib/imprest/spending";
import { pagedQuery, type Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Imprest spending reads (product.md §13.3 and §13.4, issues #55 and #62).
 *
 * A FAILED READ IS NOT AN EMPTY LIST. Every loader throws through `requireRows`, so the shell's
 * error boundary says the page could not be loaded instead of showing nothing waiting or a zero.
 *
 * Which rows come back is decided by the table policies: a Director and the Manager read every
 * disbursement with its hand-out and settlement, a Cashier only their own. The figures come from
 * `api.staff_imprest_spending_position`, which hides every figure but Free to approve from a
 * Cashier in the database, not only on screen.
 */

export type DisbursementStatus =
  | "proposed"
  | "approved"
  | "handed_out"
  | "settled"
  | "rejected"
  | "withdrawn"
  | "cancelled";

/** The latest settlement of a disbursement: Approved = used + returned + unaccounted. */
export type SettlementSummary = {
  id: string;
  cycle: number;
  used: number;
  returned: number;
  unaccounted: number;
  explanation: string | null;
  lineCount: number;
  noReceiptLines: number;
  settledAt: string;
};

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
  /** Who received the cash, once it is handed out. */
  recipient: string | null;
  handedOutAt: string | null;
  settlement: SettlementSummary | null;
  /**
   * Permanent flags (issue #62 criterion 7). They are true when ANY settlement of this disbursement
   * ever had such a line or remainder, so a later cycle cannot clear them.
   */
  flags: { noReceipt: boolean; notAccounted: boolean };
};

export type DisbursementEvent = {
  kind: "proposed" | "approved" | "handed_out" | "settled" | "rejected" | "withdrawn" | "cancelled";
  at: string;
  /** The person's name, or "" when the viewer may not read it (a Cashier reads only their own). */
  by: string;
  /** Who acts at this step. Only the proposing Cashier proposes, withdraws, hands out and settles. */
  role: "cashier" | "manager";
  text: string | null;
};

export type SettlementLineView = {
  lineNo: number;
  amount: number;
  purpose: string;
  receipt: { id: string; fileName: string; contentType: string } | null;
  reason: NoReceiptReason | null;
  note: string | null;
};

export type DisbursementDetail = Disbursement & {
  events: DisbursementEvent[];
  lines: SettlementLineView[];
};

/**
 * The figures of the active fund, or `null` when no fund has been opened yet. For a Cashier,
 * everything but Free to approve is `null`: the database does not send it.
 */
export type SpendingPosition = {
  posted: number | null;
  setAside: number | null;
  freeToApprove: number;
  awaitingVerification: number | null;
};

const num = (value: number | string | null) => (value === null ? null : Number(value));

export async function loadSpendingPosition(): Promise<SpendingPosition | null> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_imprest_spending_position")) as {
      data:
        | {
            posted_funding_tzs: number | null;
            set_aside_tzs: number | null;
            free_to_approve_tzs: number;
            awaiting_verification_tzs: number | null;
          }[]
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
    awaitingVerification: num(row.awaiting_verification_tzs),
  };
}

const COLUMNS = `
  id, disbursement_no, status, version, amount_tzs, category, purpose, proposed_by, proposed_at,
  approved_by, approved_at, rejected_by, rejected_at, rejection_reason, withdrawn_at,
  withdrawal_reason, cancelled_by, cancelled_at, cancellation_reason,
  imprest_disbursement_handouts(recipient, handed_out_at),
  imprest_settlements(id, cycle, used_tzs, returned_tzs, unaccounted_tzs, unaccounted_explanation,
                      line_count, no_receipt_lines, settled_at)
`;

type SettlementRow = {
  id: string;
  cycle: number;
  used_tzs: number;
  returned_tzs: number;
  unaccounted_tzs: number;
  unaccounted_explanation: string | null;
  line_count: number;
  no_receipt_lines: number;
  settled_at: string;
};

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
  // One-to-one (the hand-out's disbursement id is unique), so PostgREST embeds an object or null.
  imprest_disbursement_handouts: { recipient: string; handed_out_at: string } | null;
  imprest_settlements: SettlementRow[] | null;
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
  const settlements = [...(row.imprest_settlements ?? [])].sort((a, b) => b.cycle - a.cycle);
  const latest = settlements[0];
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
    recipient: row.imprest_disbursement_handouts?.recipient ?? null,
    handedOutAt: row.imprest_disbursement_handouts?.handed_out_at ?? null,
    settlement: latest
      ? {
          id: latest.id,
          cycle: latest.cycle,
          used: Number(latest.used_tzs),
          returned: Number(latest.returned_tzs),
          unaccounted: Number(latest.unaccounted_tzs),
          explanation: latest.unaccounted_explanation,
          lineCount: latest.line_count,
          noReceiptLines: latest.no_receipt_lines,
          settledAt: latest.settled_at,
        }
      : null,
    flags: {
      noReceipt: settlements.some((s) => s.no_receipt_lines > 0),
      notAccounted: settlements.some((s) => Number(s.unaccounted_tzs) > 0),
    },
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

async function byStatus(
  label: string,
  status: DisbursementStatus,
  order: "proposed_at" | "approved_at",
  pageNo: number,
): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  return page(label, pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .eq("status", status)
      .order(order, { ascending: true })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
}

/** Proposals waiting for the Manager, oldest first, with the count of all of them. */
export const loadAwaitingDecision = (pageNo = 1) =>
  byStatus("imprest.awaiting_decision", "proposed", "proposed_at", pageNo);

/** Approvals not yet handed out or cancelled, longest open first. */
export const loadOpenApprovals = (pageNo = 1) =>
  byStatus("imprest.open_approvals", "approved", "approved_at", pageNo);

/** Cash handed out and not yet settled, longest out first (issue #62 criterion 14). */
export const loadHandedOut = (pageNo = 1) =>
  byStatus("imprest.handed_out", "handed_out", "approved_at", pageNo);

/** Settled and waiting for the Manager to verify, longest waiting first. */
export const loadSettledWaiting = (pageNo = 1) =>
  byStatus("imprest.settled_waiting", "settled", "approved_at", pageNo);

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

type LineRow = {
  line_no: number;
  amount_tzs: number;
  purpose: string;
  no_receipt_reason: NoReceiptReason | null;
  no_receipt_note: string | null;
  imprest_receipts: { id: string; file_name: string; content_type: string } | null;
};

async function loadLines(settlementId: string): Promise<SettlementLineView[]> {
  const supabase = await createServerSupabase();
  const rows = requireRows(
    (await supabase
      .from("imprest_settlement_lines")
      .select(
        "line_no, amount_tzs, purpose, no_receipt_reason, no_receipt_note, imprest_receipts(id, file_name, content_type)",
      )
      .eq("settlement_id", settlementId)
      .order("line_no")) as unknown as { data: LineRow[] | null; error: { message: string } | null },
    "imprest.settlement_lines",
  );
  return rows.map((row) => ({
    lineNo: row.line_no,
    amount: Number(row.amount_tzs),
    purpose: row.purpose,
    receipt: row.imprest_receipts
      ? {
          id: row.imprest_receipts.id,
          fileName: row.imprest_receipts.file_name,
          contentType: row.imprest_receipts.content_type,
        }
      : null,
    reason: row.no_receipt_reason,
    note: row.no_receipt_note,
  }));
}

/** One disbursement with its history and settlement lines, or `null` when it may not be read. */
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
  const disbursement = fromRow(row, names);

  // A settled row with no settlement read back would show Used and Returned as missing, which is
  // a failed read, not a fact.
  if (row.status === "settled" && !disbursement.settlement) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_settlement`);
  }
  if ((row.status === "handed_out" || row.status === "settled") && !disbursement.handedOutAt) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_handout`);
  }

  const events: DisbursementEvent[] = [
    { kind: "proposed", at: row.proposed_at, by: who(row.proposed_by), role: "cashier", text: row.purpose },
  ];
  if (row.approved_at) {
    events.push({ kind: "approved", at: row.approved_at, by: who(row.approved_by), role: "manager", text: null });
  }
  if (disbursement.handedOutAt) {
    // Only the proposer hands out and settles, so the proposer is who did it.
    events.push({
      kind: "handed_out",
      at: disbursement.handedOutAt,
      by: who(row.proposed_by),
      role: "cashier",
      text: disbursement.recipient,
    });
  }
  if (disbursement.settlement) {
    events.push({
      kind: "settled",
      at: disbursement.settlement.settledAt,
      by: who(row.proposed_by),
      role: "cashier",
      text: null,
    });
  }
  if (row.rejected_at) {
    events.push({
      kind: "rejected",
      at: row.rejected_at,
      by: who(row.rejected_by),
      role: "manager",
      text: row.rejection_reason,
    });
  }
  if (row.withdrawn_at) {
    // Only the proposer can withdraw, so the proposer is who did it.
    events.push({
      kind: "withdrawn",
      at: row.withdrawn_at,
      by: who(row.proposed_by),
      role: "cashier",
      text: row.withdrawal_reason,
    });
  }
  if (row.cancelled_at) {
    events.push({
      kind: "cancelled",
      at: row.cancelled_at,
      by: who(row.cancelled_by),
      role: "manager",
      text: row.cancellation_reason,
    });
  }
  if (events.some((event) => !event.at)) throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement`);
  events.sort((a, b) => a.at.localeCompare(b.at));

  const lines = disbursement.settlement ? await loadLines(disbursement.settlement.id) : [];
  if (disbursement.settlement && lines.length !== disbursement.settlement.lineCount) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.settlement_lines`);
  }

  return { ...disbursement, events, lines };
}
