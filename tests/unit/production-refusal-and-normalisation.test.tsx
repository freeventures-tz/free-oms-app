import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import { parseQuantity } from "@/lib/validation/production";
import type {
  CuringLot,
  ProductionBatch,
  RecipeInput,
  YieldRange,
} from "@/lib/production/production";
import type { Page } from "@/lib/settlement/settlement";

/**
 * Two ways the production board used to answer a Manager with nothing at all.
 *
 * A REFUSAL NOBODY COULD READ. `rejectBatchAction` and `inspectLotAction` answer a failed schema
 * with FIELD ERRORS AND NOTHING ELSE — no `error` key — and both cards rendered `result.error`
 * alone. Rejecting a batch with a one-character reason, or inspecting a lot with the accepted count
 * left blank, therefore finished silently: the control stopped working, nothing changed, and the
 * screen never said why. design.md §12.7 rule 4 makes a refusal that says nothing a defect.
 *
 * A REQUEST NOBODY TYPED. The reject-reason buttons and the yield explanation appear only while
 * there is something to explain, and the values behind them outlived the controls. Correcting a
 * count to zero, or a moulded output back into its approved range, left `cracked` or an explanation
 * in state and still sent them — and the database refused the whole otherwise-valid command over a
 * field that was no longer on the screen.
 *
 * Both are about the same promise: what the screen shows is what gets sent, and what comes back is
 * shown where somebody can act on it — with everything they typed still there.
 */

const enterBatchAction = vi.fn();
const approveBatchAction = vi.fn();
const rejectBatchAction = vi.fn();
const inspectLotAction = vi.fn();

vi.mock("@/app/(app)/production/actions", () => ({
  enterBatchAction: (...args: unknown[]) => enterBatchAction(...args),
  approveBatchAction: (...args: unknown[]) => approveBatchAction(...args),
  rejectBatchAction: (...args: unknown[]) => rejectBatchAction(...args),
  inspectLotAction: (...args: unknown[]) => inspectLotAction(...args),
}));

const { ProductionBoard } = await import("@/app/(app)/production/production-board");

const SAND = "11111111-1111-4111-8111-111111111111";
const BRICK = "22222222-2222-4222-8222-222222222222";
const LOT = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";

const RECIPE: RecipeInput[] = [
  { productId: SAND, productName: "Sand", unitCode: "bucket", standardQuantity: 5, sortOrder: 10 },
];

/** §11.2's approved range, so 18 is outside it and 22 is not. */
const YIELDS: YieldRange[] = [
  { productId: BRICK, productName: 'Tofali 6"', minPerBatch: 20, maxPerBatch: 25 },
];

function page<T>(rows: T[]): Page<T> {
  return { rows, total: rows.length, page: 1, pageSize: 25 };
}

/** A lot the server has already called ready, so the inspection controls are live. */
function readyLot(): CuringLot {
  return {
    lotId: LOT,
    batchId: BATCH,
    batchNo: "FV-BAT-20260822-0001",
    productId: BRICK,
    productName: 'Tofali 6"',
    locationCode: "yard",
    quantityCuring: 20,
    quantityMoulded: 22,
    rejectedAtMoulding: 2,
    mouldingRejectReason: "broken",
    curingStartedAt: "2026-08-22T06:10:00.000Z",
    readyAt: "2026-08-25T06:10:00.000Z",
    readyForInspection: true,
  };
}

/** A batch nobody has decided, which is the only state that offers Approve and Reject. */
function draftBatch(): ProductionBatch {
  return {
    id: BATCH,
    batchNo: "FV-BAT-20260822-0001",
    locationCode: "yard",
    status: "draft",
    mouldedAt: "2026-08-22T06:10:00.000Z",
    yieldNote: null,
    enteredByName: "The Manager",
    enteredRole: "manager",
    enteredAt: "2026-08-22T06:20:00.000Z",
    decidedByName: null,
    decidedRole: null,
    decidedAt: null,
    decisionReason: null,
    inputs: [
      {
        productId: SAND,
        productName: "Sand",
        unitCode: "bucket",
        standardQuantity: 5,
        actualQuantity: 5,
        varianceQuantity: 0,
      },
    ],
    lots: [],
  };
}

