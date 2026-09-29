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
  | "sent_back"
  | "verified"
  | "rejected"
  | "withdrawn"
  | "cancelled";

/** The latest settlement of a disbursement: Approved = used + returned + unaccounted. */
export type SettlementSummary = {
  id: string;
  cycle: number;
  /** The approved amount this cycle explained, raised approvals included (issue #70). */
  approved: number;
  used: number;
  returned: number;
  unaccounted: number;
  explanation: string | null;
  lineCount: number;
  noReceiptLines: number;
  settledAt: string;
};

/**
 * What the Manager's verification posted (issue #64). The expense is Used; the loss is Not
 * accounted for, which needs a Director's decision. Both are final.
 */
export type VerificationSummary = {
  verifiedAt: string;
  verifiedById: string;
  settlementId: string;
  expense: number;
  loss: number | null;
};

/**
 * The Manager sent a settlement cycle back to the Cashier (issue #65). `returnedBy` is the Manager's
 * name, or "" when the viewer may not read it (a Cashier reads only their own profile).
 */
export type SettlementReturn = {
  settlementId: string;
  reason: string;
  returnedAt: string;
  returnedById: string;
  returnedBy: string;
};

export type RaiseStatus = "requested" | "raised" | "refused" | "handed_out";

/**
 * One request for a raised approval (issue #70) and what became of it. Names are "" when the viewer
 * may not read the profile (a Cashier reads only their own).
 */
export type Raise = {
  id: string;
  raiseNo: number;
  status: RaiseStatus;
  /** The increase asked for, in whole shillings. */
  amount: number;
  reason: string;
  requestedById: string;
  requestedAt: string;
  decidedById: string | null;
  decidedBy: string;
  decidedAt: string | null;
  /** Why the Manager refused it. */
  refusalReason: string | null;
  handedOutAt: string | null;
  recipient: string | null;
};

export type PostingKind = "expense" | "unexplained_loss";
export type PostingEntry = "original" | "reversal" | "replacement";

/**
 * One row of what a payment posted (issues #64 and #71): the original from verification, a reversal
 * that cancels one posting in full, or the replacement at the correct amount. Never changed.
 */
export type Posting = {
  id: string;
  kind: PostingKind;
  entry: PostingEntry;
  amount: number;
  /** The request that posted it, for a reversal or a replacement. */
  reversalId: string | null;
  /** The posting a reversal cancels, or the one a replacement stands in for. */
  correctsPostingId: string | null;
  needsDirectorDecision: boolean;
  postedAt: string;
  /** True once a later reversal cancels this posting. A reversal itself is never reversed. */
  reversed: boolean;
};

export type ReversalStatus = "requested" | "approved" | "rejected";

/**
 * A request to reverse one verified posting and post it again at the correct amount (issue #71),
 * and the Director's decision. Names are "" when the viewer may not read the profile.
 */
export type Reversal = {
  id: string;
  postingId: string;
  kind: PostingKind;
  status: ReversalStatus;
  version: number;
  /** What the posting held. */
  original: number;
  /** What it should have been. 0 undoes it. */
  correct: number;
  reason: string;
  requestedById: string;
  requestedBy: string;
  requestedRole: "cashier" | "manager";
  requestedAt: string;
  decidedById: string | null;
  decidedBy: string;
  decidedAt: string | null;
  rejectionReason: string | null;
};

export type Disbursement = {
  id: string;
  disbursementNo: string;
  status: DisbursementStatus;
  version: number;
  /**
   * The approved amount, calculated by the database: the original approval plus every raise that
   * was raised or handed out. Never typed (issue #70).
   */
  amount: number;
  /** What the Manager first approved. It never changes. */
  originalAmount: number;
  /** Every request for a raised approval, oldest first, and what became of it. */
  raises: Raise[];
  /** The request the Manager has not decided yet, if there is one. */
  openRequest: Raise | null;
  /** A raise that was raised and whose extra the Cashier has not yet handed out. */
  awaitingHandOut: Raise | null;
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
  /** While sent back: the return of the latest cycle, which the Cashier is answering. */
  sentBack: SettlementReturn | null;
  verification: VerificationSummary | null;
  /**
   * Permanent flags (issue #62 criterion 7). They are true when ANY settlement of this disbursement
   * ever had such a line or remainder, so a later cycle cannot clear them.
   */
  flags: { noReceipt: boolean; notAccounted: boolean };
  /** Reversal requests still waiting for a Director (issue #71). */
  openReversals: number;
};

