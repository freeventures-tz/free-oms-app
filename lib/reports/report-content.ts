/**
 * Reading a stored report snapshot, without ever inventing a figure it does not contain.
 *
 * The snapshot is written by the database at 00:01 and is immutable afterwards, so this module gets
 * a plain JSON document of unknown shape and turns it into something a screen can render. Two rules
 * decide every line of it, and both come from product.md §15.2a and §18.2a:
 *
 *   1. A MISSING FIGURE IS NOT A ZERO. `figure()` answers `{ kind: "unknown" }` for anything that
 *      is absent, null, or not a finite number. It never falls back to 0. A Director looking at a
 *      night nobody counted the till must see that nobody counted it, not a balanced day.
 *
 *   2. A STATE IS CARRIED, NOT DERIVED. `not_counted` and `awaiting_manager_confirmation` are
 *      different facts and the snapshot distinguishes them, so this module keeps them apart rather
 *      than collapsing both into "no figure".
 *
 * The module is deliberately free of any server-only import and of every translation: it produces
 * KEYS, and the screen turns those into English or Swahili. That is what lets it be tested as pure
 * logic and rendered on either side of the network.
 */

import { PAYMENT_METHODS } from "@/lib/settlement/methods";

/** The snapshot layout this reader understands. A newer one is reported, not guessed at. */
export const REPORT_SCHEMA_VERSION = 1;

export type ReportFigure =
  | { kind: "count"; value: number }
  | { kind: "quantity"; value: number }
  | { kind: "money"; value: number }
  /**
   * A DIFFERENCE, not an amount — and modelled apart from `money` because the two are read
   * differently. design.md §9.7 makes a variance a key figure: it is set one step larger and
   * heavier than the figures around it, and it carries its sign and an icon rather than leaning on
   * colour (§11.5). None of that is decided by the screen guessing which money is a variance; it is
   * decided here, once, by the reader that knows what the figure means.
   *
   * The sign is meaning, not formatting. Negative is a shortfall — less cash in the tin than the
   * records say — and positive is a surplus, which is its own kind of problem.
   */
  | { kind: "variance"; value: number }
  | { kind: "text"; value: string }
  /** Absent from the snapshot. Rendered as words, never as a number. */
  | { kind: "unknown" }
  /**
   * DELIBERATELY NOT REPORTED, which is a different fact from "not recorded". The snapshot says
   * the figure cannot honestly be given yet — its workflow is not built, or its aggregation is a
   * decision nobody has made — and names why in `reasonKey`. Rendered as words, never as a
   * number, and never as a zero (issue #51, the approved funding presentation).
   */
  | { kind: "unavailable"; reasonKey: string };

/** The kinds `figure()` can be asked for. `text` and `unknown` are answers, not requests. */
type ReportFigureKind = "count" | "quantity" | "money" | "variance";

/** `reports.rows.<key>` names it in both languages. */
export type ReportRow = { key: string; figure: ReportFigure };

/** One line of a per-category breakdown: payment methods, approval types. */
export type ReportBreakdown = { labelKey: string; rows: ReportRow[] };

export type ReportState =
  | "not_counted"
  | "awaiting_manager_confirmation"
  | "confirmed"
  | "no_fund"
  | "active";

export type ReportSection = {
  /** `reports.sections.<key>` is its heading. */
  key: string;
  /** `reports.notes.<noteKey>` — says when a position was measured, where a day's total would mislead. */
  noteKey?: string;
  state?: { state: ReportState; missingReasonKey: string | null };
  /**
   * `reports.unavailableReasons.<key>` — why some of this section's figures are not given. One
   * sentence per distinct reason, taken from the rows themselves so a reason is never shown for a
   * section whose figures are all present.
   */
  unavailableReasonKeys: string[];
  rows: ReportRow[];
  breakdown?: ReportBreakdown[];
};

