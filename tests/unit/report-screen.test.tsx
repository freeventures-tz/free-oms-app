import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import { DATA_UNAVAILABLE } from "@/lib/supabase/query";
import { REPORT_SCHEMA_VERSION, REPORT_SECTION_COUNT } from "@/lib/reports/report-content";

/**
 * The reports screen, and the two answers it must never confuse.
 *
 * design.md §12.7 rule 7: a failed read is never shown as an empty one. On this screen that matters
 * more than on most — "no reports have been written" and "we could not reach the system" would both
 * render as a quiet page, and only one of them means the business had a quiet night.
 *
 * The read is proved here rather than in a browser because the failure lives between the server and
 * Postgres, where a browser test cannot reach: PostgREST answers `{ data, error }` and never throws,
 * so the mistake this guards against — a `?? []` in the loader — is invisible from outside.
 */
const createServerSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => createServerSupabase(),
}));

const { loadReport, loadReportSummaries } = await import("@/lib/reports/reports");
const { ReportList } = await import("@/app/(app)/reports/report-list");
const { ReportView } = await import("@/app/(app)/reports/[id]/report-view");

/** `count` is the exact count PostgREST sends when asked; the paged delivery reads require it. */
type Answer = { data: unknown[] | null; error: { message: string } | null; count?: number | null };

/**
 * A PostgREST query builder that ends in whatever answers the test wants, in order.
 *
 * Both loaders make TWO reads — the report, then its deliveries — so a stub that returns one answer
 * forever would let a broken second read pass unnoticed.
 */