export type DisbursementEvent = {
  kind:
    | "proposed"
    | "approved"
    | "handed_out"
    | "settled"
    | "sent_back"
    | "verified"
    | "rejected"
    | "withdrawn"
    | "cancelled"
    | "raise_requested"
    | "raise_raised"
    | "raise_refused"
    | "raise_handed_out"
    | "reversal_requested"
    | "reversal_approved"
    | "reversal_rejected"
    | "reversal_posted"
    | "replacement_posted";
  at: string;
  /** The person's name, or "" when the viewer may not read it (a Cashier reads only their own). */
  by: string;
  /** Who acts at this step. Only the proposing Cashier proposes, withdraws, hands out and settles. */
  role: "cashier" | "manager" | "director";
  text: string | null;
  /** The settlement cycle a settle or send-back event belongs to. */
  cycle?: number;
  /** A correction event's amount: the correct amount asked for, or what a posting cancelled or posted. */
  amount?: number;
  /** The kind of posting a correction event is about. */
  posting?: PostingKind;
};

export type SettlementLineView = {
  lineNo: number;
  amount: number;
  purpose: string;
  receipt: { id: string; fileName: string; contentType: string } | null;
  reason: NoReceiptReason | null;
  note: string | null;
};

/** One settlement cycle, in full: its figures, its lines, and its return when it was sent back. */
export type SettlementCycle = SettlementSummary & {
  lines: SettlementLineView[];
  sentBack: SettlementReturn | null;
};

/** A receipt already uploaded and cited, which a later cycle may cite again (issue #65). */
export type EarlierReceipt = { id: string; fileName: string; contentType: string; cycle: number };

export type DisbursementDetail = Disbursement & {
  /** Every posting in the order it was posted: the originals, then each correction. */
  postings: Posting[];
  /** Every reversal request, oldest first, and what became of it. */
  reversals: Reversal[];
  events: DisbursementEvent[];
  /** Every settlement cycle, oldest first. Nothing in an earlier one ever changes. */
  cycles: SettlementCycle[];
  /** The fund it was paid from has been retired (issue #72), so nothing can be added to it. */
  fundRetired: boolean;
};

/**
 * The figures of the active fund, or `null` when no fund has been opened yet. For a Cashier,
 * everything but Free to approve is `null`: the database does not send it.
 *
 * `postedBalance` is confirmed funding minus verified expenses and unexplained losses, as corrected
 * by reversals and replacements (issues #64 and #71).
 */
export type SpendingPosition = {
  postedBalance: number | null;
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
            posted_balance_tzs: number | null;
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
    postedBalance: num(row.posted_balance_tzs),
    setAside: num(row.set_aside_tzs),
    freeToApprove: Number(row.free_to_approve_tzs),
    awaitingVerification: num(row.awaiting_verification_tzs),
  };
}

const COLUMNS = `
  id, disbursement_no, status, version, amount_tzs, approved_tzs:imprest_disbursement_approved_tzs,
  category, purpose, proposed_by, proposed_at,
  approved_by, approved_at, rejected_by, rejected_at, rejection_reason, withdrawn_at,
  withdrawal_reason, cancelled_by, cancelled_at, cancellation_reason,
  imprest_disbursement_handouts(recipient, handed_out_at),
  imprest_settlements(id, cycle, approved_tzs, used_tzs, returned_tzs, unaccounted_tzs,
                      unaccounted_explanation, line_count, no_receipt_lines, settled_at),
  imprest_approval_raises(id, raise_no, status, amount_tzs, reason, requested_by, requested_at,
                          decided_by, decided_at, refusal_reason, handed_out_at, recipient),
  imprest_verifications(settlement_id, verified_by, verified_at),
  imprest_postings(id, kind, entry, amount_tzs, reversal_id, corrects_posting_id,
                   needs_director_decision, posted_at),
  imprest_posting_reversals(id, posting_id, status, version, original_tzs, correct_tzs, reason,
                            requested_by, requested_role, requested_at, decided_by, decided_at,
                            rejection_reason),
  imprest_settlement_returns(settlement_id, reason, returned_by, returned_at)
`;

