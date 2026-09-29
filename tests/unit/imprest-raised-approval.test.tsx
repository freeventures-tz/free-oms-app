import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { fieldErrors } from "@/lib/validation/auth";
import {
  handOutRaiseSchema,
  raiseApprovalSchema,
  refuseRaiseSchema,
  requestRaiseSchema,
} from "@/lib/validation/imprest";

/**
 * Issue #70: what the browser checks before a raised-approval command reaches the database (which
 * checks it all again), which step the Cashier is shown, and the words the screens use.
 */

const requestRaise = vi.fn();
const handOutRaise = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  requestRaiseAction: (...args: unknown[]) => requestRaise(...args),
  handOutRaiseAction: (...args: unknown[]) => handOutRaise(...args),
  handOutDisbursementAction: vi.fn(),
  settleDisbursementAction: vi.fn(),
  registerReceiptAction: vi.fn(),
  openReceiptAction: vi.fn(),
}));

const { CashierStep } = await import("@/app/(app)/imprest/settlement-forms");

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const RAISE = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

const base = { disbursementId: ID, expectedVersion: "4", idempotencyKey: KEY };

describe("the request input", () => {
  const request = (overrides: Record<string, unknown> = {}) =>
    requestRaiseSchema.safeParse({ ...base, amount: "20,000", reason: "  The road   toll rose ", ...overrides });

  it("carries a whole-shilling increase and a tidied reason", () => {
    const parsed = request();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ amount: 20000, reason: "The road toll rose", expectedVersion: 4 });
  });

  it("refuses nothing, a fraction, and words for the amount", () => {
    for (const amount of ["0", "-5", "1500.5", "lots", ""]) {
      const parsed = request({ amount });
      expect(parsed.success, `amount ${amount}`).toBe(false);
      if (!parsed.success) expect(fieldErrors(parsed.error).amount).toMatch(/^spendingErrors\./);
    }
  });

  it("refuses a reason under 3 or over 500 characters", () => {
    for (const reason of ["", "  ", "no", "x".repeat(501)]) {
      const parsed = request({ reason });
      expect(parsed.success, `reason ${reason.length}`).toBe(false);
      if (!parsed.success) expect(fieldErrors(parsed.error).reason).toBe("spendingErrors.reason_required");
    }
    expect(request({ reason: "x".repeat(500) }).success).toBe(true);
  });
});

describe("the decision and hand-out inputs", () => {
  it("raise names the request and carries no amount", () => {
    const parsed = raiseApprovalSchema.safeParse({ ...base, raiseId: RAISE });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {})).not.toContain("amount");
    const bad = raiseApprovalSchema.safeParse({ ...base, raiseId: "nope" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(fieldErrors(bad.error).raiseId).toBe("spendingErrors.no_raise_request");
  });

  it("refuse needs a reason", () => {
    expect(refuseRaiseSchema.safeParse({ ...base, raiseId: RAISE, reason: "no" }).success).toBe(false);
    expect(refuseRaiseSchema.safeParse({ ...base, raiseId: RAISE, reason: "Too much for one trip" }).success).toBe(true);
  });

  it("hand-out needs a recipient of 2 to 120 characters and carries no amount", () => {
    expect(handOutRaiseSchema.safeParse({ ...base, raiseId: RAISE, recipient: "J" }).success).toBe(false);
    const parsed = handOutRaiseSchema.safeParse({ ...base, raiseId: RAISE, recipient: " Juma  Ali " });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.recipient).toBe("Juma Ali");
    expect(Object.keys(parsed.data ?? {})).not.toContain("amount");
  });
});

const view = (props: {
  status: string;
  openRequest?: { id: string; amount: number } | null;
  awaitingHandOut?: { id: string; amount: number } | null;
}) => (
  <NextIntlClientProvider locale="en" messages={en}>
    <CashierStep
      status={props.status}
      disbursement={{ id: ID, version: 4 }}
      amount={80000}
      sentBack={{ reason: "Needs a receipt", by: "Manager", at: "today" }}
      raise={{ openRequest: props.openRequest ?? null, awaitingHandOut: props.awaitingHandOut ?? null }}
    />
  </NextIntlClientProvider>
);

beforeEach(() => {
  requestRaise.mockReset();
  handOutRaise.mockReset();
});