/**
 * The few lines a Director reads before deciding whether to read the rest.
 *
 * SEVENTEEN SECTIONS DO NOT FIT ON A PHONE, and a screen that opens on the first of them makes the
 * reader scroll past sixteen to find out whether anything is wrong. The overview answers the two
 * questions somebody opens last night's report to ask — what came in, and what still needs
 * somebody — and it answers them from figures the snapshot already carries.
 *
 * NOTHING HERE IS CALCULATED. Every headline is one value lifted out of one section, and
 * `unresolvedSectionKeys` is a list of the sections that already say they are unresolved. An
 * overview that added figures up would be a new business rule, and this slice has none: a missing
 * figure stays missing here exactly as it does below (product.md §15.2a).
 */
export type ReportOverview = {
  headline: ReportRow[];
  /** Sections whose count is `not_counted` or `awaiting_manager_confirmation`. */
  unresolvedSectionKeys: string[];
};

export type ReportDocument = {
  businessDate: string | null;
  timeZone: string | null;
  schemaVersion: number | null;
  /** True when the snapshot was written by a layout this reader was built for. */
  understood: boolean;
  sections: ReportSection[];
  overview: ReportOverview;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A number from the snapshot, or nothing.
 *
 * `null` is a deliberate answer in this data — the imprest count that was never taken writes it —
 * and so is an absent key when a section could not be built. Both arrive here as "no number", and
 * neither is allowed to leave as one.
 */
/**
 * The reasons a snapshot may give for withholding a figure. A reason this build does not know is
 * still an unavailability — it is shown as the generic sentence, never dropped and never a number.
 */
const UNAVAILABLE_REASON_KEYS = new Set([
  "funding_aggregation_deferred",
  "imprest_spending_not_built",
]);

function unavailableReason(value: unknown): string | null {
  const reason = text(value);
  if (!reason) return null;
  return UNAVAILABLE_REASON_KEYS.has(reason) ? reason : "unrecognised";
}

/**
 * Whether the snapshot withholds `key` — named in the object's own `unavailable` map, or the whole
 * object withheld by its parent (`sectionReason`).
 *
 * A withheld figure is withheld even if a number sits beside it. The two together are a
 * contradiction, and of the two readings "not available" is the one that cannot mislead: a figure
 * the writer disclaimed is never shown as though it were vouched for.
 */
function withheld(
  source: Record<string, unknown> | null,
  key: string,
  sectionReason: string | null,
): string | null {
  return sectionReason ?? unavailableReason(record(source?.["unavailable"])?.[key]);
}

function figure(
  source: Record<string, unknown> | null,
  key: string,
  kind: ReportFigureKind,
  sectionReason: string | null = null,
): ReportFigure {
  const reason = withheld(source, key, sectionReason);
  if (reason) return { kind: "unavailable", reasonKey: reason };
  const raw = source?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { kind: "unknown" };
  return { kind, value: raw } as ReportFigure;
}

function row(
  key: string,
  source: Record<string, unknown> | null,
  field: string,
  kind: ReportFigureKind,
  sectionReason: string | null = null,
): ReportRow {
  return { key, figure: figure(source, field, kind, sectionReason) };
}

/** The distinct reasons a section's rows give for withholding a figure, in row order. */
function reasonsOf(rows: ReportRow[]): string[] {
  const reasons: string[] = [];
  for (const { figure: value } of rows) {
    if (value.kind === "unavailable" && !reasons.includes(value.reasonKey)) {
      reasons.push(value.reasonKey);
    }
  }
  return reasons;
}

function stateOf(source: Record<string, unknown> | null): {
  state: ReportState;
  missingReasonKey: string | null;
} {
  const raw = text(source?.["state"]);
  const known: ReportState[] = [
    "not_counted",
    "awaiting_manager_confirmation",
    "confirmed",
    "no_fund",
    "active",
  ];
  const state = known.find((candidate) => candidate === raw) ?? "not_counted";
  return { state, missingReasonKey: text(source?.["missing_reason"]) };
}

/**
 * `settlement.methods.cash` when the app already names it; a plain "not recognised" otherwise.
 *
 * The list comes from `lib/settlement/methods.ts` rather than a second copy of the six tenders. A
 * seventh added there must not silently arrive here as "Not recognised".
 */
const PAYMENT_METHOD_KEYS = new Set<string>(PAYMENT_METHODS);

const APPROVAL_TYPE_KEYS = new Set([
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
]);

function paymentBreakdown(section: Record<string, unknown> | null): ReportBreakdown[] {
  return list(section?.["methods"]).flatMap((entry) => {
    const line = record(entry);
    const method = text(line?.["method"]);
    if (!method) return [];
    return [
      {
        labelKey: PAYMENT_METHOD_KEYS.has(method)
          ? `settlement.methods.${method}`
          : `reports.unknownLabel`,
        rows: [
          row("paymentCount", line, "count", "count"),
          row("paymentTotalTzs", line, "amount_tzs", "money"),
        ],
      },
    ];
  });
}

function approvalBreakdown(
  entries: unknown,
  rowsFor: (line: Record<string, unknown> | null) => ReportRow[],
): ReportBreakdown[] {
  return list(entries).flatMap((entry) => {
    const line = record(entry);
    const type = text(line?.["approval_type"]);
    if (!type) return [];
    return [
      {
        labelKey: APPROVAL_TYPE_KEYS.has(type)
          ? `reports.approvalType.${type}`
          : `reports.unknownLabel`,
        rows: rowsFor(line),
      },
    ];
  });
}

function varianceRows(source: Record<string, unknown> | null): ReportRow[] {
  const reason = text(source?.["variance_reason"]);
  return [
    row("countedTzs", source, "counted_tzs", "money"),
    row("expectedTzs", source, "expected_tzs", "money"),
    // What was counted and what was expected are two amounts. The line between them is the finding,
    // and the only figure on this card a Director acts on — so it is the one the screen is told to
    // set apart (design.md §9.7).
    row("varianceTzs", source, "variance_tzs", "variance"),
    ...(reason ? [{ key: "varianceReason", figure: { kind: "text" as const, value: reason } }] : []),
  ];
}

/**
 * Both states that mean "somebody still has to do something about this cash".
 *
 * `confirmed` is settled and `no_fund` is not a count at all, so neither is listed. The two that
 * are listed are listed TOGETHER at the top and kept APART below: the overview says how many counts
 * are unresolved, and each section still says which kind of unresolved it is.
 */
const UNRESOLVED_STATES = new Set<ReportState>(["not_counted", "awaiting_manager_confirmation"]);

function overviewOf(
  sections: ReportSection[],
  invoices: Record<string, unknown> | null,
  payments: Record<string, unknown> | null,
  credit: Record<string, unknown> | null,
  pending: Record<string, unknown> | null,
): ReportOverview {
  return {
    headline: [
      row("summaryInvoicedTzs", invoices, "total_tzs", "money"),
      row("summaryCollectedTzs", payments, "total_tzs", "money"),
      row("summaryOutstandingTzs", credit, "outstanding_tzs", "money"),
      row("summaryPendingCount", pending, "count", "count"),
    ],
    unresolvedSectionKeys: sections
      .filter((section) => section.state && UNRESOLVED_STATES.has(section.state.state))
      .map((section) => section.key),
  };
}

/**
 * The stored snapshot, as an ordered list of sections.
 *
 * ORDER IS FIXED HERE rather than taken from the document, so two reports read the same way even if
 * a later schema adds or reorders keys, and so a section that failed to build is a visibly empty
 * section rather than one that silently vanished.
 */
export function readReport(content: unknown): ReportDocument {
  const root = record(content);
  const sections = record(root?.["sections"]);
  const schemaVersion =
    typeof root?.["schema_version"] === "number" ? (root["schema_version"] as number) : null;

  const sales = record(sections?.["sales"]);
  const invoices = record(sections?.["invoices"]);
  const payments = record(sections?.["payments_by_method"]);
  const credit = record(sections?.["outstanding_credit"]);
  const discounts = record(sections?.["discounts_and_approvals"]);
  const unreleased = record(sections?.["paid_but_unreleased"]);
  const released = record(sections?.["released_stock"]);
  const variances = record(sections?.["inventory_variances"]);
  const shortages = record(sections?.["supplier_shortages"]);
  const batches = record(sections?.["production_batches"]);
  const output = record(sections?.["production_output"]);
  const cashRecon = record(sections?.["cashier_reconciliation"]);
  const pending = record(sections?.["pending_approvals"]);
  const imprest = record(sections?.["imprest"]);
  const imprestFunding = record(imprest?.["funding"]);
  const imprestExpenses = record(imprest?.["approved_expenses"]);
  const imprestPosition = record(imprest?.["position"]);
  const imprestRecon = record(imprest?.["reconciliation"]);

  // Spending, verification and the fund's balance are not in the system yet (issue #51), so the
  // snapshot withholds both objects whole and says why in the imprest section's `unavailable` map.
  const imprestUnavailable = record(imprest?.["unavailable"]);
  const expensesReason = unavailableReason(imprestUnavailable?.["approved_expenses"]);
  const positionReason = unavailableReason(imprestUnavailable?.["position"]);

  const document = {
    businessDate: text(root?.["business_date"]),
    timeZone: text(root?.["time_zone"]),
    schemaVersion,
    understood: schemaVersion === REPORT_SCHEMA_VERSION,
    sections: [
      {
        key: "sales",
        rows: [
          row("ordersCreated", sales, "orders_created", "count"),
          row("ordersConfirmed", sales, "orders_confirmed", "count"),
          row("ordersCancelled", sales, "orders_cancelled", "count"),
          row("cashSalesConfirmed", sales, "cash_sales_confirmed", "count"),
        ],
      },
      {
        key: "invoices",
        rows: [
          row("invoicesIssued", invoices, "issued_count", "count"),
          row("invoicesCancelled", invoices, "cancelled_count", "count"),
          row("subtotalTzs", invoices, "subtotal_tzs", "money"),
          row("discountTzs", invoices, "discount_tzs", "money"),
          row("totalTzs", invoices, "total_tzs", "money"),
        ],
      },
      {
        key: "payments",
        rows: [
          row("paymentCount", payments, "count", "count"),
          row("paymentTotalTzs", payments, "total_tzs", "money"),
          row("reversalCount", payments, "reversal_count", "count"),
        ],
        breakdown: paymentBreakdown(payments),
      },
      {
        key: "outstandingCredit",
        noteKey: "asAtBusinessDate",
        rows: [
          row("creditInvoiceCount", credit, "invoice_count", "count"),
          row("outstandingTzs", credit, "outstanding_tzs", "money"),
        ],
      },
      {
        key: "discountsAndApprovals",
        rows: [
          row("discountedInvoiceCount", discounts, "discounted_invoice_count", "count"),
          row("discountTzs", discounts, "discount_tzs", "money"),
          row("approvalsRequested", discounts, "approvals_requested", "count"),
        ],
        breakdown: approvalBreakdown(discounts?.["by_type"], (line) => [
          row("approvalsRequested", line, "requested", "count"),
          row("approvalsApproved", line, "approved", "count"),
          row("approvalsRejected", line, "rejected", "count"),
        ]),
      },
      {
        key: "paidButUnreleased",
        noteKey: "asAtGeneration",
        rows: [
          row("allocationCount", unreleased, "allocation_count", "count"),
          row("outstandingQuantity", unreleased, "outstanding_quantity", "quantity"),
        ],
      },
      {
        key: "releasedStock",
        rows: [
          row("dispatchCount", released, "dispatch_count", "count"),
          row("releasedQuantity", released, "released_quantity", "quantity"),
        ],
      },
      {
        key: "inventoryVariances",
        rows: [
          row("adjustmentCount", variances, "adjustment_count", "count"),
          row("increaseQuantity", variances, "increase_quantity", "quantity"),
          row("decreaseQuantity", variances, "decrease_quantity", "quantity"),
          row("netQuantity", variances, "net_quantity", "quantity"),
        ],
      },
      {
        key: "supplierShortages",
        rows: [
          row("receiptCount", shortages, "receipt_count", "count"),
          row("shortLineCount", shortages, "short_line_count", "count"),
          row("shortQuantity", shortages, "short_quantity", "quantity"),
          row("damagedQuantity", shortages, "damaged_quantity", "quantity"),
        ],
      },
      {
        key: "productionBatches",
        rows: [
          row("batchesEntered", batches, "entered", "count"),
          row("batchesDraft", batches, "draft", "count"),
          row("batchesApproved", batches, "approved", "count"),
          row("batchesRejected", batches, "rejected", "count"),
          row("batchesCancelled", batches, "cancelled", "count"),
        ],
      },
      {
        key: "productionOutput",
        rows: [
          row("quantityMoulded", output, "quantity_moulded", "quantity"),
          row("rejectedAtMoulding", output, "rejected_at_moulding", "quantity"),
          row("inspectedLotCount", output, "inspected_lot_count", "count"),
          row("acceptedQuantity", output, "accepted_quantity", "quantity"),
          row("rejectedAtInspection", output, "rejected_at_inspection", "quantity"),
        ],
      },
      {
        key: "cashierReconciliation",
        state: stateOf(cashRecon),
        rows: varianceRows(cashRecon),
      },
      {
        key: "pendingApprovals",
        noteKey: "asAtGeneration",
        rows: [row("pendingCount", pending, "count", "count")],
        breakdown: approvalBreakdown(pending?.["by_type"], (line) => [
          row("pendingCount", line, "count", "count"),
        ]),
      },
      {
        key: "imprestFunding",
        state: stateOf(imprest),
        rows: [
          ...(text(imprest?.["fund_no"])
            ? [
                {
                  key: "fundNo",
                  figure: { kind: "text" as const, value: text(imprest?.["fund_no"])! },
                },
              ]
            : []),
          row("fundingRequestedCount", imprestFunding, "requested_count", "count"),
          row("fundingRequestedTzs", imprestFunding, "requested_tzs", "money"),
          row("fundingApprovedTzs", imprestFunding, "approved_tzs", "money"),
          row("fundingProvidedTzs", imprestFunding, "provided_tzs", "money"),
          row("fundingReceivedTzs", imprestFunding, "received_tzs", "money"),
        ],
      },
      {
        key: "imprestExpenses",
        rows: [
          row("approvedExpenseCount", imprestExpenses, "count", "count", expensesReason),
          row("approvedExpenseTzs", imprestExpenses, "amount_tzs", "money", expensesReason),
        ],
      },
      {
        key: "imprestPosition",
        noteKey: "asAtGeneration",
        rows: [
          row("postedTzs", imprestPosition, "posted_tzs", "money", positionReason),
          row("encumberedTzs", imprestPosition, "encumbered_tzs", "money", positionReason),
          row("availableTzs", imprestPosition, "available_tzs", "money", positionReason),
          row(
            "awaitingVerificationTzs",
            imprestPosition,
            "awaiting_verification_tzs",
            "money",
            positionReason,
          ),
        ],
      },
      {
        key: "imprestReconciliation",
        state: stateOf(imprestRecon),
        rows: varianceRows(imprestRecon),
      },
    ],
  };

  const withReasons = {
    ...document,
    sections: document.sections.map(
      (section): ReportSection => ({ ...section, unavailableReasonKeys: reasonsOf(section.rows) }),
    ),
  };

  return {
    ...withReasons,
    overview: overviewOf(withReasons.sections, invoices, payments, credit, pending),
  };
}

/**
 * How many sections a report has: seventeen, counted from the reader rather than written down
 * beside it.
 *
 * `[id]/loading.tsx` has to render one placeholder per section, and a placeholder count kept in a
 * second place is one that stops matching the first time a section is added — silently, because a
 * skeleton of the wrong length fails no test and throws no error. Reading it back out of
 * `readReport` costs one call at module load and cannot drift.
 *
 * `null` is a legitimate argument: the reader builds every section whatever the snapshot holds, and
 * fills the ones it found nothing for with "not recorded". That is the same property this constant
 * depends on.
 */
export const REPORT_SECTION_COUNT = readReport(null).sections.length;
