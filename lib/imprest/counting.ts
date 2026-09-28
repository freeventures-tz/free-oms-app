/**
 * The daily imprest count's rules and words (product.md §13.7 and §15, issue #68), with no server
 * imports, so the count forms can share them with the loaders in `counts.ts`.
 */

/** design.md §14.7, in its order. */
export const COUNT_EXPLANATIONS = [
  "counting_error",
  "recording_error",
  "change_not_returned",
  "amount_correction",
  "suspected_loss_or_theft",
  "under_investigation",
  "other",
] as const;
export type CountExplanation = (typeof COUNT_EXPLANATIONS)[number];

/** These three need a written note of 3 to 500 characters (design.md §14.7). */
export const EXPLANATIONS_NEEDING_NOTE: readonly CountExplanation[] = [
  "suspected_loss_or_theft",
  "under_investigation",
  "other",
];

export type CountStatus = "awaiting_confirmation" | "sent_back" | "confirmed";
export type CountOutcome = "balanced" | "shortage" | "excess";

export type DailyCount = {
  id: string;
  businessDate: string;
  attempt: number;
  counted: number;
  note: string | null;
  /** The figures behind expected cash, as they stood. `null` for a Cashier: never sent to them. */
  postedBalance: number | null;
  awaitingVerification: number | null;
  expected: number;
  /** Counted minus expected: below zero a shortage, above zero an excess. */
  variance: number;
  status: CountStatus;
  version: number;
  countedBy: string;
  countedAt: string;
  outcome: CountOutcome | null;
  explanation: CountExplanation | null;
  explanationNote: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  returnReason: string | null;
  returnedBy: string | null;
  returnedAt: string | null;
  /** A confirmed shortage waits for a Director's accountability decision. */
  needsDirectorDecision: boolean | null;
  /** Why a past Not counted day was counted late (issue #69); `null` for a count on its own day. */
  lateReason: string | null;
};

/**
 * Where a day stands. Not counted and Awaiting Manager confirmation are states of their own and
 * never read as a zero variance (§15.2a). Today, before it closes, is due: a day becomes Not
 * counted only when it closes with no count standing (issue #69).
 */
export type DayState = "due" | "not_counted" | "awaiting_confirmation" | "sent_back" | CountOutcome;

/** Today's state from the counts: the latest attempt of today decides it. */
export function dayState(rows: DailyCount[], today: string): { state: DayState; latest: DailyCount | null } {
  const latest = rows
    .filter((c) => c.businessDate === today)
    .reduce<DailyCount | null>((best, c) => (best === null || c.attempt > best.attempt ? c : best), null);
  if (!latest) return { state: "due", latest: null };
  if (latest.status === "confirmed" && latest.outcome) return { state: latest.outcome, latest };
  return { state: latest.status === "sent_back" ? "sent_back" : "awaiting_confirmation", latest };
}

/**
 * A day of the fund that is not closed (issue #69, §15.2a): it closed with no count standing, or its
 * count waits for the Manager. For Directors and the Manager each one is an open alert.
 */
export type OpenDay = {
  businessDate: string;
  state: "not_counted" | "awaiting_confirmation";
  /** When the day started waiting: the earlier of the two below. */
  waitingSince: string;
  /** Set when the day closed with no count standing, and kept while a late count waits. */
  notCountedSince: string | null;
  /** Set while a count waits for the Manager. */
  awaitingSince: string | null;
  /** The day's latest count, if any. A late recount names it when it was sent back. */
  latestCountId: string | null;
  latestStatus: CountStatus | null;
  latestReturnReason: string | null;
};

/** An alert that has been resolved, kept in the history (issue #69). */
export type ResolvedCountAlert = {
  kind: "not_counted" | "awaiting_confirmation";
  businessDate: string;
  countId: string | null;
  attempt: number | null;
  raisedAt: string;
  resolvedAt: string;
  resolution: "counted_late" | "confirmed" | "sent_back";
};

/**
 * How long something has waited, in the largest unit that reads naturally: under an hour, whole
 * hours up to two days, then whole days. Both instants are absolute, so the server's time zone
 * never enters into it.
 */
export function waitedFor(
  since: string,
  now: Date = new Date(),
): { unit: "lessThanHour" | "hours" | "days"; count: number } {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return { unit: "lessThanHour", count: 0 };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
