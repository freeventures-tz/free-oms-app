import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { toReportFailureAlert, type ReportFailureAlert } from "@/lib/reports/alerts";

/**
 * The alert a Director is shown when a night produced no report at all (issue #19).
 *
 * Four things are worth a unit test and the rest is not:
 *
 *   1. WHAT A ROW IS ALLOWED TO BECOME. The mapping is where an unrecognised row could be turned
 *      into a confident sentence about a total scheduled failure. It must REFUSE THE WHOLE READ
 *      rather than quietly drop the row: every row this view returns is a night with no report, so
 *      a dropped one is a missing night nobody is told about.
 *   2. THAT THE ALERT NAMES THE NIGHT AND SAYS EVERY ATTEMPT FAILED. Those two facts are the whole
 *      point of the region; a heading on its own is not actionable.
 *   3. THAT IT OFFERS NOTHING TO PRESS. Issue #19 gives the application no retry and no dismissal,
 *      and a control here would tell a Director they had fixed something they had not.
 *   4. THAT IT ANNOUNCES ASSERTIVELY. It reports a business failure, so it carries this project's
 *      `role="alert"` rather than the politeness a loading skeleton uses.
 *
 * IT IS A SERVER COMPONENT NOW, so it is rendered the way one is: awaited, then handed to
 * `render` as the element it returned. `next-intl/server` is stood in for with next-intl's own
 * `createTranslator` over the real dictionaries — so the messages, the placeholders and the
 * Swahili are all genuinely exercised, and only the request context is replaced.
 */

const intl = vi.hoisted(() => ({ locale: "en" as "en" | "sw" }));

vi.mock("next-intl/server", async () => {
  // `createTranslator` is typed against the app's own message tree, and this stand-in takes the
  // namespace as a plain string because it is handed whatever the component asks for. The
  // dictionaries underneath are the real ones, so nothing about the translation itself is faked.
  const create = (await import("next-intl")).createTranslator as unknown as (options: {
    locale: string;
    messages: Record<string, unknown>;
    namespace: string;
  }) => (key: string, values?: Record<string, unknown>) => string;

  const dictionaries: Record<string, Record<string, unknown>> = {
    en: (await import("@/messages/en.json")).default,
    sw: (await import("@/messages/sw.json")).default,
  };

  return {
    getLocale: async () => intl.locale,
    getTranslations: async (namespace: string) =>
      create({ locale: intl.locale, messages: dictionaries[intl.locale]!, namespace }),
  };
});

// Imported after the mock is declared, because the component reads `next-intl/server` at module
// scope. `vi.mock` is hoisted above both, so the order here is for the reader.
const { ReportFailureAlerts } = await import("@/app/(app)/reports/report-alerts");

const ALERT: ReportFailureAlert = {
  id: "3f2a91c4-5b6d-4e08-9a71-2c8e4d1f6b03",
  businessDate: "2026-08-27",
  type: "scheduled_report_failed",
  priority: "high",
  raisedAt: "2026-08-28T21:30:00Z",
};

async function renderAlerts(alerts: ReportFailureAlert[], locale: "en" | "sw" = "en") {
  intl.locale = locale;
  return render(await ReportFailureAlerts({ alerts }));
}

