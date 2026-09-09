/**
 * The numbers a stock refusal carries, named once (issue #7).
 *
 * The database refuses a stock command for one of two reasons, and they are not the same problem:
 *
 *   `insufficient_stock`             the BUSINESS does not own enough that is not already promised.
 *                                    Carries `physical`, `promised`, `available`, `requested` —
 *                                    all four, because the yard can be full and the answer still
 *                                    no, and a screen that cannot say "eighty are promised" reads
 *                                    as a system arguing with what the person is looking at.
 *
 *   `insufficient_stock_at_location` the business owns enough; this PLACE does not hold it.
 *                                    Carries `location`, `available`, `requested` — and here
 *                                    `available` is the location's own balance, not the §8.1
 *                                    figure. Two reasons, two meanings, on purpose: each is the
 *                                    number that answers its own question.
 *
 * ONE LIST, not one per module. Inventory and production keep their command modules independent by
 * design, but this list is not module logic — it is the shape of what the database sends back. Two
 * copies had already drifted apart once by the time this file was written, and a copy that silently
 * lacks `promised` produces a refusal the interface cannot explain.
 */

/** Every key a stock refusal may carry, whichever of the two rules fired. */
export const STOCK_REFUSAL_FIELDS = [
  "available",
  "requested",
  "promised",
  "physical",
  "location",
] as const;

/** Keys that are a quantity. Everything else stays as it arrived — `Number("store")` is `NaN`. */
const NUMERIC_FIELDS = new Set<string>(["available", "requested", "promised", "physical"]);

/**
 * Whatever the refusal actually carried, coerced once.
 *
 * ABSENT AND NULL BOTH STAY OUT, rather than becoming `NaN` or the string `"null"`. Not every
 * refusal is about stock: `already_settled` must reach the screen with no numbers at all rather
 * than with a set of them reading nonsense, and a null that became `Number(null)` would render as
 * a confident `0` — a wrong figure about stock, which is worse than no figure. A zero itself is
 * NOT absent: `available: 0` is the commonest refusal there is, so this tests for presence rather
 * than for truthiness.
 *
 * `extraFields` keep the value the database sent, untouched. They are production's own refusals —
 * `ready_at` is a timestamp, `status` is a word, `expected` and `confirmed` are recipe counts — and
 * the caller that renders them already knows what each one is.
 */
export function refusalContext(
  data: Record<string, unknown> | null | undefined,
  extraFields: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  const context: Record<string, unknown> = {};

  for (const key of [...STOCK_REFUSAL_FIELDS, ...extraFields]) {
    if (!(key in data) || data[key] === null) continue;
    context[key] = NUMERIC_FIELDS.has(key) ? Number(data[key]) : data[key];
  }

  return Object.keys(context).length > 0 ? context : undefined;
}