function renderBoard({
  drafts = [],
  curing = [],
}: { drafts?: ProductionBatch[]; curing?: CuringLot[] } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ProductionBoard
        drafts={page(drafts)}
        curing={page(curing)}
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

/** Replaces a field's contents the way somebody correcting a number does. */
async function retype(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  value: string,
) {
  await user.clear(field);
  if (value !== "") await user.type(field, value);
}

/** The lines the entry form actually submitted, parsed back out of the request. */
function submittedOutputs() {
  const data = enterBatchAction.mock.calls[0]![1] as FormData;
  return JSON.parse(String(data.get("outputs"))) as {
    productId: string;
    quantityMoulded: string;
    rejectedQuantity: string;
    rejectReason: string;
  }[];
}

beforeEach(() => {
  enterBatchAction.mockReset();
  approveBatchAction.mockReset();
  rejectBatchAction.mockReset();
  inspectLotAction.mockReset();
});

// ---------------------------------------------------------------------------
// R1 · A refusal that names the field, announces itself, and keeps what was typed
// ---------------------------------------------------------------------------
describe("a batch rejection the schema refuses", () => {
  it("says what was wrong, against the control it was wrong about", async () => {
    const user = userEvent.setup();
    rejectBatchAction.mockResolvedValue({
      fieldErrors: { reason: "productionErrors.reason.tooShort" },
    });

    renderBoard({ drafts: [draftBatch()] });

    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    const reason = screen.getByLabelText(/why it is being rejected/i);
    await user.type(reason, "x");
    await user.click(screen.getByTestId(`confirm-reject-${BATCH}`));

    // ANNOUNCED once, as an alert, and focused — so somebody who cannot see the card is told the
    // command was refused rather than left watching a control that simply stopped working.
    const alert = await screen.findByTestId(`reject-problems-${BATCH}`);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/at least three characters/i);
    await waitFor(() => expect(alert).toHaveFocus());

    // ASSOCIATED with the field, so arriving at it later still carries the reason.
    expect(reason).toHaveAttribute("aria-invalid", "true");
    const describedBy = reason.getAttribute("aria-describedby");
    expect(describedBy).toBe(`reason-error-${BATCH}`);
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      /at least three characters/i,
    );

    // AND NOTHING IS THROWN AWAY: the panel is still open with the words still in it.
    expect(reason).toHaveValue("x");
  });
});

describe("an inspection the schema refuses", () => {
  it("names the accepted count, announces it, and keeps the rest of the entry", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({
      fieldErrors: { acceptedQuantity: "productionErrors.quantity.invalid" },
    });

    renderBoard({ curing: [readyLot()] });

    // Everything except the accepted count, which is what the refusal is about.
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`lot-reject-${LOT}-cracked`));
    await user.click(screen.getByTestId(`inspect-${LOT}`));

    const alert = await screen.findByTestId(`inspect-problems-${LOT}`);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/enter a whole number/i);
    await waitFor(() => expect(alert).toHaveFocus());

    const accepted = screen.getByLabelText(/^accepted$/i);
    expect(accepted).toHaveAttribute("aria-invalid", "true");
    expect(accepted).toHaveAttribute("aria-describedby", `accepted-error-${LOT}`);
    expect(document.getElementById(`accepted-error-${LOT}`)).toHaveTextContent(
      /enter a whole number/i,
    );

    expect(screen.getByLabelText(/^rejected$/i)).toHaveValue("2");
    expect(screen.getByTestId(`lot-reject-${LOT}-cracked`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("associates a reject-reason refusal with the group of buttons it is about", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({
      fieldErrors: { rejectReason: "productionErrors.reject_reason_required" },
    });

    renderBoard({ curing: [readyLot()] });

    await retype(user, screen.getByLabelText(/^accepted$/i), "18");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`inspect-${LOT}`));

    await screen.findByTestId(`inspect-problems-${LOT}`);

    // The control is four buttons rather than one field, so the message is associated with the
    // group they are named as.
    const group = screen.getByRole("group", { name: /^why$/i });
    expect(group).toHaveAttribute("aria-describedby", `lot-reason-error-${LOT}`);
    expect(document.getElementById(`lot-reason-error-${LOT}`)).toHaveTextContent(
      /choose why they were thrown away/i,
    );
  });
});

