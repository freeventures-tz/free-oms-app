/**
 * Money, in whole Tanzanian shillings (architecture.md §5.12, design.md §8.5).
 *
 * There is no floating-point type anywhere near a price. A shilling is the smallest unit the
 * business uses — there are no cents — so a price is an integer, and the only thing that can go
 * wrong is a value too large for one. Prices arrive from PostgREST as `bigint`, which the JSON
 * layer hands over as a JavaScript number; every figure this system deals in is orders of
 * magnitude below `Number.MAX_SAFE_INTEGER`, and `isWholeShillings` refuses anything that is not.
 */

/** Far above any plausible unit price, and matched by the database's own check constraint. */
export const MAX_PRICE_TZS = 100_000_000;

export function isWholeShillings(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * `TZS 1,250,000` — grouped, never abbreviated, never with a decimal artefact.
 *
 * Abbreviation is allowed only on dashboard tiles (§8.5) and this is not one, so a price is always
 * shown in full: a customer is quoted the whole number, and a Director comparing two prices should
 * not have to expand either of them.
 */
export function formatTzs(value: number, locale: string = "en"): string {
  return `TZS ${new Intl.NumberFormat(locale === "sw" ? "sw-TZ" : "en-GB", {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(value)}`;
}

/**
 * What someone typed, turned into shillings — or `null`, which the caller must handle.
 *
 * Accepts the separators people actually use on a phone keypad: spaces, commas and non-breaking
 * spaces. It refuses a decimal point rather than rounding one away, because `12,500.60` is either
 * a mistake or a misunderstanding about what this field holds, and silently discarding the tail
 * would hide both.
 */
export function parseTzs(input: string): number | null {
  const cleaned = input.replace(/[\s ,]/g, "");
  if (cleaned.length === 0) return null;
  if (!/^\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!isWholeShillings(value) || value > MAX_PRICE_TZS) return null;
  return value;
}
