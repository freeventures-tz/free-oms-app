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

// ---------------------------------------------------------------------------
// Part 2a (issue #62): hand-out and settlement
// ---------------------------------------------------------------------------

/** A recipient is a short name, 2 to 120 characters. The database agrees. */
export const RECIPIENT_MAX = 120;
/** What a settlement line was for, 2 to 120 characters. */
export const LINE_PURPOSE_MAX = 120;
/** A settlement has 0 to 20 lines. */
export const MAX_LINES = 20;

/** The six No-receipt reasons the Owner approved, in the database enum's order. */
export const NO_RECEIPT_REASONS = [
  "vendor_did_not_issue",
  "informal_or_casual_labour",
  "transport_fare",
  "emergency_purchase",
  "receipt_lost_or_damaged",
  "other",
] as const;

export type NoReceiptReason = (typeof NO_RECEIPT_REASONS)[number];

/** These two also need a written explanation of 3 to 500 characters. */
export const REASONS_NEEDING_NOTE: readonly NoReceiptReason[] = ["receipt_lost_or_damaged", "other"];

/** The receipt files accepted: JPEG, PNG, WebP, HEIC and PDF, up to 15 MiB each. */
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"] as const;
export const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;
/** The private bucket receipts are stored in, encrypted. */
export const RECEIPT_BUCKET = "imprest-evidence";
/** How long a link to a stored receipt stays valid. */
export const RECEIPT_LINK_SECONDS = 60;

/**
 * The content type a receipt is filed under. Some phones report HEIC with no type at all, so the
 * file extension decides when the browser does not.
 */
export function receiptType(file: { name: string; type: string }): (typeof RECEIPT_TYPES)[number] | null {
  const type = file.type.toLowerCase();
  if ((RECEIPT_TYPES as readonly string[]).includes(type)) return type as (typeof RECEIPT_TYPES)[number];
  if (type === "image/heif") return "image/heic";
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const byExtension: Record<string, (typeof RECEIPT_TYPES)[number]> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heic",
    pdf: "application/pdf",
  };
  return type === "" || type === "application/octet-stream" ? (byExtension[extension] ?? null) : null;
}

/**
 * The settlement equation (issue #62): Approved = Used + Returned + Not accounted for. Used is the
 * sum of the lines. `over` is how far Used plus Returned goes past Approved, which the database
 * refuses; `unexplained` is what a settlement would record as Not accounted for.
 */
export function settlementFigures(
  approved: number,
  lineAmounts: (number | null)[],
  returned: number | null,
): { used: number; returned: number; unexplained: number; over: number } {
  const used = lineAmounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  const back = returned ?? 0;
  const gap = approved - used - back;
  return { used, returned: back, unexplained: Math.max(0, gap), over: Math.max(0, -gap) };
}