// ---------------------------------------------------------------------------
// R2 · What the screen shows is what gets sent
// ---------------------------------------------------------------------------
describe("a value whose control has gone", () => {
  it("sends no inspection reject reason once the count is corrected to zero", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({ successKey: "production.inspection.recorded" });

    renderBoard({ curing: [readyLot()] });

    // 18 accepted, 2 thrown away, Cracked — then the whole lot turns out to be good.
    await retype(user, screen.getByLabelText(/^accepted$/i), "18");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`lot-reject-${LOT}-cracked`));

    await retype(user, screen.getByLabelText(/^accepted$/i), "20");
    await retype(user, screen.getByLabelText(/^rejected$/i), "0");

    // The buttons are gone, which is exactly why the choice behind them must not be submitted.
    expect(screen.queryByTestId(`lot-reject-${LOT}-cracked`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`inspect-${LOT}`));
    await waitFor(() => expect(inspectLotAction).toHaveBeenCalledTimes(1));

    const data = inspectLotAction.mock.calls[0]![1] as FormData;
    expect(data.get("acceptedQuantity")).toBe("20");
    expect(data.get("rejectedQuantity")).toBe("0");
    expect(data.get("rejectReason")).toBe("");
  });

  it("sends no moulding reject reason once the count is corrected to zero", async () => {
    const user = userEvent.setup();
    enterBatchAction.mockResolvedValue({ successKey: "production.batch.entered" });

    renderBoard();

    await user.click(screen.getByRole("button", { name: /record a batch/i }));
    await retype(user, screen.getByLabelText(/^moulded$/i), "22");
    await retype(user, screen.getByLabelText(/thrown away at the mould/i), "2");
    await user.click(screen.getByTestId(`moulding-reject-${BRICK}-cracked`));

    await retype(user, screen.getByLabelText(/thrown away at the mould/i), "0");
    expect(screen.queryByTestId(`moulding-reject-${BRICK}-cracked`)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save the batch/i }));
    await waitFor(() => expect(enterBatchAction).toHaveBeenCalledTimes(1));

    const outputs = submittedOutputs();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.quantityMoulded).toBe("22");
    expect(outputs[0]!.rejectedQuantity).toBe("0");
    expect(outputs[0]!.rejectReason).toBe("");
  });

  it("sends no yield explanation once the output is corrected back into range", async () => {
    const user = userEvent.setup();
    enterBatchAction.mockResolvedValue({ successKey: "production.batch.entered" });

    renderBoard();

    await user.click(screen.getByRole("button", { name: /record a batch/i }));

    // 18 is below the approved minimum, so §11.2's explanation is asked for.
    await retype(user, screen.getByLabelText(/^moulded$/i), "18");
    const note = screen.getByLabelText(/what happened/i);
    await user.type(note, "the mixer stopped");

    // Recounted: 22 is an ordinary batch, and the field disappears.
    await retype(user, screen.getByLabelText(/^moulded$/i), "22");
    expect(screen.queryByLabelText(/what happened/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save the batch/i }));
    await waitFor(() => expect(enterBatchAction).toHaveBeenCalledTimes(1));

    const data = enterBatchAction.mock.calls[0]![1] as FormData;
    expect(data.get("yieldNote")).toBe("");
  });

  it("keeps the choice in state, so correcting the count back restores the request", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({ successKey: "production.inspection.recorded" });

    renderBoard({ curing: [readyLot()] });

    await retype(user, screen.getByLabelText(/^accepted$/i), "18");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`lot-reject-${LOT}-cracked`));

    await retype(user, screen.getByLabelText(/^rejected$/i), "0");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");

    // Nothing was cleared while the buttons were hidden: Cracked is still the answer.
    expect(screen.getByTestId(`lot-reject-${LOT}-cracked`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByTestId(`inspect-${LOT}`));
    await waitFor(() => expect(inspectLotAction).toHaveBeenCalledTimes(1));

    const data = inspectLotAction.mock.calls[0]![1] as FormData;
    expect(data.get("rejectedQuantity")).toBe("2");
    expect(data.get("rejectReason")).toBe("cracked");
  });
});

