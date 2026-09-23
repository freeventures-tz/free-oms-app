import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { readReport, REPORT_SCHEMA_VERSION } from "@/lib/reports/report-content";
import { integrityOf } from "@/lib/reports/integrity";

/**
 * Reading a report snapshot, and the one mistake that would make the whole feature dishonest.
 *
 * product.md §15.2a: a reconciliation that was never performed is UNKNOWN, not balanced, and the
 * two must never look alike. The cheapest way to break that is a defensive `?? 0` somewhere in the
 * mapping — code that looks careful and turns "nobody counted the till" into "the till balanced".
 * Half of this file exists to fail if one is ever added.
 */
const NOTHING_COUNTED = {
  state: "not_counted",
  counted_tzs: null,
  expected_tzs: null,
  variance_tzs: null,
  missing_reason: "no_cash_reconciliation_record",
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    business_date: "2026-08-24",
    time_zone: "Africa/Dar_es_Salaam",
    sections: {
      sales: {
        orders_created: 4,
        orders_confirmed: 3,
        orders_cancelled: 1,
        cash_sales_confirmed: 2,
      },
      invoices: {
        issued_count: 3,
        cancelled_count: 0,
        subtotal_tzs: 1_300_000,
        discount_tzs: 100_000,
        total_tzs: 1_200_000,
      },
      payments_by_method: {
        count: 3,
        total_tzs: 900_000,
        reversal_count: 1,
        methods: [
          { method: "cash", count: 2, amount_tzs: 600_000 },
          { method: "crdb_transfer", count: 1, amount_tzs: 300_000 },
        ],
      },
      outstanding_credit: {
        as_at_business_date: "2026-08-24",
        invoice_count: 2,
        outstanding_tzs: 300_000,
      },
      discounts_and_approvals: {
        discounted_invoice_count: 1,
        discount_tzs: 100_000,
        approvals_requested: 2,
        by_type: [{ approval_type: "discount", requested: 2, approved: 1, rejected: 1 }],
      },
      paid_but_unreleased: { as_at: "generation", allocation_count: 2, outstanding_quantity: 40 },
      released_stock: { dispatch_count: 1, released_quantity: 100 },
      inventory_variances: {
        adjustment_count: 2,
        increase_quantity: 5,
        decrease_quantity: 10,
        net_quantity: -5,
      },
      supplier_shortages: {
        receipt_count: 1,
        short_line_count: 1,
        short_quantity: 3,
        damaged_quantity: 1,
      },
      production_batches: { entered: 2, draft: 1, approved: 1, rejected: 0, cancelled: 0 },
      production_output: {
        quantity_moulded: 1500,
        rejected_at_moulding: 20,
        inspected_lot_count: 1,
        accepted_quantity: 1400,
        rejected_at_inspection: 30,
      },
      cashier_reconciliation: NOTHING_COUNTED,
      pending_approvals: {
        as_at: "generation",
        count: 1,
        by_type: [{ approval_type: "stock_adjustment", count: 1 }],
      },
      imprest: {
        fund_no: "FV-IMP-0001",
        state: "active",
        funding: {
          requested_count: 1,
          requested_tzs: 500_000,
          approved_tzs: 500_000,
          provided_tzs: 500_000,
          received_tzs: 500_000,
        },
        approved_expenses: { count: 2, amount_tzs: 120_000 },
        position: {
          posted_tzs: 380_000,
          encumbered_tzs: 120_000,
          available_tzs: 260_000,
          awaiting_verification_tzs: 0,
        },
        reconciliation: {
          state: "awaiting_manager_confirmation",
          counted_tzs: 375_000,
          expected_tzs: 380_000,
          variance_tzs: -5_000,
          variance_reason: "Small note missing",
          missing_reason: null,
        },
      },
      ...overrides,
    },
  };
}

