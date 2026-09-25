import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import { pagedQuery, type Page } from "@/lib/settlement/settlement";

/**
 * Imprest funding reads (product.md §13.2, issue #48).
 *
 * A FAILED READ IS NOT AN EMPTY FUND. Every loader throws through `requireRows` so the shell's
 * error boundary says the page could not be loaded, rather than showing no history or a total of
 * zero that nobody could tell from the truth.
 *
 * Posted funding, set aside and Free to approve are read with the disbursements (issue #55), from
 * `lib/imprest/disbursements.ts`, so all three come from one calculation in the database.
 */

export type FundingStatus =
  | "requested"
  | "approved"
  | "provided"
  | "disputed"
  | "received"
  | "rejected";

export type FundingSummary = {
  id: string;
  fundingNo: string;
  status: FundingStatus;
  version: number;
  requestedAmount: number;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approvedAmount: number | null;
  handoverId: string | null;
  providedAmount: number | null;
  disputedCounted: number | null;
  rejectionReason: string | null;
  receivedAmount: number | null;
};

export type FundingEvent =
  | { kind: "requested"; at: string; by: string; amount: number; text: string }
  | { kind: "approved"; at: string; by: string; amount: number; text: string | null; sequence: number }
  | { kind: "provided"; at: string; by: string; amount: number; text: string | null; cycle: number }
  | { kind: "mismatch"; at: string; by: string; amount: number; text: string | null; provided: number }
  | { kind: "rejected"; at: string; by: string; text: string }
  | { kind: "received"; at: string; by: string; amount: number };

export type FundingDetail = FundingSummary & { events: FundingEvent[] };

const SUMMARY_COLUMNS = `
  id, funding_no, status, version, requested_amount_tzs, reason, requested_at,
  approved_amount_tzs, handover_id, provided_amount_tzs, disputed_counted_tzs,
  rejection_reason, received_amount_tzs, requested_by
`;

type SummaryRow = {
  id: string;
  funding_no: string;
  status: FundingStatus;
  version: number;
  requested_amount_tzs: number;
  reason: string;
  requested_at: string;
  requested_by: string;
  approved_amount_tzs: number | null;
  handover_id: string | null;
  provided_amount_tzs: number | null;
  disputed_counted_tzs: number | null;
  rejection_reason: string | null;
  received_amount_tzs: number | null;
};

const num = (value: number | string | null) => (value === null ? null : Number(value));

function summaryFrom(row: SummaryRow, names: Map<string, string>): FundingSummary {
  return {
    id: row.id,
    fundingNo: row.funding_no,
    status: row.status,
    version: row.version,
    requestedAmount: Number(row.requested_amount_tzs),
    reason: row.reason,
    requestedBy: names.get(row.requested_by) ?? "",
    requestedAt: row.requested_at,
    approvedAmount: num(row.approved_amount_tzs),
    handoverId: row.handover_id,
    providedAmount: num(row.provided_amount_tzs),
    disputedCounted: num(row.disputed_counted_tzs),
    rejectionReason: row.rejection_reason,
    receivedAmount: num(row.received_amount_tzs),
  };
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const supabase = await createServerSupabase();
  const rows = requireRows(
    await supabase.from("profiles").select("id, full_name").in("id", unique),
    "imprest.names",
  );
  return new Map(rows.map((row) => [String(row.id), String(row.full_name ?? "")]));
}

export async function loadFundings(page = 1): Promise<Page<FundingSummary>> {
  const supabase = await createServerSupabase();
  const result = await pagedQuery<SummaryRow>(
    page,
    (from, to) =>
      supabase
        .from("imprest_funding_summaries")
        .select(SUMMARY_COLUMNS, { count: "exact" })
        .order("requested_at", { ascending: false })
        .order("id")
        .range(from, to) as unknown as PromiseLike<{
        data: SummaryRow[] | null;
        error: { message: string; code?: string } | null;
        count: number | null;
      }>,
    "imprest.fundings",
  );
  const names = await namesFor(result.rows.map((row) => row.requested_by));
  return { ...result, rows: result.rows.map((row) => summaryFrom(row, names)) };
}

/** One funding with its whole history, or `null` when it does not exist. A failed read throws. */
export async function loadFunding(id: string): Promise<FundingDetail | null> {
  const supabase = await createServerSupabase();
  const [summaries, approvals, handovers, mismatches, receipt] = await Promise.all([
    supabase.from("imprest_funding_summaries").select(SUMMARY_COLUMNS).eq("id", id),
    supabase
      .from("imprest_funding_approvals")
      .select("sequence, amount_tzs, note, approved_by, approved_at")
      .eq("funding_id", id),
    supabase
      .from("imprest_funding_handovers")
      .select("id, cycle, amount_tzs, explanation, provided_by, provided_at")
      .eq("funding_id", id),
    supabase
      .from("imprest_funding_mismatches")
      .select("handover_id, counted_tzs, note, reported_by, reported_at")
      .eq("funding_id", id),
    supabase
      .from("imprest_fundings")
      .select("rejected_by, rejected_at, received_by, received_at")
      .eq("id", id),
  ]);

  const summaryRows = requireRows(summaries as { data: SummaryRow[] | null; error: null }, "imprest.funding");
  const approvalRows = requireRows(approvals, "imprest.approvals");
  const handoverRows = requireRows(handovers, "imprest.handovers");
  const mismatchRows = requireRows(mismatches, "imprest.mismatches");
  const receiptRows = requireRows(receipt, "imprest.receipt");

  const row = summaryRows[0];
  if (!row) return null;
  if (!receiptRows[0]) throw new Error(`${DATA_UNAVAILABLE}: imprest.receipt`);
  const finals = receiptRows[0];

  const names = await namesFor([
    row.requested_by,
    ...approvalRows.map((a) => a.approved_by),
    ...handoverRows.map((h) => h.provided_by),
    ...mismatchRows.map((m) => m.reported_by),
    finals.rejected_by,
    finals.received_by,
  ]);
  const who = (id: string | null) => (id ? (names.get(id) ?? "") : "");
  const handoverAmount = new Map(handoverRows.map((h) => [h.id, Number(h.amount_tzs)]));

  const events: FundingEvent[] = [
    {
      kind: "requested",
      at: row.requested_at,
      by: who(row.requested_by),
      amount: Number(row.requested_amount_tzs),
      text: row.reason,
    },
    ...approvalRows.map(
      (a): FundingEvent => ({
        kind: "approved",
        at: a.approved_at,
        by: who(a.approved_by),
        amount: Number(a.amount_tzs),
        text: a.note,
        sequence: a.sequence,
      }),
    ),
    ...handoverRows.map(
      (h): FundingEvent => ({
        kind: "provided",
        at: h.provided_at,
        by: who(h.provided_by),
        amount: Number(h.amount_tzs),
        text: h.explanation,
        cycle: h.cycle,
      }),
    ),
    ...mismatchRows.map(
      (m): FundingEvent => ({
        kind: "mismatch",
        at: m.reported_at,
        by: who(m.reported_by),
        amount: Number(m.counted_tzs),
        text: m.note,
        provided: handoverAmount.get(m.handover_id) ?? 0,
      }),
    ),
  ];
  if (finals.rejected_at) {
    events.push({
      kind: "rejected",
      at: finals.rejected_at,
      by: who(finals.rejected_by),
      text: row.rejection_reason ?? "",
    });
  }
  if (finals.received_at && row.received_amount_tzs !== null) {
    events.push({
      kind: "received",
      at: finals.received_at,
      by: who(finals.received_by),
      amount: Number(row.received_amount_tzs),
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  return { ...summaryFrom(row, names), events };
}
