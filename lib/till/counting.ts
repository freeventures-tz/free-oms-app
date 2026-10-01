/**
 * The till count's rules and words (product.md §15, design.md §7.19, issue #83), with no server
 * imports, so the till forms can share them with the loaders in `counts.ts`.
 */

import { COUNT_EXPLANATIONS, EXPLANATIONS_NEEDING_NOTE } from "@/lib/imprest/counting";

/** design.md §14.7, the same seven reasons the imprest count uses, in their order. */
export const VARIANCE_REASONS = COUNT_EXPLANATIONS;
export type VarianceReason = (typeof VARIANCE_REASONS)[number];

/** These three need a written note of 3 to 500 characters. */
export const REASONS_NEEDING_NOTE = EXPLANATIONS_NEEDING_NOTE;

/** The largest figure a line accepts, matched by the database's own check. */
export const MAX_TILL_TZS = 1_000_000_000_000;

export type TillStatus = "awaiting_confirmation" | "sent_back" | "confirmed";
export type TillOutcome = "balanced" | "shortage" | "excess";

/** One payment method of a count. `counted` and `variance` are null when nothing was counted. */
export type TillLine = {
  line: string;
  expected: number;
  counted: number | null;
  variance: number | null;
};

export type TillCount = {
  id: string;
  businessDate: string;
  attempt: number;
  note: string | null;
  lateReason: string | null;
  status: TillStatus;
  version: number;
  countedBy: string;
  countedAt: string;
  lines: TillLine[];
  expected: number;
  counted: number | null;
  variance: number | null;
  outcome: TillOutcome | null;
  short: number | null;
  over: number | null;
  explanation: VarianceReason | null;
  explanationNote: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  returnReason: string | null;
  returnedBy: string | null;
  returnedAt: string | null;
};

/**
 * What a count's lines add up to. Any line short makes it a Shortage, because an excess on one
 * method never hides money missing from another (§15.1). A line nobody counted makes it unknown,
 * which is `null` and never Balanced (§15.2a).
 */
export function outcomeOf(lines: TillLine[]): TillOutcome | null {
  if (lines.some((l) => l.variance === null)) return null;
  if (lines.some((l) => (l.variance ?? 0) < 0)) return "shortage";
  if (lines.some((l) => (l.variance ?? 0) > 0)) return "excess";
  return "balanced";
}

/** What the lines were short by and over by, each as a positive figure. */
export function shortAndOver(lines: TillLine[]): { short: number; over: number } {
  let short = 0;
  let over = 0;
  for (const l of lines) {
    if (l.variance === null) continue;
    if (l.variance < 0) short -= l.variance;
    else over += l.variance;
  }
  return { short, over };
}

/**
 * Where a day stands. Not counted and Awaiting Manager confirmation are states of their own and
 * never read as a zero variance (§15.2a). Today, before it closes, is due.
 */
export type TillDayState = "due" | "not_counted" | "awaiting_confirmation" | "sent_back" | TillOutcome;

/**
 * One business day as the database resolves it, whoever entered its counts. The state comes from
 * the database and never from figures the viewer happens to be able to read: a Cashier is not sent
 * another Cashier's count, and must still see that the day waits for the Manager.
 */
export type TillDayRow = {
  businessDate: string;
  state: "due" | "not_counted" | "awaiting_confirmation" | TillOutcome;
  notCountedSince: string | null;
  awaitingSince: string | null;
  latestId: string | null;
  latestStatus: TillStatus | null;
  latestReturnReason: string | null;
};

/** What a day's card says: its state, except that a day whose latest count was sent back says so. */
export function dayStateOf(day: TillDayRow | null): TillDayState {
  if (!day) return "due";
  if (day.latestStatus === "sent_back" && (day.state === "due" || day.state === "not_counted")) {
    return day.state === "due" ? "sent_back" : "not_counted";
  }
  return day.state;
}

/** A count's own state: its outcome once confirmed, else where it waits. */
export function countState(c: TillCount): TillDayState {
  if (c.status === "confirmed" && c.outcome) return c.outcome;
  return c.status === "sent_back" ? "sent_back" : "awaiting_confirmation";
}

/** A day that is not closed: it closed with no count standing, or its count waits for the Manager. */
export type OpenTillDay = TillDayRow & { state: "not_counted" | "awaiting_confirmation" };