type SettlementRow = {
  id: string;
  cycle: number;
  approved_tzs: number;
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
  approved_tzs: number;
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
  // One-to-one (a disbursement is verified once), so PostgREST embeds an object or null.
  imprest_verifications: { settlement_id: string; verified_by: string; verified_at: string } | null;
  imprest_postings: PostingRow[] | null;
  imprest_posting_reversals: ReversalRow[] | null;
  imprest_settlement_returns: ReturnRow[] | null;
  imprest_approval_raises: RaiseRow[] | null;
};

type RaiseRow = {
  id: string;
  raise_no: number;
  status: RaiseStatus;
  amount_tzs: number;
  reason: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  refusal_reason: string | null;
  handed_out_at: string | null;
  recipient: string | null;
};

type PostingRow = {
  id: string;
  kind: PostingKind;
  entry: PostingEntry;
  amount_tzs: number;
  reversal_id: string | null;
  corrects_posting_id: string | null;
  needs_director_decision: boolean;
  posted_at: string;
};

type ReversalRow = {
  id: string;
  posting_id: string;
  status: ReversalStatus;
  version: number;
  original_tzs: number;
  correct_tzs: number;
  reason: string;
  requested_by: string;
  requested_role: "cashier" | "manager";
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
};

type ReturnRow = { settlement_id: string; reason: string; returned_by: string; returned_at: string };

const summaryOf = (s: SettlementRow): SettlementSummary => ({
  id: s.id,
  cycle: s.cycle,
  approved: Number(s.approved_tzs),
  used: Number(s.used_tzs),
  returned: Number(s.returned_tzs),
  unaccounted: Number(s.unaccounted_tzs),
  explanation: s.unaccounted_explanation,
  lineCount: s.line_count,
  noReceiptLines: s.no_receipt_lines,
  settledAt: s.settled_at,
});

const raiseOf = (r: RaiseRow, names: Map<string, string>): Raise => ({
  id: r.id,
  raiseNo: r.raise_no,
  status: r.status,
  amount: Number(r.amount_tzs),
  reason: r.reason,
  requestedById: r.requested_by,
  requestedAt: r.requested_at,
  decidedById: r.decided_by,
  decidedBy: r.decided_by ? (names.get(r.decided_by) ?? "") : "",
  decidedAt: r.decided_at,
  refusalReason: r.refusal_reason,
  handedOutAt: r.handed_out_at,
  recipient: r.recipient,
});

const returnOf = (r: ReturnRow, names: Map<string, string>): SettlementReturn => ({
  settlementId: r.settlement_id,
  reason: r.reason,
  returnedAt: r.returned_at,
  returnedById: r.returned_by,
  returnedBy: names.get(r.returned_by) ?? "",
});

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
  const verified = row.imprest_verifications;
  const raises = [...(row.imprest_approval_raises ?? [])]
    .sort((a, b) => a.raise_no - b.raise_no)
    .map((r) => raiseOf(r, names));
  // What verification posted. Reversals and replacements sit beside the originals and never change
  // them (issue #71).
  const posted = (kind: PostingKind) => {
    const found = (row.imprest_postings ?? []).find((p) => p.kind === kind && p.entry === "original");
    return found ? Number(found.amount_tzs) : null;
  };
  return {
    id: row.id,
    disbursementNo: row.disbursement_no,
    status: row.status,
    version: row.version,
    amount: Number(row.approved_tzs),
    originalAmount: Number(row.amount_tzs),
    raises,
    openRequest: raises.find((r) => r.status === "requested") ?? null,
    awaitingHandOut: raises.find((r) => r.status === "raised") ?? null,
    category: row.category,
    purpose: row.purpose,
    proposedBy: names.get(row.proposed_by) ?? "",
    proposedById: row.proposed_by,
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
    recipient: row.imprest_disbursement_handouts?.recipient ?? null,
    handedOutAt: row.imprest_disbursement_handouts?.handed_out_at ?? null,
    settlement: latest ? summaryOf(latest) : null,
    sentBack: (() => {
      if (row.status !== "sent_back" || !latest) return null;
      const found = (row.imprest_settlement_returns ?? []).find((r) => r.settlement_id === latest.id);
      return found ? returnOf(found, names) : null;
    })(),
    verification: verified
      ? {
          verifiedAt: verified.verified_at,
          verifiedById: verified.verified_by,
          settlementId: verified.settlement_id,
          // NaN when the expense posting did not come back, which `loadDisbursement` refuses.
          expense: posted("expense") ?? Number.NaN,
          loss: posted("unexplained_loss"),
        }
      : null,
    flags: {
      noReceipt: settlements.some((s) => s.no_receipt_lines > 0),
      notAccounted: settlements.some((s) => Number(s.unaccounted_tzs) > 0),
    },
    openReversals: (row.imprest_posting_reversals ?? []).filter((r) => r.status === "requested").length,
  };
}

