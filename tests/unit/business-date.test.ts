import { describe, expect, it } from "vitest";

import { BUSINESS_TIME_ZONE, businessDate } from "@/lib/time/business-date";

/**
 * The business day is a Tanzanian day.
 *
 * `Africa/Dar_es_Salaam` is UTC+3 all year — East Africa Time observes no daylight saving — so the
 * business date runs three hours ahead of UTC and the two disagree for three hours out of every
 * twenty-four. That window is the whole risk: a receipt entered at 23:30 in Dar es Salaam is dated
 * tomorrow by anything reading UTC, and the delivery date on an approved receipt is permanent.
 *
 * Every case below fixes the instant, so none of this depends on when the suite runs.
 */
describe("the business date", () => {
  it("is the calendar date in Dar es Salaam, not in UTC", () => {
    // 23:59:59.999 UTC on the 29th is already 02:59 on the 30th in Dar es Salaam.
    expect(businessDate(new Date("2026-08-29T23:59:59.999Z"))).toBe("2026-08-30");
  });

  it("has already turned over BEFORE UTC midnight, which is the trap", () => {
    // The three hours where the two calendars disagree. Anything reading UTC here answers the 29th
    // for a delivery the yard would file under the 30th.
    const justBeforeUtcMidnight = new Date("2026-08-29T21:00:00Z");
    expect(businessDate(justBeforeUtcMidnight)).toBe("2026-08-30");
    expect(justBeforeUtcMidnight.toISOString().slice(0, 10)).toBe("2026-08-29");
  });

  it("does not turn over again at UTC midnight itself", () => {
    // 00:00 UTC is 03:00 in Dar es Salaam — the same business day that began three hours earlier.
    expect(businessDate(new Date("2026-08-30T00:00:00Z"))).toBe("2026-08-30");
    expect(businessDate(new Date("2026-08-30T00:00:00.001Z"))).toBe("2026-08-30");
  });

  it("turns over at Dar es Salaam midnight, which is 21:00 UTC", () => {
    expect(businessDate(new Date("2026-08-30T20:59:59.999Z"))).toBe("2026-08-30");
    expect(businessDate(new Date("2026-08-30T21:00:00Z"))).toBe("2026-08-31");
  });

  it("carries the turnover across a month and a year boundary", () => {
    // 21:00 UTC on 31 December is 00:00 on 1 January in Dar es Salaam.
    expect(businessDate(new Date("2026-08-31T21:00:00Z"))).toBe("2026-09-01");
    expect(businessDate(new Date("2026-12-31T20:59:59Z"))).toBe("2026-12-31");
    expect(businessDate(new Date("2026-12-31T21:00:00Z"))).toBe("2027-01-01");
  });

  it("stays UTC+3 in the months a daylight-saving zone would have shifted", () => {
    // EAT observes none. A zone that did would answer 2026-06-30 for the second instant.
    expect(businessDate(new Date("2026-06-30T21:00:00Z"))).toBe("2026-07-01");
    expect(businessDate(new Date("2026-01-31T21:00:00Z"))).toBe("2026-02-01");
  });

  it("pads a single-digit month and day, because the date input takes YYYY-MM-DD", () => {
    // An `<input type="date">` silently ignores "2026-1-5". Assembling from parts is what makes the
    // padding certain rather than a property of whichever locale formatted it.
    expect(businessDate(new Date("2026-01-05T09:00:00Z"))).toBe("2026-01-05");
    expect(businessDate(new Date("2026-01-05T09:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("names the zone the database also judges a delivery date against", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Africa/Dar_es_Salaam");
  });

  it("answers for now without being told an instant", () => {
    expect(businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
