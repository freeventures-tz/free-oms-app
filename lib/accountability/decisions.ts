import { userApi } from "@/lib/supabase/api";
import { DATA_UNAVAILABLE } from "@/lib/supabase/query";

/**
 * Accountability decisions (issue #84, product.md §15).
 *
 * A Director records who is accountable for an imprest unexplained loss or a confirmed imprest
 * count shortage. The decision is a record only: it posts nothing and has no payroll effect. The
 * database derives the Director from the session, refuses every other role on the audit trail, and
 * allows one decision per subject, never changed.
 *
 * A FAILED READ IS NOT AN EMPTY LIST. The loader throws, so a list that could not be read is never
 * shown as "nothing is waiting".
 */

export type SubjectType = "imprest_unexplained_loss" | "imprest_count_shortage";

export type Undecided = {
  subjectType: SubjectType;
  subjectId: string;
  amount: number;
  postedAt: string;
  fundRetired: boolean;
  /** The explanation given when it posted: the settlement's, or the count confirmation's preset. */
  explanation: string | null;
  explanationNote: string | null;
  /** A loss: the payment it came from. */
  disbursementId: string | null;
  disbursementNo: string | null;
  purpose: string | null;
  proposedBy: string | null;
  /** A replacement loss posted by a reversal, rather than the original. */
  replacement: boolean;
  /** A shortage: the day counted and who counted and confirmed it. */
  businessDate: string | null;
  countedBy: string | null;
  confirmedBy: string | null;
};

export type Decision = {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  decision: string;
  nobodyIdentified: boolean;
  responsible: { id: string; name: string }[];
  decidedBy: string;
  decidedAt: string;
  amount: number;
  /** A loss: the payment it came from. A shortage: the day counted. */
  disbursementId: string | null;
  disbursementNo: string | null;
  businessDate: string | null;
};

export type StaffOption = { id: string; name: string; role: string; active: boolean };

export type AccountabilityQueue = { undecided: Undecided[]; decided: Decision[]; staff: StaffOption[] };

type Json = Record<string, unknown>;

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const text = (value: unknown) => String(value ?? "");
const maybe = (value: unknown) => (value === null || value === undefined ? null : String(value));

export function decisionFrom(raw: Json): Decision {
  return {
    id: text(raw.id),
    subjectType: text(raw.subject_type) as SubjectType,
    subjectId: text(raw.subject_id),
    decision: text(raw.decision),
    nobodyIdentified: raw.nobody_identified === true,
    responsible: list(raw.responsible).map((s) => ({ id: text(s.id), name: text(s.full_name) })),
    decidedBy: text(raw.decided_by_name),
    decidedAt: text(raw.decided_at),
    amount: Number(raw.amount_tzs ?? 0),
    disbursementId: maybe(raw.disbursement_id),
    disbursementNo: maybe(raw.disbursement_no),
    businessDate: maybe(raw.business_date),
  };
}

export function queueFrom(raw: Json): AccountabilityQueue {
  return {
    undecided: list(raw.undecided).map((u) => ({
      subjectType: text(u.subject_type) as SubjectType,
      subjectId: text(u.subject_id),
      amount: Number(u.amount_tzs),
      postedAt: text(u.posted_at),
      fundRetired: u.fund_retired === true,
      explanation: maybe(u.explanation),
      explanationNote: maybe(u.explanation_note),
      disbursementId: maybe(u.disbursement_id),
      disbursementNo: maybe(u.disbursement_no),
      purpose: maybe(u.purpose),
      proposedBy: maybe(u.proposed_by_name),
      replacement: u.entry === "replacement",
      businessDate: maybe(u.business_date),
      countedBy: maybe(u.counted_by_name),
      confirmedBy: maybe(u.confirmed_by_name),
    })),
    decided: list(raw.decided).map(decisionFrom),
    staff: list(raw.staff).map((s) => ({
      id: text(s.id),
      name: text(s.full_name),
      role: text(s.role),
      active: s.is_active === true,
    })),
  };
}

/** Everything the Directors' screen shows, in one read. Directors only; throws on failure. */
export async function loadAccountabilityQueue(): Promise<AccountabilityQueue> {
  const api = await userApi();
  const { data, error } = (await api.rpc("admin_accountability_queue")) as {
    data: unknown;
    error: { message: string } | null;
  };
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    if (error) console.error(`[data] accountability.queue failed: ${error.message}`);
    throw new Error(`${DATA_UNAVAILABLE}: accountability.queue`);
  }
  return queueFrom(data as Json);
}

export type DecisionResult = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * Only an error that carries a code is an answer; one without may follow a commit, so it is
 * `unconfirmed` and Try again resends the same key to find out.
 */
export async function recordDecision(input: {
  subjectType: SubjectType;
  subjectId: string;
  decision: string;
  nobodyIdentified: boolean;
  responsibleStaff: string[];
  idempotencyKey: string;
}): Promise<DecisionResult> {
  const api = await userApi();
  const { data, error } = await api.rpc("admin_record_accountability_decision", {
    p_subject_type: input.subjectType,
    p_subject_id: input.subjectId,
    p_decision: input.decision,
    p_nobody_identified: input.nobodyIdentified,
    p_responsible_staff: input.responsibleStaff,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) {
    if (!error.code) return { ok: false, reason: "unconfirmed" };
    if (/not a live Director|authenticated session/i.test(error.message)) {
      return { ok: false, reason: "director_only" };
    }
    return { ok: false, reason: "generic" };
  }
  const result = (data ?? {}) as Json;
  if (result.ok === true) return { ok: true, reason: text(result.reason) };
  return { ok: false, reason: typeof result.reason === "string" ? result.reason : "generic" };
}
