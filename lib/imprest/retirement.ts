import type { CountOutcome, DayState } from "@/lib/imprest/counting";
import type { Page } from "@/lib/settlement/settlement";
import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";

/**
 * Imprest retirement reads (product.md §13.8, issue #72).
 *
 * The Manager submits the fund's retirement and a Director approves or rejects it. Approval closes
 * the fund as a record, and its closing posted balance opens the next fund. Every figure here is the
 * database's, read on each request.
 *
 * A FAILED READ IS NOT AN EMPTY FUND. Each loader throws, so a fund that could not be read is never
 * shown as having nothing unresolved.
 */

/** Something still open in the fund, which stops it retiring. */
export type RetirementBlocker = {
  kind: "disbursement" | "funding" | "raise" | "reversal" | "count";
  /** The payment or funding to open, or the waiting count's id. */
  id: string;
  /** Its number, or the day of a waiting count. */
  number: string;
  status: string;
};

/** What a retired or retiring fund still carries. Retirement resolves none of it. */
export type Unresolved = {
  losses: { postingId: string; disbursementId: string; disbursementNo: string; amount: number }[];
  shortages: { countId: string; businessDate: string; amount: number }[];
  excesses: number;
  notCountedDays: string[];
};

export type OpenRetirement = {
  id: string;
  version: number;
  reason: string;
  submittedBy: string;
  submittedAt: string;
  businessDate: string;
  postedFunding: number;
  closingBalance: number;
  notCountedDays: string[];
  count: { id: string; counted: number; expected: number; variance: number; countedAt: string };
};

/**
 * The active fund as the imprest screen needs it. For a Cashier only `countingStartsOn` is sent; the
 * carried balance and the retirement are posted figures they are not shown.
 */
export type FundState = {
  fundId: string;
  countingStartsOn: string;
  opening: { amount: number; fromFundId: string; retiredAt: string } | null;
  retirement: OpenRetirement | null;
  lastRejected: { reason: string; decidedBy: string; decidedAt: string } | null;
  readiness: {
    businessDate: string;
    blockers: RetirementBlocker[];
    count: { id: string; status: string; counted: number; countedAt: string; closesFund: boolean } | null;
    postedBalance: number;
    unresolved: Unresolved;
  } | null;
};

type Json = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const text = (value: unknown) => String(value ?? "");
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

function unresolvedFrom(raw: Json): Unresolved {
  return {
    losses: list(raw.losses).map((l) => ({
      postingId: text(l.posting_id),
      disbursementId: text(l.disbursement_id),
      disbursementNo: text(l.disbursement_no),
      amount: num(l.amount_tzs),
    })),
    shortages: list(raw.shortages).map((s) => ({
      countId: text(s.count_id),
      businessDate: text(s.business_date),
      amount: num(s.amount_tzs),
    })),
    excesses: num(raw.excesses_tzs ?? 0),
    notCountedDays: (Array.isArray(raw.not_counted_days) ? raw.not_counted_days : []).map(String),
  };
}

