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
};

/**
 * Where today stands. Not counted and Awaiting Manager confirmation are states of their own and
 * never read as a zero variance (§15.2a).
 */
export type DayState = "not_counted" | "awaiting_confirmation" | "sent_back" | CountOutcome;

/** Today's state from the counts: the latest attempt of today decides it. */
export function dayState(rows: DailyCount[], today: string): { state: DayState; latest: DailyCount | null } {
  const latest = rows
    .filter((c) => c.businessDate === today)
    .reduce<DailyCount | null>((best, c) => (best === null || c.attempt > best.attempt ? c : best), null);
  if (!latest) return { state: "not_counted", latest: null };
  if (latest.status === "confirmed" && latest.outcome) return { state: latest.outcome, latest };
  return { state: latest.status === "sent_back" ? "sent_back" : "awaiting_confirmation", latest };
}