const ENTRY_ORDER: Record<PostingEntry, number> = { original: 0, reversal: 1, replacement: 2 };

/** Every posting in the order it was posted, a reversal before the replacement posted with it. */
function postingsOf(rows: PostingRow[]): Posting[] {
  const reversed = new Set(rows.filter((p) => p.entry === "reversal").map((p) => p.corrects_posting_id));
  return [...rows]
    .sort(
      (a, b) =>
        a.posted_at.localeCompare(b.posted_at) ||
        ENTRY_ORDER[a.entry] - ENTRY_ORDER[b.entry] ||
        a.kind.localeCompare(b.kind),
    )
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      entry: p.entry,
      amount: Number(p.amount_tzs),
      reversalId: p.reversal_id,
      correctsPostingId: p.corrects_posting_id,
      needsDirectorDecision: p.needs_director_decision,
      postedAt: p.posted_at,
      reversed: reversed.has(p.id),
    }));
}

const reversalOf = (r: ReversalRow, kind: PostingKind, names: Map<string, string>): Reversal => ({
  id: r.id,
  postingId: r.posting_id,
  kind,
  status: r.status,
  version: r.version,
  original: Number(r.original_tzs),
  correct: Number(r.correct_tzs),
  reason: r.reason,
  requestedById: r.requested_by,
  requestedBy: names.get(r.requested_by) ?? "",
  requestedRole: r.requested_role,
  requestedAt: r.requested_at,
  decidedById: r.decided_by,
  decidedBy: r.decided_by ? (names.get(r.decided_by) ?? "") : "",
  decidedAt: r.decided_at,
  rejectionReason: r.rejection_reason,
});

async function page(
  label: string,
  pageNo: number,
  build: (from: number, to: number) => Counted,
): Promise<Page<Disbursement>> {
  const result = await pagedQuery<Row>(pageNo, build, label);
  const names = await namesFor(result.rows.map((row) => row.proposed_by));
  const rows = result.rows.map((row) => fromRow(row, names));
  // A sent-back row always carries the return it is answering. Without it the list would show a
  // Sent back status with no reason, which is a failed read, not a fact.
  if (rows.some((d) => d.status === "sent_back" && !d.sentBack)) {
    throw new Error(`${DATA_UNAVAILABLE}: ${label}.sent_back`);
  }
  return { ...result, rows };
}

/**
 * What each queue is ordered by, oldest first: the moment its current step began. Handed-out rows
 * sort by their one-to-one hand-out; settled rows by `imprest_disbursement_settled_at`, a computed
 * column, because a disbursement may in time carry several settlement cycles.
 */
type QueueOrder =
  | "proposed_at"
  | "approved_at"
  | "imprest_disbursement_handouts(handed_out_at)"
  | "imprest_disbursement_settled_at"
  | "imprest_disbursement_sent_back_at"
  | "imprest_disbursement_raise_requested_at"
  | "imprest_disbursement_reversal_requested_at"
  | "imprest_verifications(verified_at)";