describe("the Cashier's step while cash is out", () => {
  it("offers to settle, and to ask for more beside it", () => {
    render(view({ status: "handed_out" }));
    expect(screen.getByRole("heading", { name: en.imprest.spending.settle.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask for more" })).toBeInTheDocument();
  });

  it("sends the increase and the reason, and keeps the answer", async () => {
    const user = userEvent.setup();
    requestRaise.mockResolvedValueOnce({ successKey: "imprest.spending.success.raiseRequested" });
    render(view({ status: "handed_out" }));

    await user.click(screen.getByRole("button", { name: "Ask for more" }));
    await user.type(screen.getByLabelText(en.imprest.spending.raise.amount), "20000");
    await user.type(screen.getByLabelText(en.imprest.spending.raise.reason), "The road toll rose");
    await user.click(screen.getByRole("button", { name: en.imprest.spending.raise.submit }));

    await waitFor(() => expect(requestRaise).toHaveBeenCalledTimes(1));
    const sent = requestRaise.mock.calls[0][1] as FormData;
    expect(sent.get("disbursementId")).toBe(ID);
    expect(sent.get("expectedVersion")).toBe("4");
    expect(sent.get("amount")).toBe("20000");
    expect(sent.get("reason")).toBe("The road toll rose");
    expect(await screen.findByText(en.imprest.spending.success.raiseRequested)).toBeInTheDocument();
  });

  it("holds the settlement back while a request waits for the Manager", () => {
    render(view({ status: "handed_out", openRequest: { id: RAISE, amount: 20000 } }));
    expect(screen.queryByRole("heading", { name: en.imprest.spending.settle.title })).toBeNull();
    expect(screen.getByTestId("raise-waiting")).toHaveTextContent("Waiting for the Manager");
    expect(screen.queryByRole("button", { name: "Ask for more" })).toBeNull();
  });

  it("asks who received the extra once the approval is raised, instead of settling", async () => {
    const user = userEvent.setup();
    handOutRaise.mockResolvedValueOnce({ successKey: "imprest.spending.success.raiseHandedOut" });
    render(view({ status: "handed_out", awaitingHandOut: { id: RAISE, amount: 20000 } }));
    expect(screen.queryByRole("heading", { name: en.imprest.spending.settle.title })).toBeNull();

    await user.type(screen.getByLabelText(en.imprest.spending.raise.recipient), "Juma Ali");
    await user.click(screen.getByRole("button", { name: en.imprest.spending.raise.handOutSubmit }));
    await waitFor(() => expect(handOutRaise).toHaveBeenCalledTimes(1));
    const sent = handOutRaise.mock.calls[0][1] as FormData;
    expect(sent.get("raiseId")).toBe(RAISE);
    expect(sent.get("recipient")).toBe("Juma Ali");
    expect(await screen.findByText(en.imprest.spending.success.raiseHandedOut)).toBeInTheDocument();
  });
});

describe("a request whose answer was lost", () => {
  it("keeps the form open with its draft, and Try again resends the same key", async () => {
    const user = userEvent.setup();
    requestRaise.mockRejectedValueOnce(new Error("connection dropped"));
    requestRaise.mockResolvedValueOnce({ successKey: "imprest.spending.success.raiseRequested" });
    render(view({ status: "handed_out" }));

    await user.click(screen.getByRole("button", { name: "Ask for more" }));
    await user.type(screen.getByLabelText(en.imprest.spending.raise.amount), "20000");
    await user.type(screen.getByLabelText(en.imprest.spending.raise.reason), "The road toll rose");
    await user.click(screen.getByRole("button", { name: en.imprest.spending.raise.submit }));

    expect(await screen.findByText(/may or may not have been saved/)).toBeInTheDocument();
    // The request may have committed, so the form cannot be closed and lose its draft under that key.
    expect(screen.getByTestId("ask-for-more-toggle")).toBeDisabled();
    expect(screen.getByLabelText(en.imprest.spending.raise.amount)).toHaveValue("20000");
    expect(screen.getByLabelText(en.imprest.spending.raise.reason)).toHaveValue("The road toll rose");

    await user.click(screen.getByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(requestRaise).toHaveBeenCalledTimes(2));
    const first = requestRaise.mock.calls[0][1] as FormData;
    const second = requestRaise.mock.calls[1][1] as FormData;
    expect(second.get("idempotencyKey")).toBe(first.get("idempotencyKey"));
    expect(second.get("amount")).toBe("20000");
    expect(await screen.findByText(en.imprest.spending.success.raiseRequested)).toBeInTheDocument();
  });
});

describe("the Cashier's step while sent back", () => {
  it("can ask for more beside the next cycle", () => {
    render(view({ status: "sent_back" }));
    expect(screen.getByRole("heading", { name: en.imprest.spending.settleAgain.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask for more" })).toBeInTheDocument();
  });

  it("waits for a raise before settling again", () => {
    render(view({ status: "sent_back", awaitingHandOut: { id: RAISE, amount: 8000 } }));
    expect(screen.getByRole("heading", { name: en.imprest.spending.settleAgain.title })).toBeInTheDocument();
    expect(screen.getByTestId("hand-out-extra")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: en.imprest.spending.settle.title })).toBeNull();
  });
});

describe("the words", () => {
  const keys = (obj: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === "object" ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
    );

  it("gives every new screen key an English and a Swahili wording", () => {
    for (const group of ["raise", "approval"] as const) {
      expect(keys(sw.imprest.spending[group])).toEqual(keys(en.imprest.spending[group]));
    }
    for (const key of ["raise_open", "no_raise_request", "raise_not_handed_out"] as const) {
      expect(en.spendingErrors[key]).toBeTruthy();
      expect(sw.spendingErrors[key]).toBeTruthy();
    }
    for (const key of ["raiseRequested", "raised", "raiseRefused", "raiseHandedOut"] as const) {
      expect(en.imprest.spending.success[key]).toBeTruthy();
      expect(sw.imprest.spending.success[key]).toBeTruthy();
    }
  });

  it("names every raise step in the history", () => {
    for (const kind of ["raise_requested", "raise_raised", "raise_refused", "raise_handed_out"] as const) {
      expect(en.imprest.spending.history[kind]).toBeTruthy();
      expect(sw.imprest.spending.history[kind]).toBeTruthy();
    }
  });
});