beforeEach(() => {
  intl.locale = "en";
  // The mapping logs the shape it refused; the assertions below are about the throw, not the log.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("mapping an alert row", () => {
  const row = {
    id: "3f2a91c4-5b6d-4e08-9a71-2c8e4d1f6b03",
    business_date: "2026-08-27",
    alert_type: "scheduled_report_failed",
    priority: "high",
    raised_at: "2026-08-28T21:30:00Z",
  };

  it("keeps the business date and the priority the database decided", () => {
    expect(toReportFailureAlert(row)).toEqual(ALERT);
  });

  it("refuses the read for a row of a kind this build has no wording for", () => {
    expect(() => toReportFailureAlert({ ...row, alert_type: "reconciliation_missing" })).toThrow(
      /data_unavailable/,
    );
  });

  it("refuses the read for a row that is not high priority, rather than promoting it", () => {
    expect(() => toReportFailureAlert({ ...row, priority: "low" })).toThrow(/data_unavailable/);
  });

  it("refuses the read for a row with no business date, because the night is the whole message", () => {
    expect(() => toReportFailureAlert({ ...row, business_date: null })).toThrow(/data_unavailable/);
  });

  it("refuses the read for a row with no raised time, rather than inventing an empty one", () => {
    expect(() => toReportFailureAlert({ ...row, raised_at: undefined })).toThrow(/data_unavailable/);
  });

  // A string of the right TYPE is not a value of the right KIND, and every case below reached the
  // screen before: an empty id collapses two alerts into one React child, and a date that is not a
  // date renders as `Invalid Date` beside the words "has no report".
  it.each([
    ["an empty id", { id: "" }],
    ["an id that is not a uuid", { id: "not-a-uuid" }],
    ["a uuid missing a section", { id: "a1b2c3d4-e5f6-7890-abcd" }],
    ["an empty business date", { business_date: "" }],
    ["a business date that is not a date", { business_date: "yesterday" }],
    ["a business date with the wrong shape", { business_date: "27/08/2026" }],
    ["a calendar day that does not exist", { business_date: "2026-02-31" }],
    ["an empty raised time", { raised_at: "" }],
    ["a raised time of only spaces", { raised_at: "   " }],
    ["a raised time that is not a timestamp", { raised_at: "some time on Friday" }],
    // Everything below was accepted by the old `new Date(value)` check, and each one is a
    // different way for a wrong time to reach a Director's screen looking authoritative.
    ["a bare zero", { raised_at: "0" }],
    ["a bare number", { raised_at: "123" }],
    ["a year on its own", { raised_at: "2026" }],
    ["a date with no time", { raised_at: "2026-08-28" }],
    ["a locale-formatted date", { raised_at: "August 28, 2026" }],
    ["a US-style date", { raised_at: "8/28/2026" }],
    ["an instant with NO timezone, which JavaScript reads in the server's", {
      raised_at: "2026-08-28T21:30:00",
    }],
    ["a calendar day that does not exist", { raised_at: "2026-02-31T00:00:00Z" }],
    ["a month that does not exist", { raised_at: "2026-13-01T00:00:00Z" }],
    ["an hour that does not exist", { raised_at: "2026-08-28T25:00:00Z" }],
    ["a minute that does not exist", { raised_at: "2026-08-28T21:61:00Z" }],
    ["a trailing offset with no digits", { raised_at: "2026-08-28T21:30:00+" }],
  ])("refuses the read for %s", (_name, override) => {
    expect(() => toReportFailureAlert({ ...row, ...override })).toThrow(/data_unavailable/);
  });

  it.each([
    ["a UTC instant with Z", "2026-08-28T21:30:00Z"],
    ["fractional seconds", "2026-08-28T21:30:00.123456Z"],
    ["a numeric offset", "2026-08-29T00:30:00+03:00"],
    ["a negative offset", "2026-08-28T18:30:00-03:00"],
    ["an offset without its colon", "2026-08-29T00:30:00+0300"],
    ["a space instead of T, as psql renders it", "2026-08-28 21:30:00+00:00"],
    ["a leap-day instant", "2028-02-29T12:00:00Z"],
  ])("accepts %s", (_name, raised) => {
    expect(toReportFailureAlert({ ...row, raised_at: raised }).raisedAt).toBe(raised);
  });

  it("accepts the shapes the database really produces", () => {
    expect(toReportFailureAlert({ ...row, id: row.id.toUpperCase() }).id).toBe(row.id.toUpperCase());
    expect(toReportFailureAlert({ ...row, business_date: "2026-02-28" }).businessDate).toBe(
      "2026-02-28",
    );
    // A leap day is a real night, and a naive month-length check would refuse it.
    expect(toReportFailureAlert({ ...row, business_date: "2028-02-29" }).businessDate).toBe(
      "2028-02-29",
    );
  });

  it("names the read and nothing from the row, so no database value reaches the page", () => {
    let thrown = "";
    try {
      toReportFailureAlert({ ...row, alert_type: "something_else", id: "leaky-identifier" });
    } catch (error) {
      thrown = (error as Error).message;
    }

    expect(thrown).toBe("data_unavailable: reports.failureAlerts");
    expect(thrown).not.toContain("leaky-identifier");
  });

  it("logs which fields were unusable and none of their values", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      toReportFailureAlert({
        id: "leaky-identifier",
        business_date: "leaky-date",
        alert_type: "leaky-type",
        priority: "leaky-priority",
        raised_at: "leaky-timestamp",
      }),
    ).toThrow();

    const line = logged.mock.calls.map((call) => call.join(" ")).join("\n");

    // It says WHICH columns were wrong, because that is what an operator needs to find the row.
    expect(line).toContain("id");
    expect(line).toContain("business_date");
    expect(line).toContain("alert_type");
    expect(line).toContain("priority");
    expect(line).toContain("raised_at");

    // And it says nothing about what was IN them.
    for (const value of [
      "leaky-identifier",
      "leaky-date",
      "leaky-type",
      "leaky-priority",
      "leaky-timestamp",
    ]) {
      expect(line).not.toContain(value);
    }
  });
});

describe("the alert region", () => {
  it("renders nothing at all when no night is unresolved", async () => {
    const { container } = await renderAlerts([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the night and says every scheduled attempt failed", async () => {
    await renderAlerts([ALERT]);

    expect(screen.getByTestId("missing-report-alerts")).toBeInTheDocument();
    expect(screen.getByTestId("missing-report-alert-2026-08-27")).toHaveTextContent(/27 August/);
    expect(screen.getByText(en.reports.failureAlert.everyAttemptFailed)).toBeVisible();
  });

  it("announces assertively, because a night with no report is a failure and not a status", async () => {
    await renderAlerts([ALERT]);
    expect(screen.getByTestId("missing-report-alerts")).toHaveAttribute("role", "alert");
  });

  it("states its priority in words, not only in colour", async () => {
    await renderAlerts([ALERT]);
    expect(screen.getByText(en.reports.failureAlert.priority)).toBeVisible();
  });

  it("offers nothing to press: no retry, no generate, no dismissal", async () => {
    await renderAlerts([ALERT]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("lists one entry per unresolved night", async () => {
    await renderAlerts([ALERT, { ...ALERT, id: "8c1d40be-72f3-4a95-b0e6-9d5417a2cf88", businessDate: "2026-08-26" }]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("speaks Swahili when the reader does", async () => {
    await renderAlerts([ALERT], "sw");
    expect(screen.getByText(sw.reports.failureAlert.heading)).toBeVisible();
    expect(screen.getByText(sw.reports.failureAlert.everyAttemptFailed)).toBeVisible();
  });
});

describe("the two dictionaries", () => {
  it("carry the same alert keys, so neither language falls back to the other", () => {
    expect(Object.keys(sw.reports.failureAlert).sort()).toEqual(
      Object.keys(en.reports.failureAlert).sort(),
    );
  });

  it("keep the date placeholder in both, so the night is named in both", () => {
    expect(en.reports.failureAlert.missingDate).toContain("{date}");
    expect(sw.reports.failureAlert.missingDate).toContain("{date}");
  });
});