async function byStatus(
  label: string,
  status: DisbursementStatus,
  order: QueueOrder,
  pageNo: number,
  ascending = true,
): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  return page(label, pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .eq("status", status)
      .order(order, { ascending })
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
  byStatus("imprest.handed_out", "handed_out", "imprest_disbursement_handouts(handed_out_at)", pageNo);

/** Settled and waiting for the Manager to verify, longest waiting first. */
export const loadSettledWaiting = (pageNo = 1) =>
  byStatus("imprest.settled_waiting", "settled", "imprest_disbursement_settled_at", pageNo);

/**
 * Sent back and waiting for the Cashier to settle again (issue #65), longest waiting first, ordered
 * by when each was last sent back.
 */
export const loadSentBack = (pageNo = 1) =>
  byStatus("imprest.sent_back", "sent_back", "imprest_disbursement_sent_back_at", pageNo);

/**
 * Handed out or sent back, with a request for a raised approval waiting for the Manager (issue
 * #70), longest waiting first.
 */
export async function loadWaitingForRaise(pageNo = 1): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  const result = await page("imprest.waiting_for_raise", pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .not("imprest_disbursement_raise_requested_at", "is", null)
      .order("imprest_disbursement_raise_requested_at", { ascending: true })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
  // Every row here carries the request it is waiting on. Without it the list would name a waiting
  // request it cannot show, which is a failed read, not a fact.
  if (result.rows.some((d) => !d.openRequest)) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.waiting_for_raise.request`);
  }
  return result;
}

/**
 * Verified payments with a reversal request waiting for a Director (issue #71), longest waiting
 * first. Directors decide; the Manager reads the same list.
 */
export async function loadWaitingForReversal(pageNo = 1): Promise<Page<Disbursement>> {
  const supabase = await createServerSupabase();
  const result = await page("imprest.waiting_for_reversal", pageNo, (from, to) =>
    supabase
      .from("imprest_disbursements")
      .select(COLUMNS, { count: "exact" })
      .not("imprest_disbursement_reversal_requested_at", "is", null)
      .order("imprest_disbursement_reversal_requested_at", { ascending: true })
      .order("id")
      .range(from, to) as unknown as Counted,
  );
  // Every row here carries the request it waits on. Without it the list names one it can't show.
  if (result.rows.some((d) => d.openReversals === 0)) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.waiting_for_reversal.request`);
  }
  return result;
}

/**
 * Verified payments, most recently verified first (issue #64), so the Manager and Directors can
 * find a posted payment again once it has left the settled queue.
 */
export const loadVerified = (pageNo = 1) =>
  byStatus("imprest.verified", "verified", "imprest_verifications(verified_at)", pageNo, false);

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
  settlement_id: string;
  line_no: number;
  amount_tzs: number;
  purpose: string;
  no_receipt_reason: NoReceiptReason | null;
  no_receipt_note: string | null;
  imprest_receipts: { id: string; file_name: string; content_type: string } | null;
};

/**
 * Cycles per read of their lines. A cycle has at most 20 lines, so a batch returns at most 800
 * rows, under the API's 1,000-row cap however many times a payment was sent back.
 */
const CYCLES_PER_READ = 40;

/** The lines of every cycle named, keyed by settlement, each in line order. */
async function loadLines(settlementIds: string[]): Promise<Map<string, SettlementLineView[]>> {
  const byCycle = new Map<string, SettlementLineView[]>(settlementIds.map((id) => [id, []]));
  if (settlementIds.length === 0) return byCycle;
  const supabase = await createServerSupabase();
  const batches: string[][] = [];
  for (let i = 0; i < settlementIds.length; i += CYCLES_PER_READ) {
    batches.push(settlementIds.slice(i, i + CYCLES_PER_READ));
  }
  const rows = (
    await Promise.all(
      batches.map(async (ids) =>
        requireRows(
          (await supabase
            .from("imprest_settlement_lines")
            .select(
              "settlement_id, line_no, amount_tzs, purpose, no_receipt_reason, no_receipt_note, imprest_receipts(id, file_name, content_type)",
            )
            .in("settlement_id", ids)
            .order("settlement_id")
            .order("line_no")) as unknown as { data: LineRow[] | null; error: { message: string } | null },
          "imprest.settlement_lines",
        ),
      ),
    )
  ).flat();
  for (const row of rows) {
    byCycle.get(row.settlement_id)?.push({
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
    });
  }
  return byCycle;
}

