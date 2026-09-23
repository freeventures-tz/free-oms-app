/**
 * What the screen may say about a report's digest — and it is said in two places.
 *
 * Apart from `reports.ts` for the reason `lib/settlement/methods.ts` is apart from `commands.ts`:
 * that file imports the server Supabase client, which reaches `next/headers` and cannot exist in a
 * browser bundle. Both the archive card and the detail card are Client Components and both state
 * the same finding, so the vocabulary they share has to live somewhere neither of them drags the
 * server into.
 */

export type ReportIntegrity = "verified" | "failed" | "unknown";

/**
 * `public.daily_reports` recomputes the SHA-256 from the stored snapshot on every read, so:
 *
 *   `true`   the bytes still match the value written beside them.
 *   `false`  they do not — a real finding, not a formatting detail.
 *   nothing  the check itself did not come back, which is a THIRD answer and is shown as one.
 *            Claiming a report is verified when nothing verified it is the one lie available here.
 */
export function integrityOf(ok: unknown): ReportIntegrity {
  if (ok === true) return "verified";
  if (ok === false) return "failed";
  return "unknown";
}

/**
 * Tone reinforces the finding; it never carries it (design.md §11.5). The word is always beside the
 * colour, which is why `failed` and `unknown` are still distinguishable to a reader who cannot
 * separate red from amber.
 */
export const INTEGRITY_TONE: Record<ReportIntegrity, "success" | "danger" | "attention"> = {
  verified: "success",
  failed: "danger",
  unknown: "attention",
};
