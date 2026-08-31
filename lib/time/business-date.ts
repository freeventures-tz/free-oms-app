/**
 * The business day, which is a Tanzanian day and not the reader's day.
 *
 * Free Ventures trades in one place, so "today" has exactly one meaning: the calendar date in
 * `Africa/Dar_es_Salaam`. The database already judges a delivery date against that zone (§15.3),
 * and this is the same answer computed on the server so a form can be filled in with it.
 *
 * It is deliberately NOT derived from the browser. A phone set to another zone, or a laptop a
 * Director carries abroad, would otherwise offer yesterday's or tomorrow's date as today's —
 * silently, and on a record that becomes permanent once approved.
 */
export const BUSINESS_TIME_ZONE = "Africa/Dar_es_Salaam";

/**
 * The business date of an instant, as `YYYY-MM-DD` — the form `<input type="date">` takes.
 *
 * Assembled from `formatToParts` rather than from a formatted string. A locale is free to render
 * `2026-08-30` as `30/08/2026`, so asking for the parts and joining them is the only way to be
 * certain of the shape, whatever the runtime's locale data says.
 */
export function businessDate(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}