function answering(...answers: Answer[]) {
  let call = 0;
  const builder: Record<string, unknown> = {};
  for (const step of ["select", "order", "limit", "eq", "in", "or"]) {
    builder[step] = () => builder;
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(answers[Math.min(call++, answers.length - 1)]).then(resolve);
  return { from: () => builder };
}

afterEach(() => {
  vi.clearAllMocks();
});

function inEnglish(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("reading the archive", () => {
  it("throws when the read fails, rather than answering that there are no reports", async () => {
    createServerSupabase.mockReturnValue(
      answering({ data: null, error: { message: "connection refused" } }),
    );

    await expect(loadReportSummaries()).rejects.toThrow(DATA_UNAVAILABLE);
  });

  it("throws on a failed detail read too", async () => {
    createServerSupabase.mockReturnValue(
      answering({ data: null, error: { message: "connection refused" } }),
    );

    await expect(loadReport("11111111-2222-3333-4444-555555555555")).rejects.toThrow(
      DATA_UNAVAILABLE,
    );
  });

  it("answers 'no such report' for a link that is not an identifier at all", async () => {
    // A wrong address is a 404. Sending it to PostgREST would come back as a malformed-input error
    // and the reader would be told the system was down.
    await expect(loadReport("not-an-id")).resolves.toBeNull();
    expect(createServerSupabase).not.toHaveBeenCalled();
  });

  it("answers 'no such report' when the identifier is well formed and unknown", async () => {
    createServerSupabase.mockReturnValue(answering({ data: [], error: null }));
    await expect(loadReport("11111111-2222-3333-4444-555555555555")).resolves.toBeNull();
  });

  it("reads the integrity finding straight through from the database", async () => {
    createServerSupabase.mockReturnValue(
      answering(
        {
          data: [
            {
              run_id: "11111111-2222-3333-4444-555555555555",
              business_date: "2026-08-24",
              generated_at: "2026-08-24T21:01:00Z",
              integrity_ok: false,
              snapshot_id: "22222222-3333-4444-5555-666666666666",
            },
          ],
          error: null,
        },
        {
          data: [
            {
              snapshot_id: "22222222-3333-4444-5555-666666666666",
              recipient_id: "aaaaaaaa-0000-0000-0000-000000000001",
            },
            {
              snapshot_id: "22222222-3333-4444-5555-666666666666",
              recipient_id: "aaaaaaaa-0000-0000-0000-000000000002",
            },
          ],
          error: null,
          count: 2,
        },
      ),
    );

    const [summary] = await loadReportSummaries();
    expect(summary.integrity).toBe("failed");
    expect(summary.recipientCount).toBe(2);
  });

  it("carries the account each delivery was written for, not only the name", async () => {
    createServerSupabase.mockReturnValue(
      answering(
        {
          data: [
            {
              run_id: "11111111-2222-3333-4444-555555555555",
              business_date: "2026-08-24",
              generated_at: "2026-08-24T21:01:00Z",
              integrity_ok: true,
              snapshot_id: "22222222-3333-4444-5555-666666666666",
              content_sha256: "a".repeat(64),
              content: SNAPSHOT,
            },
          ],
          error: null,
        },
        {
          data: [
            {
              snapshot_id: "22222222-3333-4444-5555-666666666666",
              recipient_id: "aaaaaaaa-0000-0000-0000-000000000001",
              recipient_role: "director",
              profiles: { full_name: "Asha Mushi" },
            },
          ],
          error: null,
          count: 1,
        },
      ),
    );

    const report = await loadReport("11111111-2222-3333-4444-555555555555");
    expect(report?.recipients).toEqual([
      { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Asha Mushi", role: "director" },
    ]);
  });

  it("throws when the report comes back but its deliveries do not", async () => {
    // The second read failing is still a failed read. Answering "delivered to 0" would be a
    // fabricated fact about who saw the report.
    createServerSupabase.mockReturnValue(
      answering(
        {
          data: [
            {
              run_id: "11111111-2222-3333-4444-555555555555",
              business_date: "2026-08-24",
              generated_at: "2026-08-24T21:01:00Z",
              integrity_ok: true,
              snapshot_id: "22222222-3333-4444-5555-666666666666",
            },
          ],
          error: null,
        },
        { data: null, error: { message: "connection refused" } },
      ),
    );

    await expect(loadReportSummaries()).rejects.toThrow(DATA_UNAVAILABLE);
  });
});

describe("an archive with nothing in it yet", () => {
  it("says so, and says when the first one will arrive", () => {
    inEnglish(<ReportList reports={[]} />);
    expect(screen.getByText(/no report has been written yet/i)).toBeVisible();
    expect(screen.getByText(/one minute past midnight/i)).toBeVisible();
  });
});

const SNAPSHOT = {
  schema_version: REPORT_SCHEMA_VERSION,
  business_date: "2026-08-24",
  time_zone: "Africa/Dar_es_Salaam",
  sections: {
    cashier_reconciliation: {
      state: "not_counted",
      counted_tzs: null,
      expected_tzs: null,
      variance_tzs: null,
      missing_reason: "no_cash_reconciliation_record",
    },
  },
};

function detail(overrides: Partial<Parameters<typeof ReportView>[0]["report"]> = {}) {
  return {
    runId: "11111111-2222-3333-4444-555555555555",
    businessDate: "2026-08-24",
    generatedAt: "2026-08-24T21:01:00Z",
    integrity: "verified" as const,
    contentSha256: "a".repeat(64),
    content: SNAPSHOT,
    recipients: [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Asha Mushi", role: "director" as const },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", name: "Juma Kileo", role: "manager" as const },
    ],
    ...overrides,
  };
}

describe("one report on the screen", () => {
  it("shows a count nobody took as words, and shows no money at all", () => {
    inEnglish(<ReportView report={detail()} />);

    const till = screen.getByRole("region", { name: /cashier's cash count/i });
    expect(till).toHaveTextContent(/not counted/i);
    expect(till).toHaveTextContent(/nobody counted the till on this day/i);

    // Three figures, three absences, no zero anywhere.
    expect(till.textContent?.match(/Not recorded/g)).toHaveLength(3);
    expect(till).not.toHaveTextContent(/TZS/);
  });

  it("warns plainly when the stored report no longer matches its fingerprint", () => {
    inEnglish(<ReportView report={detail({ integrity: "failed" })} />);

    const check = screen.getByRole("region", { name: /integrity check/i });
    expect(check).toHaveTextContent(/does not match/i);
    expect(check).toHaveTextContent(/do not act on these figures/i);
  });

  it("says nothing was checked rather than claiming a report is intact", () => {
    inEnglish(<ReportView report={detail({ integrity: "unknown" })} />);

    const check = screen.getByRole("region", { name: /integrity check/i });
    expect(check).toHaveTextContent(/not checked/i);
    expect(check).toHaveTextContent(/nothing here has been confirmed/i);
  });

  it("says so when the snapshot was written in a format it does not understand", () => {
    inEnglish(<ReportView report={detail({ content: { ...SNAPSHOT, schema_version: 99 } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/newer format/i);
  });

  it("keeps quiet about the format when it does understand it", () => {
    inEnglish(<ReportView report={detail()} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names who the report was delivered to, by role", () => {
    inEnglish(<ReportView report={detail()} />);

    const delivery = screen.getByRole("region", { name: /^delivery$/i });
    expect(delivery).toHaveTextContent(/Asha Mushi — Director/);
    expect(delivery).toHaveTextContent(/Juma Kileo — Manager/);
    expect(delivery).toHaveTextContent(/in the app only/i);
  });

  it("keeps two recipients apart when they share a name", () => {
    // `report_deliveries` is unique on `(snapshot_id, recipient_id)`, so two accounts called the
    // same thing are two rows in the database and must be two rows on the screen. A key composed
    // from the role and the name collides here, and React reuses one row's DOM for the other.
    inEnglish(
      <ReportView
        report={detail({
          recipients: [
            {
              id: "aaaaaaaa-0000-0000-0000-000000000001",
              name: "Asha Mushi",
              role: "director" as const,
            },
            {
              id: "aaaaaaaa-0000-0000-0000-000000000003",
              name: "Asha Mushi",
              role: "director" as const,
            },
          ],
        })}
      />,
    );

    const delivery = screen.getByRole("region", { name: /^delivery$/i });
    expect(delivery.querySelectorAll("li")).toHaveLength(2);
  });

  it("says plainly when a report reached nobody", () => {
    inEnglish(<ReportView report={detail({ recipients: [] })} />);
    expect(screen.getByRole("region", { name: /^delivery$/i })).toHaveTextContent(
      /nobody received this report/i,
    );
  });

  it("marks an unconfirmed count as prominently as one nobody took", () => {
    // §18.2a: both are unresolved. A quiet chip on "awaiting confirmation" would put the whole
    // distinction in the wording.
    inEnglish(
      <ReportView
        report={detail({
          content: {
            ...SNAPSHOT,
            sections: {
              ...SNAPSHOT.sections,
              imprest: {
                fund_no: "FV-IMP-0001",
                state: "active",
                reconciliation: {
                  state: "awaiting_manager_confirmation",
                  counted_tzs: 375_000,
                  expected_tzs: 380_000,
                  variance_tzs: -5_000,
                  variance_reason: null,
                  missing_reason: null,
                },
              },
            },
          },
        })}
      />,
    );

    const till = screen.getByTestId("report-state-cashierReconciliation").firstElementChild;
    const imprest = screen.getByTestId("report-state-imprestReconciliation").firstElementChild;
    expect(imprest?.className).toBe(till?.className);
  });

  it("heads the page with the business day, not with today", () => {
    inEnglish(<ReportView report={detail()} />);
    expect(
      screen.getByRole("heading", { name: /report for monday, 24 august 2026/i }),
    ).toBeVisible();
  });
});

describe("a report on a phone", () => {
  it("puts the overview above the sections, and names what is unresolved", () => {
    inEnglish(<ReportView report={detail()} />);

    const overview = screen.getByRole("region", { name: /at a glance/i });
    const sales = screen.getByRole("region", { name: /^sales$/i });

    // Not "2 counts unresolved": the reader would then have to hunt seventeen headings for which
    // two. The overview names them.
    expect(screen.getByTestId("report-unresolved")).toHaveTextContent(
      /still unresolved.*cashier's cash count/i,
    );

    // DOM order is reading order on a phone, where everything is one column.
    expect(overview.compareDocumentPosition(sales) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts every section collapsed on a phone and open from tablet width", () => {
    inEnglish(<ReportView report={detail()} />);

    // One class pair carries the whole responsive rule, which is what lets the server render the
    // same markup for a phone and a desktop: hidden by default, shown from `md`.
    const body = document.getElementById("report-section-sales");
    expect(body?.className).toContain("hidden");
    expect(body?.className).toContain("md:flex");
  });

  it("opens a section when its heading is pressed, and says so to a screen reader", async () => {
    const user = userEvent.setup();
    inEnglish(<ReportView report={detail()} />);

    const toggle = screen.getByTestId("report-toggle-sales");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Pressed, so the choice now holds at every width rather than deferring to the breakpoint.
    expect(document.getElementById("report-section-sales")?.className).not.toContain("hidden");
  });

  it("does not animate the chevron for a reader who asked for less motion", () => {
    inEnglish(<ReportView report={detail()} />);

    // design.md §12.7 rule 6. The chevron still turns — the state has to be visible — it just
    // arrives there at once. `globals.css` names specific classes in its reduced-motion block, so
    // a transition introduced here has to opt out here.
    const chevron = screen.getByTestId("report-toggle-sales").querySelector("svg");
    expect(chevron?.getAttribute("class")).toContain("transition-transform");
    expect(chevron?.getAttribute("class")).toContain("motion-reduce:transition-none");
  });

  it("shows a collapsed section's status without opening it", () => {
    inEnglish(<ReportView report={detail()} />);

    // The chip is inside the heading control, so "Not counted" is readable on a phone before the
    // reader taps anything (product.md §18.2a).
    const toggle = screen.getByTestId("report-toggle-cashierReconciliation");
    expect(toggle).toHaveTextContent(/not counted/i);
  });

  it("renders one section for every section the skeleton stands in for", () => {
    inEnglish(<ReportView report={detail()} />);

    expect(screen.getAllByTestId(/^report-toggle-/)).toHaveLength(REPORT_SECTION_COUNT);
  });
});

/** A report whose imprest tin was counted, with a variance of the caller's choosing. */
function withVariance(variance: number) {
  return detail({
    content: {
      ...SNAPSHOT,
      sections: {
        ...SNAPSHOT.sections,
        imprest: {
          fund_no: "FV-IMP-0001",
          state: "active",
          reconciliation: {
            state: "awaiting_manager_confirmation",
            counted_tzs: 380_000 + variance,
            expected_tzs: 380_000,
            variance_tzs: variance,
            variance_reason: null,
            missing_reason: null,
          },
        },
      },
    },
  });
}

describe("a variance", () => {
  it("carries its sign and a labelled icon, never colour alone", () => {
    inEnglish(<ReportView report={withVariance(-5_000)} />);

    // design.md §11.5. Three channels: the arrow, the sign, and the word the icon is labelled with
    // — so the finding survives sunlight, colour blindness and a screen reader.
    const variance = screen.getByTestId("report-variance");
    expect(variance).toHaveTextContent("\u2212TZS 5,000");
    expect(variance.querySelector("svg")).toHaveAttribute("role", "img");
    expect(screen.getByRole("img", { name: /shortfall/i })).toBeInTheDocument();
  });

  it("marks a surplus as its own direction, not merely as a different number", () => {
    inEnglish(<ReportView report={withVariance(5_000)} />);

    const variance = screen.getByTestId("report-variance");
    expect(variance).toHaveTextContent("+TZS 5,000");
    expect(screen.getByRole("img", { name: /surplus/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /shortfall/i })).toBeNull();
  });

  it("does not sign a count that balanced", () => {
    inEnglish(<ReportView report={withVariance(0)} />);

    // "+TZS 0" would claim a direction that does not exist.
    const variance = screen.getByTestId("report-variance");
    expect(variance).toHaveTextContent("TZS 0");
    expect(variance.textContent).not.toMatch(/[+\u2212]/);
    expect(screen.getByRole("img", { name: /balanced/i })).toBeInTheDocument();
  });

  it("is set one size and one weight above the figures around it", () => {
    inEnglish(<ReportView report={withVariance(-5_000)} />);

    // §9.7: a key figure is one step larger and heavier than surrounding text. The amounts it was
    // derived from are `text-sm font-medium`, so this is `text-base font-semibold` — and tabular,
    // like every other figure on the page.
    const variance = screen.getByTestId("report-variance");
    expect(variance.className).toContain("text-base");
    expect(variance.className).toContain("font-semibold");
    expect(variance.className).toContain("fv-numeric");

    const counted = screen
      .getByRole("region", { name: /imprest cash count/i })
      .querySelector("dd");
    expect(counted?.className).toContain("text-sm");
    expect(counted?.className).not.toContain("text-base");
  });
});

describe("touch targets on a phone", () => {
  it("gives every section toggle a 44px minimum height", () => {
    inEnglish(<ReportView report={detail()} />);

    // design.md §11.3. `min-h-11` is 44px on Tailwind's 4px scale; the floor lifts from `md`, where
    // the sections start open and the row is a heading rather than a control anyone taps.
    const toggles = screen.getAllByTestId(/^report-toggle-/);
    expect(toggles).toHaveLength(REPORT_SECTION_COUNT);
    for (const toggle of toggles) {
      expect(toggle.className).toContain("min-h-11");
      expect(toggle.className).toContain("md:min-h-0");
    }
  });

  it("gives the way back a 44px minimum height, and a box that can have one", () => {
    inEnglish(<ReportView report={detail()} />);

    // An inline element ignores a height, so the floor only means something once the link is a
    // flex box. Asserting both together is the point: either alone is a target that is still 20px.
    const back = screen.getByTestId("report-back");
    expect(back.className).toContain("min-h-11");
    expect(back.className).toContain("inline-flex");
    expect(back.className).toContain("items-center");
  });
});

describe("figures and chips", () => {
  it("sets money, quantities and counts in tabular numerals", () => {
    inEnglish(
      <ReportView
        report={detail({
          content: {
            ...SNAPSHOT,
            sections: {
              ...SNAPSHOT.sections,
              invoices: { total_tzs: 1_450_000 },
              payments_by_method: { total_tzs: 900_000, methods: [] },
              outstanding_credit: { outstanding_tzs: 550_000 },
              pending_approvals: { count: 3, by_type: [] },
            },
          },
        })}
      />,
    );

    // design.md §11.3. Every figure on the report is compared against another one, and proportional
    // digits make two totals of the same size look different. Four headline figures, four of them
    // set in tabular numerals — and the absences among them stay words, so they are not counted.
    const overview = screen.getByRole("region", { name: /at a glance/i });
    expect(overview.querySelectorAll(".fv-numeric")).toHaveLength(4);
  });

  it("gives the integrity chip a shape as well as a word and a colour", () => {
    const { container } = inEnglish(<ReportView report={detail({ integrity: "failed" })} />);

    // §11.5 asks for a second channel; this is the third. A column of chips on a phone is scanned
    // as a column of colours, and this chip's meaning is a warning.
    const chip = container.querySelector('[class*="rounded-full"]');
    expect(chip?.querySelector("svg")).not.toBeNull();
  });

  it("gives a count nobody took a different shape from one awaiting confirmation", () => {
    inEnglish(
      <ReportView
        report={detail({
          content: {
            ...SNAPSHOT,
            sections: {
              ...SNAPSHOT.sections,
              imprest: {
                fund_no: "FV-IMP-0001",
                state: "active",
                reconciliation: {
                  state: "awaiting_manager_confirmation",
                  counted_tzs: 375_000,
                  expected_tzs: 380_000,
                  variance_tzs: -5_000,
                  variance_reason: null,
                  missing_reason: null,
                },
              },
            },
          },
        })}
      />,
    );

    const notCounted = screen
      .getByTestId("report-state-cashierReconciliation")
      .querySelector("svg");
    const awaiting = screen
      .getByTestId("report-state-imprestReconciliation")
      .querySelector("svg");

    expect(notCounted).not.toBeNull();
    expect(awaiting).not.toBeNull();

    // The two chips carry the SAME tone deliberately — both counts are unresolved — so the tone
    // cannot be what separates them. §15.2a'''s distinction survives only if the shapes differ.
    const tillChip = screen.getByTestId("report-state-cashierReconciliation").firstElementChild;
    const imprestChip = screen.getByTestId("report-state-imprestReconciliation").firstElementChild;
    expect(imprestChip?.className).toBe(tillChip?.className);
    expect(notCounted?.getAttribute("class")).not.toBe(awaiting?.getAttribute("class"));
  });
});

/**
 * Issue #51 · Figures the released schema cannot give yet are shown as words, in words of their
 * own, with the reason written in the section. Hidden in the markup is not good enough: the body of
 * a section is collapsed on a phone, so the text is asserted on the DOM rather than on visibility.
 */
describe("an imprest figure the system cannot give yet", () => {
  const integrated = detail({
    content: {
      ...SNAPSHOT,
      sections: {
        ...SNAPSHOT.sections,
        imprest: {
          fund_no: null,
          fund_id: "0b6f2c1e-7a53-4d8f-9a31-5c0e2d9f4b10",
          state: "active",
          funding: {
            requested_count: 1,
            requested_tzs: 100_000,
            approved_tzs: null,
            provided_tzs: null,
            received_tzs: 65_000,
            unavailable: {
              approved_tzs: "funding_aggregation_deferred",
              provided_tzs: "funding_aggregation_deferred",
            },
          },
          approved_expenses: null,
          position: null,
          unavailable: {
            approved_expenses: "imprest_spending_not_built",
            position: "imprest_spending_not_built",
          },
          reconciliation: {
            state: "not_counted",
            counted_tzs: null,
            expected_tzs: null,
            variance_tzs: null,
            variance_reason: null,
            missing_reason: "no_reconciliation_record",
          },
        },
      },
    },
  });

  it("says 'Not available' with the reason, and shows no money for it", () => {
    inEnglish(<ReportView report={integrated} />);

    const balance = screen.getByRole("region", { name: /imprest balance/i });
    expect(balance.textContent?.match(/Not available/g)).toHaveLength(4);
    expect(balance).toHaveTextContent(/imprest spending is not in the system yet/i);
    expect(balance).not.toHaveTextContent(/TZS/);
    expect(balance).not.toHaveTextContent(/Not recorded/);
  });

  it("keeps the funding that IS known beside the funding that is withheld", () => {
    inEnglish(<ReportView report={integrated} />);

    const funding = screen.getByRole("region", { name: /^imprest funding$/i });
    expect(funding.textContent?.match(/Not available/g)).toHaveLength(2);
    expect(funding).toHaveTextContent(/only receipts the manager confirmed count as money received/i);
    expect(funding).toHaveTextContent(/65,000/);
    expect(funding).toHaveTextContent(/100,000/);
    expect(screen.getAllByTestId("report-unavailable-imprestFunding")).toHaveLength(1);
  });
});