async function readJson(fn: string, args: Json, what: string): Promise<Json | null> {
  const api = await userApi();
  const { data, error } = (await api.rpc(fn, args)) as { data: unknown; error: { message: string } | null };
  if (error) {
    console.error(`[data] ${what} failed: ${error.message}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  if (data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  return data as Json;
}

/** The active fund, or `null` before any fund has been opened. */
export async function loadFundState(): Promise<FundState | null> {
  const raw = await readJson("staff_imprest_fund_state", {}, "imprest.fund_state");
  if (!raw) return null;
  const opening = raw.opening as Json | null | undefined;
  const open = raw.retirement as Json | null | undefined;
  const rejected = raw.last_rejected as Json | null | undefined;
  const readiness = raw.readiness as Json | null | undefined;
  const count = readiness?.count as Json | null | undefined;
  return {
    fundId: text(raw.fund_id),
    countingStartsOn: text(raw.counting_starts_on),
    opening: opening
      ? { amount: num(opening.amount_tzs), fromFundId: text(opening.from_fund_id), retiredAt: text(opening.retired_at) }
      : null,
    retirement: open
      ? {
          id: text(open.id),
          version: num(open.version),
          reason: text(open.reason),
          submittedBy: text(open.submitted_by),
          submittedAt: text(open.submitted_at),
          businessDate: text(open.business_date),
          postedFunding: num(open.posted_funding_tzs),
          closingBalance: num(open.closing_balance_tzs),
          notCountedDays: (Array.isArray(open.not_counted_days) ? open.not_counted_days : []).map(String),
          count: {
            id: text((open.count as Json).id),
            counted: num((open.count as Json).counted_tzs),
            expected: num((open.count as Json).expected_tzs),
            variance: num((open.count as Json).variance_tzs),
            countedAt: text((open.count as Json).counted_at),
          },
        }
      : null,
    lastRejected: rejected
      ? { reason: text(rejected.reason), decidedBy: text(rejected.decided_by), decidedAt: text(rejected.decided_at) }
      : null,
    readiness: readiness
      ? {
          businessDate: text(readiness.business_date),
          blockers: list(readiness.blockers).map((b) => ({
            kind: text(b.kind) as RetirementBlocker["kind"],
            id: text(b.id),
            number: text(b.number),
            status: text(b.status),
          })),
          count: count
            ? {
                id: text(count.id),
                status: text(count.status),
                counted: num(count.counted_tzs),
                countedAt: text(count.counted_at),
                closesFund: count.closes_fund === true,
              }
            : null,
          postedBalance: num(readiness.posted_balance_tzs),
          unresolved: unresolvedFrom((readiness.unresolved ?? {}) as Json),
        }
      : null,
  };
}

export const RETIRED_PAGE_SIZE = 10;

export type RetiredFund = {
  fundId: string;
  openedAt: string;
  retiredAt: string;
  closingBalance: number;
  submittedBy: string;
  approvedBy: string;
  lossesWaiting: number;
  lossesWaitingAmount: number;
  shortagesWaiting: number;
  shortagesWaitingAmount: number;
  notCountedDays: number;
};

type RetiredRow = {
  fund_id: string;
  opened_at: string;
  retired_at: string;
  closing_balance_tzs: number;
  submitted_by: string;
  approved_by: string;
  losses_waiting: number;
  losses_waiting_tzs: number;
  shortages_waiting: number;
  shortages_waiting_tzs: number;
  not_counted_days: number;
  total: number;
};

/** One page of retired funds, most recently retired first. Directors and the Manager. */
export async function loadRetiredFunds(page: number): Promise<Page<RetiredFund>> {
  const api = await userApi();
  const fetchPage = async (p: number) =>
    requireRows(
      (await api.rpc("staff_imprest_retired_funds", {
        p_limit: RETIRED_PAGE_SIZE,
        p_offset: (p - 1) * RETIRED_PAGE_SIZE,
      })) as { data: RetiredRow[] | null; error: { message: string } | null },
      "imprest.retired_funds",
    );
  let current = page;
  let rows = await fetchPage(page);
  if (rows.length === 0 && page > 1) {
    const first = await fetchPage(1);
    const total = first.length > 0 ? Number(first[0].total) : 0;
    current = Math.max(1, Math.ceil(total / RETIRED_PAGE_SIZE));
    rows = current === 1 ? first : await fetchPage(current);
  }
  return {
    rows: rows.map((row) => ({
      fundId: row.fund_id,
      openedAt: row.opened_at,
      retiredAt: row.retired_at,
      closingBalance: Number(row.closing_balance_tzs),
      submittedBy: row.submitted_by,
      approvedBy: row.approved_by,
      lossesWaiting: Number(row.losses_waiting),
      lossesWaitingAmount: Number(row.losses_waiting_tzs),
      shortagesWaiting: Number(row.shortages_waiting),
      shortagesWaitingAmount: Number(row.shortages_waiting_tzs),
      notCountedDays: Number(row.not_counted_days),
    })),
    page: current,
    pageSize: RETIRED_PAGE_SIZE,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

export type FundRecord = {
  fundId: string;
  isActive: boolean;
  openedAt: string;
  retiredAt: string | null;
  figures: {
    opening: number;
    postedFunding: number;
    expenses: number;
    losses: number;
    shortages: number;
    excesses: number;
    postedBalance: number;
  };
  carriedFrom: { fundId: string; amount: number } | null;
  carriedInto: { fundId: string; amount: number; postedAt: string } | null;
  retirements: {
    id: string;
    status: "submitted" | "approved" | "rejected";
    reason: string;
    businessDate: string;
    closingBalance: number;
    notCountedDays: string[];
    submittedBy: string;
    submittedAt: string;
    decidedBy: string | null;
    decidedAt: string | null;
    rejectionReason: string | null;
  }[];
  unresolved: Unresolved;
  days: { businessDate: string; state: DayState }[];
  counts: {
    id: string;
    businessDate: string;
    attempt: number;
    status: string;
    counted: number;
    expected: number;
    variance: number;
    outcome: CountOutcome | null;
    countedBy: string;
    countedAt: string;
    lateReason: string | null;
  }[];
  fundings: {
    id: string;
    fundingNo: string;
    status: string;
    requested: number;
    received: number | null;
    requestedAt: string;
  }[];
  postings: {
    id: string;
    disbursementId: string;
    disbursementNo: string;
    kind: "expense" | "unexplained_loss";
    entry: "original" | "reversal" | "replacement";
    amount: number;
    postedAt: string;
  }[];
};

/** One fund's whole record, or `null` when there is no such fund. Directors and the Manager. */
export async function loadFundRecord(fundId: string): Promise<FundRecord | null> {
  const raw = await readJson("staff_imprest_fund_record", { p_fund_id: fundId }, "imprest.fund_record");
  if (!raw) return null;
  const f = (raw.figures ?? {}) as Json;
  const from = raw.carried_from as Json | null;
  const into = raw.carried_into as Json | null;
  return {
    fundId: text(raw.fund_id),
    isActive: raw.is_active === true,
    openedAt: text(raw.opened_at),
    retiredAt: raw.retired_at ? text(raw.retired_at) : null,
    figures: {
      opening: num(f.opening_tzs),
      postedFunding: num(f.posted_funding_tzs),
      expenses: num(f.expenses_tzs),
      losses: num(f.losses_tzs),
      shortages: num(f.shortages_tzs),
      excesses: num(f.excesses_tzs),
      postedBalance: num(f.posted_balance_tzs),
    },
    carriedFrom: from ? { fundId: text(from.fund_id), amount: num(from.amount_tzs) } : null,
    carriedInto: into
      ? { fundId: text(into.fund_id), amount: num(into.amount_tzs), postedAt: text(into.posted_at) }
      : null,
    retirements: list(raw.retirements).map((r) => ({
      id: text(r.id),
      status: text(r.status) as FundRecord["retirements"][number]["status"],
      reason: text(r.reason),
      businessDate: text(r.business_date),
      closingBalance: num(r.closing_balance_tzs),
      notCountedDays: (Array.isArray(r.not_counted_days) ? r.not_counted_days : []).map(String),
      submittedBy: text(r.submitted_by),
      submittedAt: text(r.submitted_at),
      decidedBy: r.decided_by ? text(r.decided_by) : null,
      decidedAt: r.decided_at ? text(r.decided_at) : null,
      rejectionReason: r.rejection_reason ? text(r.rejection_reason) : null,
    })),
    unresolved: unresolvedFrom((raw.unresolved ?? {}) as Json),
    days: list(raw.days).map((d) => ({ businessDate: text(d.business_date), state: text(d.state) as DayState })),
    counts: list(raw.counts).map((c) => ({
      id: text(c.id),
      businessDate: text(c.business_date),
      attempt: num(c.attempt),
      status: text(c.status),
      counted: num(c.counted_tzs),
      expected: num(c.expected_tzs),
      variance: num(c.variance_tzs),
      outcome: c.outcome ? (text(c.outcome) as CountOutcome) : null,
      countedBy: text(c.counted_by),
      countedAt: text(c.counted_at),
      lateReason: c.late_reason ? text(c.late_reason) : null,
    })),
    fundings: list(raw.fundings).map((x) => ({
      id: text(x.id),
      fundingNo: text(x.funding_no),
      status: text(x.status),
      requested: num(x.requested_amount_tzs),
      received: x.received_amount_tzs === null || x.received_amount_tzs === undefined ? null : num(x.received_amount_tzs),
      requestedAt: text(x.requested_at),
    })),
    postings: list(raw.postings).map((p) => ({
      id: text(p.id),
      disbursementId: text(p.disbursement_id),
      disbursementNo: text(p.disbursement_no),
      kind: text(p.kind) as "expense" | "unexplained_loss",
      entry: text(p.entry) as "original" | "reversal" | "replacement",
      amount: num(p.amount_tzs),
      postedAt: text(p.posted_at),
    })),
  };
}

/**
 * The deficit a retired fund shows (design.md §7B.12): unexplained losses and count shortages, in
 * full. A count excess is shown beside it and never nets it away.
 */
export function deficitOf(unresolved: Pick<Unresolved, "losses" | "shortages">): number {
  return (
    unresolved.losses.reduce((sum, l) => sum + l.amount, 0) +
    unresolved.shortages.reduce((sum, s) => sum + s.amount, 0)
  );
}