// ---------------------------------------------------------------------------
// R2 · The retry addresses the request that was actually sent
// ---------------------------------------------------------------------------
describe("a retry after an uncertain transport failure", () => {
  it("re-sends the identical payload and the identical key", async () => {
    const user = userEvent.setup();
    // Thrown rather than returned: no verdict was reached, so the command may or may not have run.
    inspectLotAction.mockRejectedValue(new Error("the connection dropped"));

    renderBoard({ curing: [readyLot()] });

    await retype(user, screen.getByLabelText(/^accepted$/i), "18");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`lot-reject-${LOT}-cracked`));
    await user.click(screen.getByTestId(`inspect-${LOT}`));

    const card = screen.getByRole("article", { name: /tofali/i });
    const retry = await within(card).findByRole("button", { name: /try again/i });
    await waitFor(() => expect(retry).toBeEnabled());

    await user.click(retry);
    await waitFor(() => expect(inspectLotAction).toHaveBeenCalledTimes(2));

    const first = [...(inspectLotAction.mock.calls[0]![1] as FormData).entries()];
    const second = [...(inspectLotAction.mock.calls[1]![1] as FormData).entries()];

    // The same bytes and the same idempotency key, so a command that DID reach the database is
    // resumed rather than issued a second time.
    expect(second).toEqual(first);
    expect(Object.fromEntries(second)).toMatchObject({
      lotId: LOT,
      acceptedQuantity: "18",
      rejectedQuantity: "2",
      rejectReason: "cracked",
    });
  });
});

// ---------------------------------------------------------------------------
// A figure with a leading zero, read the same way by the screen and by the wire
// ---------------------------------------------------------------------------

/**
 * `00`, `02` and `018` are what a numeric keypad produces by accident, and the schema has always
 * captured them as 0, 2 and 18. The board read them with `Number.parseInt` behind a round-trip
 * guard, which called all three "not a number yet" -- so the screen fell silent about a figure it
 * was about to send anyway.
 *
 * Each test below fails on the old reading, and each failure is a Manager being refused for
 * something the screen never showed them.
 */
