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

/**
 * The same reasoning, extended to a time of day — added for brick production (product.md §11.4).
 *
 * Curing starts at the moulding-completion time and runs for 72 hours, so a batch is the first
 * record in this system where the HOUR decides something. A phone left on another zone would
 * pre-fill a time three hours out and start the countdown in the wrong place, and the deadline
 * shown beside it would disagree with the one the database enforces.
 */

/**
 * The wall clock in the yard, as `<input type="datetime-local">` writes it: `YYYY-MM-DDTHH:mm`.
 *
 * `hourCycle: "h23"` rather than `hour12: false`, because the two are not the same: `hour12:
 * false` resolves to the `h24` cycle in several locales and renders midnight as `24:00`, which no
 * datetime-local input accepts.
 */
const LOCAL_INPUT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function businessParts(instant: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of LOCAL_INPUT_PARTS.formatToParts(instant)) parts[part.type] = part.value;
  return parts;
}

export function businessDateTimeLocal(instant: Date = new Date()): string {
  const p = businessParts(instant);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** How far the business zone is ahead of UTC at a given instant, in milliseconds. */
function businessOffsetMs(instant: Date): number {
  const p = businessParts(instant);
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asIfUtc - instant.getTime();
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` value read as a time IN THE YARD, or `null` if it is not one.
 *
 * `new Date("2026-08-22T14:30")` reads that string in whatever zone the runtime happens to be set
 * to — the browser's on the client, UTC on most servers — so the same typed time became two
 * different instants depending on where it was parsed. Everything downstream of that is wrong by
 * the offset: the curing clock, the 72-hour deadline, and the refusal that compares a moulding
 * time against `now()`.
 *
 * NULL RATHER THAN AN INVALID DATE. `2026-02-30T08:00` is well formed and not a day, and
 * `Date.UTC` rolls it silently into 2 March; the round-trip below is what catches that, and a
 * caller gets an answer it has to handle rather than a plausible wrong instant.
 *
 * The offset is resolved twice because it is a property of the instant, not of the wall clock: the
 * first pass gives an approximate instant, and the second asks the zone what the offset actually
 * was there. Tanzania has kept a fixed +03:00 with no daylight saving since 1961, so the two passes
 * agree — the second one is what keeps this correct if that ever stops being true.
 */
export function instantFromBusinessLocal(value: string): Date | null {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second ?? "0");

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;

  const wallClock = Date.UTC(y, mo - 1, d, h, mi, s);
  const rolled = new Date(wallClock);
  if (
    rolled.getUTCFullYear() !== y ||
    rolled.getUTCMonth() !== mo - 1 ||
    rolled.getUTCDate() !== d
  ) {
    return null;
  }

  const firstPass = new Date(wallClock - businessOffsetMs(rolled));
  return new Date(wallClock - businessOffsetMs(firstPass));
}

/**
 * `en` and `sw` are the app's locales; these are the regional forms they should read in.
 *
 * Exported because a count is formatted the same way a date is — grouped for the reader's region —
 * and a screen that inlines `locale === "sw" ? "sw-TZ" : "en-GB"` is another place to correct if
 * the app ever gains a third language. Added for the daily report (issue #51).
 */
export function intlLocale(locale: string): string {
  return locale === "sw" ? "sw-TZ" : "en-GB";
}

/**
 * A business DATE — `YYYY-MM-DD`, with no time in it — read as a person in the yard would read it.
 *
 * The offset is appended so the answer does not depend on where it is parsed. `new
 * Date("2026-08-24")` is midnight UTC, which lands on the right day in Dar es Salaam but on the day
 * BEFORE in a zone west of Greenwich, and a report headed with yesterday's date is a report about
 * the wrong day. Pinning the instant to 00:00 local makes the answer the same everywhere.
 */
export function formatBusinessDate(value: string, locale: string): string {
  const instant = new Date(`${value}T00:00:00+03:00`);
  if (Number.isNaN(instant.getTime())) return value;

  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: "full",
  }).format(instant);
}

/**
 * A stored instant, rendered in the yard's zone and the reader's language.
 *
 * The formatter is built once per locale and kept, for the reason the receiving board records:
 * constructing an `Intl.DateTimeFormat` resolves locale data every time, and a production board
 * renders several timestamps per card.
 */
const STAMP_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function formatBusinessStamp(iso: string, locale: string): string {
  const tag = locale === "sw" ? "sw-TZ" : "en-GB";
  let formatter = STAMP_FORMATTERS.get(tag);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(tag, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: BUSINESS_TIME_ZONE,
    });
    STAMP_FORMATTERS.set(tag, formatter);
  }
  return formatter.format(new Date(iso));
}
