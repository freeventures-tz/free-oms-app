import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import type { CuringLot, ProductionBatch, RecipeInput, YieldRange } from "@/lib/production/production";
import type { Page } from "@/lib/settlement/settlement";

/**
 * A production board left open across a curing deadline.
 *
 * §11.4 makes readiness a comparison against a stored instant, and the server answers it once, when
 * the page renders. A Manager who opens the board twenty minutes before a lot is due and waits —
 * which is exactly what somebody standing beside the curing shed does — would otherwise still be
 * looking at a disabled control with "the 72 hours are not up yet" under it, on a lot that is ready.
 *
 * Two things have to be true at once, and the second is the one that is easy to lose: readiness
 * refreshes, AND nothing the Manager has typed is thrown away doing it. Re-fetching the page, or
 * rebuilding the card from a fresh prop, would clear a half-entered inspection every thirty seconds.
 */

vi.mock("@/app/(app)/production/actions", () => ({
  enterBatchAction: vi.fn(),
  approveBatchAction: vi.fn(),
  rejectBatchAction: vi.fn(),
  inspectLotAction: vi.fn(),
}));

const { ProductionBoard } = await import("@/app/(app)/production/production-board");

const RECIPE: RecipeInput[] = [
  {
    productId: "11111111-1111-4111-8111-111111111111",
    productName: "Sand",
    unitCode: "bucket",
    standardQuantity: 5,
    sortOrder: 10,
  },
];

const YIELDS: YieldRange[] = [
  {
    productId: "22222222-2222-4222-8222-222222222222",
    productName: 'Tofali 6"',
    minPerBatch: 20,
    maxPerBatch: 25,
  },
];

/** Rendered at 09:00; the lot is due at 09:10, and the server has said it is not ready yet. */
const RENDERED_AT = new Date("2026-08-25T06:00:00Z");
const READY_AT = "2026-08-25T06:10:00.000Z";

function lot(overrides: Partial<CuringLot> = {}): CuringLot {
  return {
    lotId: "33333333-3333-4333-8333-333333333333",
    batchId: "44444444-4444-4444-8444-444444444444",
    batchNo: "FV-BAT-20260822-0001",
    productId: YIELDS[0]!.productId,
    productName: 'Tofali 6"',
    locationCode: "yard",
    quantityCuring: 20,
    quantityMoulded: 22,
    rejectedAtMoulding: 2,
    mouldingRejectReason: "broken",
    curingStartedAt: "2026-08-22T06:10:00.000Z",
    readyAt: READY_AT,
    readyForInspection: false,
    ...overrides,
  };
}

function page<T>(rows: T[]): Page<T> {
  return { rows, total: rows.length, page: 1, pageSize: 25 };
}

function renderBoard(lots: CuringLot[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ProductionBoard
        drafts={page<ProductionBatch>([])}
        curing={page(lots)}
        history={page<ProductionBatch>([])}
        recipe={RECIPE}
        yields={YIELDS}
        locations={[{ code: "yard", sortOrder: 3 }]}
        units={[
          { code: "bucket", sortOrder: 1, labelEn: "buckets", labelSw: "ndoo", isActive: true },
        ]}
        canRun
        idempotencyKey="55555555-5555-4555-8555-555555555555"
        businessNow="2026-08-25T09:00"
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(RENDERED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a curing deadline that passes while the page is open", () => {
  it("starts from what the database said, and refuses the inspection until then", async () => {
    renderBoard([lot()]);

    await waitFor(() => {
      expect(screen.getByText(/still curing/i)).toBeInTheDocument();
    });

    expect(screen.getByTestId("inspect-33333333-3333-4333-8333-333333333333")).toBeDisabled();
    expect(screen.getByText(/the 72 hours are not up yet/i)).toBeInTheDocument();
  });

  it("says how long is left, in words rather than in a moving bar", async () => {
    renderBoard([lot()]);

    await waitFor(() => {
      expect(
        screen.getByTestId("lot-remaining-33333333-3333-4333-8333-333333333333"),
      ).toHaveTextContent("0h 10m left");
    });
  });

  it("opens the inspection when the deadline passes, without a reload", async () => {
    renderBoard([lot()]);

    const inspect = screen.getByTestId("inspect-33333333-3333-4333-8333-333333333333");
    await waitFor(() => expect(inspect).toBeDisabled());

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    await waitFor(() => expect(inspect).toBeEnabled());
    expect(screen.getByText("Ready for inspection")).toBeInTheDocument();
    expect(screen.queryByText(/still curing/i)).not.toBeInTheDocument();
    // AC-44: ready for INSPECTION, and the words never say ready to sell.
    expect(screen.getByText(/only the accepted bricks become available for sale/i)).toBeVisible();
  });

  it("keeps everything already typed when readiness refreshes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderBoard([lot({ readyForInspection: true })]);

    const accepted = screen.getByLabelText(/^accepted$/i);
    await user.type(accepted, "18");
    await user.clear(screen.getByLabelText(/^rejected$/i));
    await user.type(screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByRole("button", { name: /^cracked$/i }));

    // Two clock ticks, which is what a page open for a minute produces.
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(accepted).toHaveValue("18");
    expect(screen.getByLabelText(/^rejected$/i)).toHaveValue("2");
    expect(screen.getByRole("button", { name: /^cracked$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("never narrows readiness: a lot the server called ready stays ready", async () => {
    // The clock only ever widens what is inspectable. A device set slow must not close a control
    // the database has already opened — the server refuses an early inspection either way, and the
    // screen contradicting it would be the confusing half of that.
    renderBoard([lot({ readyForInspection: true, readyAt: "2099-01-01T00:00:00.000Z" })]);

    await waitFor(() => {
      expect(screen.getByTestId("inspect-33333333-3333-4333-8333-333333333333")).toBeEnabled();
    });
    expect(screen.getByText("Ready for inspection")).toBeInTheDocument();
  });
});

describe("what the board shows when a queue is empty", () => {
  it("says the shed is empty rather than showing nothing at all", async () => {
    renderBoard([]);

    expect(screen.getByText(/nothing is curing/i)).toBeInTheDocument();
    expect(screen.getByText(/no batch is waiting for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/no batch has been decided yet/i)).toBeInTheDocument();
  });
});
