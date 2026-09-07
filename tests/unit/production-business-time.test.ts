import { describe, expect, it } from "vitest";

import {
  businessDateTimeLocal,
  formatBusinessStamp,
  instantFromBusinessLocal,
} from "@/lib/time/business-date";

/**
 * The curing clock is a Tanzanian clock, and this is the file that says so.
 *
 * Brick production is the first record in this system where the HOUR decides something: §11.4 starts
 * curing at the moulding-completion time and opens inspection 72 hours later, and §15.3 makes the
 * business day `Africa/Dar_es_Salaam` — UTC+3 all year, with no daylight saving.
 *
 * The source this was extracted from pre-filled the form from the BROWSER's clock and parsed the
 * result with `new Date(value)`, which reads a zoneless wall-clock string in whatever zone the
 * runtime happens to be set to: the phone's on the client, UTC on the server. A Manager on a phone
 * still set to London would have entered 09:30 and started a curing clock at 11:30 in the yard —
 * silently, on a record that is permanent once approved.
 *
 * EVERY CASE BELOW FIXES ITS INSTANT, and none of them reads the process zone, so this file proves
 * the same thing on a CI runner in UTC and on a laptop anywhere else.
 */
describe("the yard's wall clock", () => {
  it("is three hours ahead of UTC, whatever the process is set to", () => {
    // 21:00 UTC is already midnight tomorrow in Dar es Salaam — the three-hour window where the two
    // calendars disagree, and the one that costs a whole business day.
    expect(businessDateTimeLocal(new Date("2026-08-29T21:00:00Z"))).toBe("2026-08-30T00:00");
    expect(businessDateTimeLocal(new Date("2026-08-30T06:30:00Z"))).toBe("2026-08-30T09:30");
  });

  it("writes midnight as 00:00, which is the only form a datetime-local input accepts", () => {
    // `hour12: false` resolves to the h24 cycle in several locales and renders midnight as 24:00.
    // A browser silently rejects that, and the form would open with an empty time field.
    const midnight = businessDateTimeLocal(new Date("2026-08-29T21:00:00Z"));
    expect(midnight.endsWith("T00:00")).toBe(true);
    expect(midnight).not.toContain("24:");
  });
});

describe("reading a typed time as a time in the yard", () => {
  it("interprets the wall clock in Dar es Salaam, not in UTC", () => {
    const instant = instantFromBusinessLocal("2026-08-22T09:30");
    expect(instant?.toISOString()).toBe("2026-08-22T06:30:00.000Z");
  });

  it("round-trips: what the form shows is the instant the database is sent", () => {
    const shown = businessDateTimeLocal(new Date("2026-08-22T06:30:00Z"));
    expect(instantFromBusinessLocal(shown)?.toISOString()).toBe("2026-08-22T06:30:00.000Z");
  });

  it("does not agree with the naive reading, which is the whole point", () => {
    // What `new Date("2026-08-22T09:30")` would have produced on a UTC server: three hours out, and
    // three hours is the difference between a lot being inspectable and being refused.
    const business = instantFromBusinessLocal("2026-08-22T09:30")!.getTime();
    const naiveUtc = Date.parse("2026-08-22T09:30:00Z");
    expect(naiveUtc - business).toBe(3 * 60 * 60 * 1000);
  });

  it("accepts seconds, and treats a missing seconds field as zero", () => {
    expect(instantFromBusinessLocal("2026-08-22T09:30:45")?.toISOString()).toBe(
      "2026-08-22T06:30:45.000Z",
    );
    expect(instantFromBusinessLocal("2026-08-22T09:30")?.toISOString()).toBe(
      "2026-08-22T06:30:00.000Z",
    );
  });

  it("returns null for a well-formed string that is not a day", () => {
    // `Date.UTC` rolls 30 February into 2 March without complaint. A plausible wrong instant is
    // worse than no answer, because nothing downstream can tell it apart from a real one.
    expect(instantFromBusinessLocal("2026-02-30T08:00")).toBeNull();
    expect(instantFromBusinessLocal("2026-13-01T08:00")).toBeNull();
    expect(instantFromBusinessLocal("2026-08-32T08:00")).toBeNull();
    expect(instantFromBusinessLocal("2026-08-22T24:00")).toBeNull();
    expect(instantFromBusinessLocal("2026-08-22T09:60")).toBeNull();
  });

  it("returns null for anything that is not a wall-clock time at all", () => {
    expect(instantFromBusinessLocal("")).toBeNull();
    expect(instantFromBusinessLocal("yesterday")).toBeNull();
    expect(instantFromBusinessLocal("2026-08-22")).toBeNull();
    expect(instantFromBusinessLocal("2026-08-22T09:30Z")).toBeNull();
  });

  it("keeps the 72-hour deadline where the yard would put it", () => {
    // A batch moulded at 09:30 on Saturday is ready at 09:30 on Tuesday, in the yard's own clock.
    const moulded = instantFromBusinessLocal("2026-08-22T09:30")!;
    const ready = new Date(moulded.getTime() + 72 * 60 * 60 * 1000);
    expect(businessDateTimeLocal(ready)).toBe("2026-08-25T09:30");
  });
});

describe("rendering a stored instant back to a reader", () => {
  it("shows the yard's time in both languages, never the reader's device time", () => {
    const stamp = new Date("2026-08-22T06:30:00Z").toISOString();
    expect(formatBusinessStamp(stamp, "en")).toContain("09:30");
    expect(formatBusinessStamp(stamp, "sw")).toContain("09:30");
  });
});