function section(content: unknown, key: string) {
  const found = readReport(content).sections.find((entry) => entry.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
}

function figureFor(content: unknown, sectionKey: string, rowKey: string) {
  const row = section(content, sectionKey).rows.find((entry) => entry.key === rowKey);
  if (!row) throw new Error(`no row ${rowKey} in ${sectionKey}`);
  return row.figure;
}

describe("reading a report snapshot", () => {
  it("carries the day and the clock it was built against", () => {
    const report = readReport(snapshot());
    expect(report.businessDate).toBe("2026-08-24");
    expect(report.timeZone).toBe("Africa/Dar_es_Salaam");
    expect(report.understood).toBe(true);
  });

  it("produces every approved section, in a fixed order", () => {
    expect(readReport(snapshot()).sections.map((entry) => entry.key)).toEqual([
      "sales",
      "invoices",
      "payments",
      "outstandingCredit",
      "discountsAndApprovals",
      "paidButUnreleased",
      "releasedStock",
      "inventoryVariances",
      "supplierShortages",
      "productionBatches",
      "productionOutput",
      "cashierReconciliation",
      "pendingApprovals",
      "imprestFunding",
      "imprestExpenses",
      "imprestPosition",
      "imprestReconciliation",
    ]);
  });

  it("keeps money and counts apart, so the screen formats each one as what it is", () => {
    expect(figureFor(snapshot(), "invoices", "totalTzs")).toEqual({
      kind: "money",
      value: 1_200_000,
    });
    expect(figureFor(snapshot(), "sales", "ordersConfirmed")).toEqual({ kind: "count", value: 3 });
    expect(figureFor(snapshot(), "productionOutput", "quantityMoulded")).toEqual({
      kind: "quantity",
      value: 1500,
    });
  });

  it("keeps a negative figure negative", () => {
    // A variance that is reported as its absolute value is a variance nobody can act on.
    expect(figureFor(snapshot(), "inventoryVariances", "netQuantity")).toEqual({
      kind: "quantity",
      value: -5,
    });
    expect(figureFor(snapshot(), "imprestReconciliation", "varianceTzs")).toEqual({
      kind: "variance",
      value: -5_000,
    });
  });

  it("models a variance apart from the amounts it was derived from", () => {
    // design.md §9.7 makes a variance a key figure — signed, iconed, and set larger than the money
    // around it. The screen can only do that if it is TOLD which figure is the difference; asking
    // it to guess from a row key would put the rule in two places and lose it in one of them.
    expect(figureFor(snapshot(), "imprestReconciliation", "countedTzs")).toEqual({
      kind: "money",
      value: 375_000,
    });
    expect(figureFor(snapshot(), "imprestReconciliation", "expectedTzs")).toEqual({
      kind: "money",
      value: 380_000,
    });
    expect(figureFor(snapshot(), "imprestReconciliation", "varianceTzs").kind).toBe("variance");
  });

  it("keeps a variance of nothing as a variance, not as an absence", () => {
    // A count that balanced is a finding: somebody counted, and it agreed. Rendering it as the
    // words "Not recorded" would say the opposite of what happened.
    const balanced = snapshot({
      imprest: {
        fund_no: "FV-IMP-0001",
        state: "active",
        reconciliation: {
          state: "confirmed",
          counted_tzs: 380_000,
          expected_tzs: 380_000,
          variance_tzs: 0,
          variance_reason: null,
          missing_reason: null,
        },
      },
    });

    expect(figureFor(balanced, "imprestReconciliation", "varianceTzs")).toEqual({
      kind: "variance",
      value: 0,
    });
  });

  it("names each payment method with the label the rest of the app already uses", () => {
    expect(section(snapshot(), "payments").breakdown).toEqual([
      {
        labelKey: "settlement.methods.cash",
        rows: [
          { key: "paymentCount", figure: { kind: "count", value: 2 } },
          { key: "paymentTotalTzs", figure: { kind: "money", value: 600_000 } },
        ],
      },
      {
        labelKey: "settlement.methods.crdb_transfer",
        rows: [
          { key: "paymentCount", figure: { kind: "count", value: 1 } },
          { key: "paymentTotalTzs", figure: { kind: "money", value: 300_000 } },
        ],
      },
    ]);
  });

  it("splits approvals by what was asked for and what was decided", () => {
    expect(section(snapshot(), "discountsAndApprovals").breakdown).toEqual([
      {
        labelKey: "reports.approvalType.discount",
        rows: [
          { key: "approvalsRequested", figure: { kind: "count", value: 2 } },
          { key: "approvalsApproved", figure: { kind: "count", value: 1 } },
          { key: "approvalsRejected", figure: { kind: "count", value: 1 } },
        ],
      },
    ]);
  });

  it("says when a section is a position rather than a total for the day", () => {
    expect(section(snapshot(), "paidButUnreleased").noteKey).toBe("asAtGeneration");
    expect(section(snapshot(), "pendingApprovals").noteKey).toBe("asAtGeneration");
    expect(section(snapshot(), "outstandingCredit").noteKey).toBe("asAtBusinessDate");
    expect(section(snapshot(), "sales").noteKey).toBeUndefined();
  });
});

describe("a figure the snapshot does not carry", () => {
  it("is unknown, never zero", () => {
    expect(figureFor(snapshot(), "cashierReconciliation", "countedTzs")).toEqual({
      kind: "unknown",
    });
    expect(figureFor(snapshot(), "cashierReconciliation", "varianceTzs")).toEqual({
      kind: "unknown",
    });
  });

  it("is unknown when the whole section is missing too", () => {
    const withoutSales = snapshot();
    delete (withoutSales.sections as Record<string, unknown>).sales;
    expect(figureFor(withoutSales, "sales", "ordersCreated")).toEqual({ kind: "unknown" });
  });

  it("is unknown for an imprest fund that was never opened", () => {
    const noFund = snapshot({
      imprest: {
        fund_no: null,
        state: "no_fund",
        funding: null,
        approved_expenses: null,
        position: null,
        reconciliation: {
          state: "not_counted",
          counted_tzs: null,
          expected_tzs: null,
          variance_tzs: null,
          variance_reason: null,
          missing_reason: "no_imprest_fund",
        },
      },
    });

    expect(figureFor(noFund, "imprestPosition", "postedTzs")).toEqual({ kind: "unknown" });
    expect(figureFor(noFund, "imprestExpenses", "approvedExpenseTzs")).toEqual({ kind: "unknown" });
    // The fund section carries the STATE and no reason: "No fund open" needs no explaining. The
    // reason belongs to the count that could not happen, and that is where it is.
    expect(section(noFund, "imprestFunding").state).toEqual({
      state: "no_fund",
      missingReasonKey: null,
    });
    expect(section(noFund, "imprestReconciliation").state).toEqual({
      state: "not_counted",
      missingReasonKey: "no_imprest_fund",
    });
  });

  it("refuses a value that is not a real number", () => {
    const nonsense = snapshot({ released_stock: { dispatch_count: "1", released_quantity: null } });
    expect(figureFor(nonsense, "releasedStock", "dispatchCount")).toEqual({ kind: "unknown" });
    expect(figureFor(nonsense, "releasedStock", "releasedQuantity")).toEqual({ kind: "unknown" });
  });
});

describe("the three reconciliation states", () => {
  it("keeps a count nobody took apart from one the Manager has not confirmed", () => {
    expect(section(snapshot(), "cashierReconciliation").state).toEqual({
      state: "not_counted",
      missingReasonKey: "no_cash_reconciliation_record",
    });
    expect(section(snapshot(), "imprestReconciliation").state).toEqual({
      state: "awaiting_manager_confirmation",
      missingReasonKey: null,
    });
  });

  it("carries the counted figures of a count that is merely unconfirmed", () => {
    // Unconfirmed is not unknown. The cash WAS counted, and hiding the figure would lose that.
    expect(figureFor(snapshot(), "imprestReconciliation", "countedTzs")).toEqual({
      kind: "money",
      value: 375_000,
    });
    expect(figureFor(snapshot(), "imprestReconciliation", "varianceReason")).toEqual({
      kind: "text",
      value: "Small note missing",
    });
  });

  it("treats an unrecognised state as not counted rather than as settled", () => {
    const odd = snapshot({ cashier_reconciliation: { state: "something_new" } });
    expect(section(odd, "cashierReconciliation").state?.state).toBe("not_counted");
  });
});

describe("a snapshot this screen was not built for", () => {
  it("is reported rather than rendered as if it were understood", () => {
    expect(readReport(snapshot({})).understood).toBe(true);
    expect(readReport({ ...snapshot(), schema_version: 99 }).understood).toBe(false);
    expect(readReport(null).understood).toBe(false);
    expect(readReport("not a report").understood).toBe(false);
  });

  it("still produces every section, so nothing disappears silently", () => {
    expect(readReport(null).sections).toHaveLength(17);
    expect(readReport(null).sections.every((entry) => entry.rows.length > 0)).toBe(true);
  });
});

describe("the integrity statement", () => {
  it("says verified only when the database verified it", () => {
    expect(integrityOf(true)).toBe("verified");
    expect(integrityOf(false)).toBe("failed");
  });

  it("says nothing was checked when nothing came back", () => {
    // Claiming a report is intact when no check ran is the one answer that would be a lie.
    expect(integrityOf(null)).toBe("unknown");
    expect(integrityOf(undefined)).toBe("unknown");
    expect(integrityOf("true")).toBe("unknown");
  });
});

describe("the words on the screen", () => {
  const dictionaries: Record<string, unknown> = { en, sw };

  function lookup(dictionary: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((node, part) => {
      if (typeof node !== "object" || node === null) return undefined;
      return (node as Record<string, unknown>)[part];
    }, dictionary);
  }

  const report = readReport(snapshot());

  /**
   * The mapper emits KEYS, so a key with no sentence behind it is an English fallback — or a raw
   * `reports.rows.somethingNew` — in front of a Swahili-speaking Director. Both dictionaries are
   * checked, because the parity test proves the two agree and this one proves they are right.
   */
  it.each(["en", "sw"])("names every section, row and state in %s", (locale) => {
    const dictionary = dictionaries[locale];

    for (const entry of report.sections) {
      expect(lookup(dictionary, `reports.sections.${entry.key}`), entry.key).toBeTypeOf("string");

      if (entry.noteKey) {
        expect(lookup(dictionary, `reports.notes.${entry.noteKey}`), entry.noteKey).toBeTypeOf(
          "string",
        );
      }

      if (entry.state) {
        expect(
          lookup(dictionary, `reports.states.${entry.state.state}`),
          entry.state.state,
        ).toBeTypeOf("string");

        if (entry.state.missingReasonKey) {
          expect(
            lookup(dictionary, `reports.missingReasons.${entry.state.missingReasonKey}`),
            entry.state.missingReasonKey,
          ).toBeTypeOf("string");
        }
      }

      for (const row of entry.rows) {
        expect(lookup(dictionary, `reports.rows.${row.key}`), row.key).toBeTypeOf("string");
      }

      for (const line of entry.breakdown ?? []) {
        expect(lookup(dictionary, line.labelKey), line.labelKey).toBeTypeOf("string");
        for (const row of line.rows) {
          expect(lookup(dictionary, `reports.rows.${row.key}`), row.key).toBeTypeOf("string");
        }
      }
    }
  });

  it.each(["en", "sw"])("names every approval type and reconciliation state in %s", (locale) => {
    const dictionary = dictionaries[locale];

    for (const type of [
      "discount",
      "credit_or_unpaid_balance",
      "payment_reversal",
      "stock_adjustment",
      "accountability",
      "imprest_funding",
      "imprest_expense",
      "imprest_expense_amendment",
      "imprest_reversal",
      "imprest_retirement",
    ]) {
      expect(lookup(dictionary, `reports.approvalType.${type}`), type).toBeTypeOf("string");
    }

    for (const state of ["not_counted", "awaiting_manager_confirmation", "confirmed", "no_fund"]) {
      expect(lookup(dictionary, `reports.states.${state}`), state).toBeTypeOf("string");
    }

    for (const direction of ["surplus", "shortfall", "balanced"]) {
      expect(lookup(dictionary, `reports.variance.${direction}`), direction).toBeTypeOf("string");
    }

    for (const integrity of ["verified", "failed", "unknown"]) {
      expect(lookup(dictionary, `reports.integrity.${integrity}`), integrity).toBeTypeOf("string");
      expect(
        lookup(dictionary, `reports.integrity.${integrity}Detail`),
        `${integrity}Detail`,
      ).toBeTypeOf("string");
    }
  });
});

/**
 * Issue #51 · The imprest section as the released schema writes it.
 *
 * The Owner approved "receipts plus explicit unavailable states": requests and confirmed receipts
 * are figures; approval and provision are withheld because their aggregation is not decided;
 * expenses and the position are withheld because imprest spending is not built. This is the exact
 * shape `private.report_content` writes, and each withheld figure must reach the screen as a
 * stated unavailability — never a number, never a zero, and never the same words as "not recorded".
 */
describe("the integrated imprest section", () => {
  const INTEGRATED = {
    fund_no: null,
    fund_id: "0b6f2c1e-7a53-4d8f-9a31-5c0e2d9f4b10",
    state: "active",
    funding: {
      requested_count: 3,
      requested_tzs: 180_000,
      approved_tzs: null,
      provided_tzs: null,
      received_tzs: 95_000,
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
  };
  const integrated = () => snapshot({ imprest: INTEGRATED });

  it("reports requests and confirmed receipts as the figures they are", () => {
    expect(figureFor(integrated(), "imprestFunding", "fundingRequestedCount")).toEqual({
      kind: "count",
      value: 3,
    });
    expect(figureFor(integrated(), "imprestFunding", "fundingRequestedTzs")).toEqual({
      kind: "money",
      value: 180_000,
    });
    expect(figureFor(integrated(), "imprestFunding", "fundingReceivedTzs")).toEqual({
      kind: "money",
      value: 95_000,
    });
  });

  it("withholds approved and provided with their reason, rather than a zero or 'not recorded'", () => {
    for (const row of ["fundingApprovedTzs", "fundingProvidedTzs"]) {
      expect(figureFor(integrated(), "imprestFunding", row), row).toEqual({
        kind: "unavailable",
        reasonKey: "funding_aggregation_deferred",
      });
    }
    expect(section(integrated(), "imprestFunding").unavailableReasonKeys).toEqual([
      "funding_aggregation_deferred",
    ]);
  });

  it("withholds every expense and position figure because spending is not built", () => {
    for (const [key, rows] of [
      ["imprestExpenses", ["approvedExpenseCount", "approvedExpenseTzs"]],
      ["imprestPosition", ["postedTzs", "encumberedTzs", "availableTzs", "awaitingVerificationTzs"]],
    ] as const) {
      for (const row of rows) {
        expect(figureFor(integrated(), key, row), row).toEqual({
          kind: "unavailable",
          reasonKey: "imprest_spending_not_built",
        });
      }
      expect(section(integrated(), key).unavailableReasonKeys).toEqual([
        "imprest_spending_not_built",
      ]);
    }
  });

  it("keeps the count NOT COUNTED and unresolved, with no figure", () => {
    expect(section(integrated(), "imprestReconciliation").state).toEqual({
      state: "not_counted",
      missingReasonKey: "no_reconciliation_record",
    });
    expect(figureFor(integrated(), "imprestReconciliation", "varianceTzs")).toEqual({
      kind: "unknown",
    });
    expect(readReport(integrated()).overview.unresolvedSectionKeys).toContain(
      "imprestReconciliation",
    );
  });

  it("shows no fund number, because the released schema has none to show", () => {
    expect(
      section(integrated(), "imprestFunding").rows.some((row) => row.key === "fundNo"),
    ).toBe(false);
  });

  it("keeps the no-fund state distinct, with spending still withheld rather than unknown", () => {
    const noFund = snapshot({
      imprest: {
        ...INTEGRATED,
        fund_id: null,
        state: "no_fund",
        funding: null,
        reconciliation: { ...INTEGRATED.reconciliation, missing_reason: "no_imprest_fund" },
      },
    });
    expect(section(noFund, "imprestFunding").state?.state).toBe("no_fund");
    expect(figureFor(noFund, "imprestFunding", "fundingReceivedTzs")).toEqual({ kind: "unknown" });
    expect(figureFor(noFund, "imprestPosition", "postedTzs")).toEqual({
      kind: "unavailable",
      reasonKey: "imprest_spending_not_built",
    });
  });

  it("never shows a figure the snapshot disclaims, even with a number beside it", () => {
    const contradictory = snapshot({
      imprest: {
        ...INTEGRATED,
        funding: { ...INTEGRATED.funding, approved_tzs: 80_000 },
      },
    });
    expect(figureFor(contradictory, "imprestFunding", "fundingApprovedTzs")).toEqual({
      kind: "unavailable",
      reasonKey: "funding_aggregation_deferred",
    });
  });

  it("still withholds a figure whose reason this build does not know", () => {
    const later = snapshot({
      imprest: {
        ...INTEGRATED,
        funding: { ...INTEGRATED.funding, unavailable: { approved_tzs: "some_new_reason" } },
      },
    });
    expect(figureFor(later, "imprestFunding", "fundingApprovedTzs")).toEqual({
      kind: "unavailable",
      reasonKey: "unrecognised",
    });
    // A marker only names the field it names.
    expect(figureFor(later, "imprestFunding", "fundingProvidedTzs")).toEqual({ kind: "unknown" });
  });

  it("gives every other section an empty reason list", () => {
    for (const entry of readReport(integrated()).sections) {
      if (["imprestFunding", "imprestExpenses", "imprestPosition"].includes(entry.key)) continue;
      expect(entry.unavailableReasonKeys, entry.key).toEqual([]);
    }
  });

  it.each([
    ["en", en],
    ["sw", sw],
  ])("says every withheld reason in words in %s", (_locale, dictionary) => {
    const reports = (dictionary as { reports: Record<string, unknown> }).reports;
    expect(reports.notAvailable).toBeTypeOf("string");
    expect(reports.notAvailable).not.toBe(reports.notRecorded);
    const reasons = reports.unavailableReasons as Record<string, unknown>;
    for (const key of ["funding_aggregation_deferred", "imprest_spending_not_built", "unrecognised"]) {
      expect(reasons[key], key).toBeTypeOf("string");
    }
  });
});
