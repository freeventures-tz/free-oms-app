/**
 * Imprest spending values and rules that need no database (issue #55). Safe to import from the
 * browser and from unit tests.
 */

/** The nine imprest spending categories (design.md §14.4), in the database enum's order. */
export const IMPREST_CATEGORIES = [
  "fuel_and_lubricants",
  "labour_and_casual_workers",
  "transport_and_delivery",
  "meals_and_staff_welfare",
  "materials_and_supplies",
  "repairs_and_maintenance",
  "utilities",
  "fees_and_charges",
  "other",
] as const;

export type ImprestCategory = (typeof IMPREST_CATEGORIES)[number];

/** A purpose is short: 3 to 120 characters, where a reason may run to 500. The database agrees. */
export const PURPOSE_MAX = 120;

/** Distinct purposes in first-seen order, compared without regard to case or spacing. */
export function distinctPurposes(purposes: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const purpose of purposes) {
    const tidy = purpose.replace(/\s+/g, " ").trim();
    const key = tidy.toLowerCase();
    if (!tidy || seen.has(key)) continue;
    seen.add(key);
    out.push(tidy);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * How long an approval has been open, in the largest whole unit (issue #55 AC 7). Approvals do not
 * expire in this release, so this is information, not a countdown.
 */
export function openFor(
  since: string,
  now: Date = new Date(),
): { unit: "minutes" | "hours" | "days"; count: number } {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