/**
 * The receipts earlier cycles cited, newest cycle first and each once, which the Cashier may cite
 * again when settling a sent-back disbursement. Only cited receipts are offered: a cited one is
 * known to be uploaded, where a registered one may never have arrived.
 */
export function earlierReceipts(cycles: SettlementCycle[]): EarlierReceipt[] {
  const seen = new Set<string>();
  const out: EarlierReceipt[] = [];
  for (const cycle of [...cycles].sort((a, b) => b.cycle - a.cycle)) {
    for (const line of cycle.lines) {
      if (!line.receipt || seen.has(line.receipt.id)) continue;
      seen.add(line.receipt.id);
      out.push({ ...line.receipt, cycle: cycle.cycle });
    }
  }
  return out;
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

  const names = await namesFor([
    row.proposed_by,
    row.approved_by,
    row.rejected_by,
    row.cancelled_by,
    row.imprest_verifications?.verified_by ?? null,
    ...(row.imprest_settlement_returns ?? []).map((r) => r.returned_by),
    ...(row.imprest_approval_raises ?? []).map((r) => r.decided_by),
    ...(row.imprest_posting_reversals ?? []).flatMap((r) => [r.requested_by, r.decided_by]),
  ]);
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
  // A sent-back row always carries its hand-out, its settlement and the return of that settlement.
  if (row.status === "sent_back" && (!disbursement.settlement || !disbursement.handedOutAt || !disbursement.sentBack)) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_sent_back`);
  }
  // A verified row always carries its settlement, hand-out, verification and expense, and a loss
  // exactly when the settlement left a remainder. Anything less is a failed read, and showing the
  // rest would present part of the record as the whole of it.
  const v = disbursement.verification;
  if (
    row.status === "verified" &&
    (!disbursement.settlement ||
      !disbursement.handedOutAt ||
      !v ||
      Number.isNaN(v.expense) ||
      disbursement.settlement.unaccounted > 0 !== (v.loss !== null))
  ) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_verification`);
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
  // Every cycle the Cashier settled, and every one the Manager sent back, in order.
  const settlements = [...(row.imprest_settlements ?? [])].sort((a, b) => a.cycle - b.cycle);
  const returns = row.imprest_settlement_returns ?? [];
  for (const s of settlements) {
    events.push({ kind: "settled", at: s.settled_at, by: who(row.proposed_by), role: "cashier", text: null, cycle: s.cycle });
    const back = returns.find((r) => r.settlement_id === s.id);
    if (back) {
      events.push({
        kind: "sent_back",
        at: back.returned_at,
        by: who(back.returned_by),
        role: "manager",
        text: back.reason,
        cycle: s.cycle,
      });
    }
  }
  // Every return belongs to one of the cycles read; one that does not means a cycle is missing.
  if (returns.some((r) => !settlements.some((s) => s.id === r.settlement_id))) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_returns`);
  }
  if (v) {
    events.push({ kind: "verified", at: v.verifiedAt, by: who(v.verifiedById), role: "manager", text: null });
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
  // Every step of every raise: who asked and why, what the Manager decided, and the extra handed out.
  for (const raise of disbursement.raises) {
    events.push({
      kind: "raise_requested",
      at: raise.requestedAt,
      by: who(raise.requestedById),
      role: "cashier",
      text: raise.reason,
    });
    if (raise.status !== "requested") {
      // A decided raise always carries who decided it and when.
      if (!raise.decidedAt || !raise.decidedById) throw new Error(`${DATA_UNAVAILABLE}: imprest.raise_decision`);
      events.push({
        kind: raise.status === "refused" ? "raise_refused" : "raise_raised",
        at: raise.decidedAt,
        by: who(raise.decidedById),
        role: "manager",
        text: raise.status === "refused" ? raise.refusalReason : null,
      });
    }
    if (raise.status === "handed_out") {
      if (!raise.handedOutAt) throw new Error(`${DATA_UNAVAILABLE}: imprest.raise_handout`);
      events.push({
        kind: "raise_handed_out",
        at: raise.handedOutAt,
        by: who(row.proposed_by),
        role: "cashier",
        text: raise.recipient,
      });
    }
  }
  // Corrections (issue #71): each request, its decision, then the reversal and the replacement it
  // posted. Every request names a posting of this payment; every approved one carries its reversal,
  // and a replacement exactly when the correct amount is above zero. Anything less is a failed read.
  const postings = postingsOf(row.imprest_postings ?? []);
  const reversals: Reversal[] = [];
  const byRequest = [...(row.imprest_posting_reversals ?? [])].sort((a, b) =>
    a.requested_at.localeCompare(b.requested_at),
  );
  for (const r of byRequest) {
    const target = postings.find((p) => p.id === r.posting_id);
    if (!target) throw new Error(`${DATA_UNAVAILABLE}: imprest.reversal_posting`);
    const reversal = reversalOf(r, target.kind, names);
    reversals.push(reversal);
    events.push({
      kind: "reversal_requested",
      at: reversal.requestedAt,
      by: reversal.requestedBy,
      role: reversal.requestedRole,
      text: reversal.reason,
      amount: reversal.correct,
      posting: reversal.kind,
    });
    if (reversal.status === "requested") continue;
    if (!reversal.decidedAt || !reversal.decidedById) {
      throw new Error(`${DATA_UNAVAILABLE}: imprest.reversal_decision`);
    }
    events.push({
      kind: reversal.status === "approved" ? "reversal_approved" : "reversal_rejected",
      at: reversal.decidedAt,
      by: reversal.decidedBy,
      role: "director",
      text: reversal.status === "rejected" ? reversal.rejectionReason : null,
    });
    if (reversal.status !== "approved") continue;
    const made = postings.filter((p) => p.reversalId === reversal.id);
    const cancel = made.find((p) => p.entry === "reversal");
    const replacement = made.find((p) => p.entry === "replacement");
    if (!cancel || reversal.correct > 0 !== Boolean(replacement)) {
      throw new Error(`${DATA_UNAVAILABLE}: imprest.reversal_postings`);
    }
    for (const p of replacement ? [cancel, replacement] : [cancel]) {
      events.push({
        kind: p.entry === "reversal" ? "reversal_posted" : "replacement_posted",
        at: p.postedAt,
        by: reversal.decidedBy,
        role: "director",
        text: null,
        amount: p.amount,
        posting: p.kind,
      });
    }
  }

  if (events.some((event) => !event.at)) throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement`);
  // A stable sort, so steps that share a moment (a decision and what it posted) keep their order.
  events.sort((a, b) => a.at.localeCompare(b.at));

  const lines = await loadLines(settlements.map((s) => s.id));
  const cycles: SettlementCycle[] = settlements.map((s) => {
    const back = returns.find((r) => r.settlement_id === s.id);
    return { ...summaryOf(s), lines: lines.get(s.id) ?? [], sentBack: back ? returnOf(back, names) : null };
  });
  if (cycles.some((c) => c.lines.length !== c.lineCount)) {
    throw new Error(`${DATA_UNAVAILABLE}: imprest.settlement_lines`);
  }

  // Whether its fund is retired (issue #72): a retired fund takes no correction.
  const funds = requireRows(
    (await supabase.from("imprest_disbursements").select("imprest_funds(is_active)").eq("id", id)) as unknown as {
      data: { imprest_funds: { is_active: boolean } | null }[] | null;
      error: { message: string } | null;
    },
    "imprest.disbursement_fund",
  );
  const fund = funds[0]?.imprest_funds;
  if (!fund) throw new Error(`${DATA_UNAVAILABLE}: imprest.disbursement_fund`);

  return { ...disbursement, postings, reversals, events, cycles, fundRetired: !fund.is_active };
}