describe("a quantity written with a leading zero", () => {
  it("asks for the explanation an out-of-range figure needs, and sends the figure", async () => {
    const user = userEvent.setup();
    enterBatchAction.mockResolvedValue({ successKey: "production.batch.entered" });

    renderBoard();

    await user.click(screen.getByRole("button", { name: /record a batch/i }));
    // 18 is below the approved 20, so §11.2 requires an explanation. Written `018`, the old screen
    // saw nothing at all: no out-of-range warning, no explanation field, and 18 on the wire -- the
    // database then refused the batch for a missing explanation nobody had been asked for.
    await retype(user, screen.getByLabelText(/^moulded$/i), "018");

    expect(screen.getByText(/outside the expected range/i)).toBeInTheDocument();
    const note = screen.getByLabelText(/what happened/i);
    await user.type(note, "the mix was short");

    await user.click(screen.getByRole("button", { name: /save the batch/i }));
    await waitFor(() => expect(enterBatchAction).toHaveBeenCalledTimes(1));

    const data = enterBatchAction.mock.calls[0]![1] as FormData;
    expect(data.get("yieldNote")).toBe("the mix was short");

    // The wire carries what was typed, and the schema reads it as the number the screen showed.
    const line = submittedOutputs()[0]!;
    expect(line.quantityMoulded).toBe("018");
    expect(parseQuantity(line.quantityMoulded)).toBe(18);
  });

  it("offers the reject reason that a non-zero count makes compulsory", async () => {
    const user = userEvent.setup();
    enterBatchAction.mockResolvedValue({ successKey: "production.batch.entered" });

    renderBoard();

    await user.click(screen.getByRole("button", { name: /record a batch/i }));
    await retype(user, screen.getByLabelText(/^moulded$/i), "22");
    // Two thrown away, written `02`. The old screen read that as zero, hid the four reason buttons,
    // and sent a count of 2 with no reason -- refused with `reject_reason_required`, naming a
    // control the Manager had never been shown.
    await retype(user, screen.getByLabelText(/thrown away at the mould/i), "02");

    const cracked = screen.getByTestId(`moulding-reject-${BRICK}-cracked`);
    expect(cracked).toBeInTheDocument();
    await user.click(cracked);

    await user.click(screen.getByRole("button", { name: /save the batch/i }));
    await waitFor(() => expect(enterBatchAction).toHaveBeenCalledTimes(1));

    const line = submittedOutputs()[0]!;
    expect(line.rejectedQuantity).toBe("02");
    expect(parseQuantity(line.rejectedQuantity)).toBe(2);
    expect(line.rejectReason).toBe("cracked");
  });

  it("sends no reason for a count of `00`, because `00` is none", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({ successKey: "production.inspection.recorded" });

    renderBoard({ curing: [readyLot()] });

    await retype(user, screen.getByLabelText(/^accepted$/i), "18");
    await retype(user, screen.getByLabelText(/^rejected$/i), "2");
    await user.click(screen.getByTestId(`lot-reject-${LOT}-cracked`));

    // Corrected to none, written `00`. The old screen hid the buttons AND kept the choice, so a
    // reason went with a count of zero and the database refused the whole inspection.
    await retype(user, screen.getByLabelText(/^accepted$/i), "20");
    await retype(user, screen.getByLabelText(/^rejected$/i), "00");

    expect(screen.queryByTestId(`lot-reject-${LOT}-cracked`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`inspect-${LOT}`));
    await waitFor(() => expect(inspectLotAction).toHaveBeenCalledTimes(1));

    const data = inspectLotAction.mock.calls[0]![1] as FormData;
    expect(data.get("rejectedQuantity")).toBe("00");
    expect(parseQuantity(String(data.get("rejectedQuantity")))).toBe(0);
    expect(data.get("rejectReason")).toBe("");
  });

  it("counts a leading-zero figure into the accounted-for total the lot is checked against", async () => {
    const user = userEvent.setup();
    inspectLotAction.mockResolvedValue({ successKey: "production.inspection.recorded" });

    renderBoard({ curing: [readyLot()] });

    // 20 cured. `018` accepted and 0 rejected accounts for 18, and the screen must say so BEFORE
    // the database does -- the old reading made the total unknowable and showed nothing.
    await retype(user, screen.getByLabelText(/^accepted$/i), "018");
    await retype(user, screen.getByLabelText(/^rejected$/i), "0");

    expect(screen.getByText(/20 cured and you have accounted for 18/i)).toBeInTheDocument();
  });

  it("still shows nothing for a figure that is not a count at all", async () => {
    const user = userEvent.setup();

    renderBoard({ curing: [readyLot()] });

    // The alignment must not turn "unreadable" into "zero": there is no total to state, so the
    // screen states none, and the schema refuses the entry.
    await retype(user, screen.getByLabelText(/^accepted$/i), "1.5");
    await retype(user, screen.getByLabelText(/^rejected$/i), "0");

    expect(screen.queryByText(/the two must match/i)).not.toBeInTheDocument();
  });
});
