import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import type { FundingSummary } from "@/lib/imprest/funding";

/**
 * Review F1 on PR #49, at the screen. When the answer to a server action never reaches the
 * browser, the action THROWS, and the shared hook showed "That did not work. Try again." — which is
 * as false as "nothing was changed" when the request, approval or receipt had already committed.
 *
 * The screen must say the outcome is unknown, and Try again must send the very same request, key
 * included, so the database replays the first result instead of recording a second one.
 */

const requestFundingAction = vi.fn();
const confirmReceivedAction = vi.fn();
const rejectFundingAction = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  requestFundingAction: (...args: unknown[]) => requestFundingAction(...args),
  confirmReceivedAction: (...args: unknown[]) => confirmReceivedAction(...args),
  approveFundingAction: vi.fn(),
  rejectFundingAction: (...args: unknown[]) => rejectFundingAction(...args),
  increaseApprovalAction: vi.fn(),
  provideFundingAction: vi.fn(),
  reportMismatchAction: vi.fn(),
  correctHandoverAction: vi.fn(),
}));

const { FundingActions, RequestFundingForm } = await import("@/app/(app)/imprest/funding-forms");

const PROVIDED: FundingSummary = {
  id: "0b7b0a55-0000-4000-8000-000000000002",
  fundingNo: "FV-IMP-20260921-0001",
  status: "provided",
  version: 3,
  requestedAmount: 50000,
  reason: "Yard float",
  requestedBy: "Manager",
  requestedAt: "2026-09-21T06:00:00.000Z",
  approvedAmount: 50000,
  handoverId: "0b7b0a55-0000-4000-8000-000000000003",
  providedAmount: 50000,
  disputedCounted: null,
  rejectionReason: null,
  receivedAmount: null,
};

const REQUESTED: FundingSummary = {
  ...PROVIDED,
  status: "requested",
  version: 1,
  approvedAmount: null,
  handoverId: null,
  providedAmount: null,
};

const keyOf = (mock: ReturnType<typeof vi.fn>, call: number) =>
  (mock.mock.calls[call][1] as FormData).get("idempotencyKey");

beforeEach(() => {
  requestFundingAction.mockReset();
  confirmReceivedAction.mockReset();
  rejectFundingAction.mockReset();
});

describe("a funding request whose answer was lost", () => {
  it("says the outcome is unknown, then retries with the same key and shows the replayed success", async () => {
    const user = userEvent.setup();
    requestFundingAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    requestFundingAction.mockResolvedValueOnce({ successKey: "imprest.success.requested" });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <RequestFundingForm />
      </NextIntlClientProvider>,
    );
    await user.type(screen.getByLabelText("Amount requested (TZS)"), "50000");
    await user.type(screen.getByLabelText("What the money is for"), "Yard float");
    await user.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByText(en.imprestErrors.unconfirmed)).toBeVisible();
    expect(screen.queryByText(en.common.actionFailed)).toBeNull();
    expect(screen.queryByText(/nothing was changed/i)).toBeNull();
    // What was typed is still there.
    expect(screen.getByLabelText("Amount requested (TZS)")).toHaveValue("50000");

    await user.click(screen.getByRole("button", { name: en.common.retry }));

    expect(await screen.findByRole("status")).toHaveTextContent("Funding request submitted.");
    expect(requestFundingAction).toHaveBeenCalledTimes(2);
    expect(keyOf(requestFundingAction, 1)).toBe(keyOf(requestFundingAction, 0));
  });
});

describe("a receipt confirmation whose answer was lost", () => {
  it.each([
    ["en", en],
    ["sw", sw],
  ] as const)("is reported as unconfirmed, and retried with the same key (%s)", async (locale, messages) => {
    const user = userEvent.setup();
    confirmReceivedAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    confirmReceivedAction.mockResolvedValueOnce({ successKey: "imprest.success.received" });

    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <FundingActions funding={PROVIDED} role="manager" />
      </NextIntlClientProvider>,
    );
    await user.click(screen.getByTestId("confirm-received"));

    expect(await screen.findByText(messages.imprestErrors.unconfirmed)).toBeVisible();
    expect(screen.queryByText(messages.common.actionFailed)).toBeNull();

    await user.click(screen.getByRole("button", { name: messages.common.retry }));
    await waitFor(() => expect(confirmReceivedAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent(messages.imprest.success.received);
    expect(keyOf(confirmReceivedAction, 1)).toBe(keyOf(confirmReceivedAction, 0));
  });
});

/**
 * The guard PR #58 gave the disbursement reason forms, applied to funding. Closing and reopening a
 * form after a lost response must keep the unresolved request and its key: a fresh key would turn a
 * rejection that did commit into a stale-version refusal.
 */
describe("a funding rejection whose answer was lost", () => {
  it("keeps the unresolved request when the reason form is closed and reopened", async () => {
    const user = userEvent.setup();
    rejectFundingAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    rejectFundingAction.mockResolvedValueOnce({ successKey: "imprest.success.rejected" });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <FundingActions funding={REQUESTED} role="director" />
      </NextIntlClientProvider>,
    );
    const toggle = () => screen.getByRole("button", { name: en.imprest.actions.reject });
    await user.click(toggle());
    await user.type(screen.getByLabelText(en.imprest.fields.rejectionReason), "Not this week");
    await user.click(screen.getByRole("button", { name: en.imprest.actions.confirmReject }));
    expect(await screen.findByText(en.imprestErrors.unconfirmed)).toBeVisible();

    // Close the form, then open it again.
    await user.click(toggle());
    await user.click(toggle());

    expect(screen.getByText(en.imprestErrors.unconfirmed)).toBeVisible();
    await user.click(await screen.findByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(rejectFundingAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.success.rejected);
    expect(keyOf(rejectFundingAction, 1)).toBe(keyOf(rejectFundingAction, 0));
  });

  it("does not carry the unresolved rejection into another action", async () => {
    const user = userEvent.setup();
    rejectFundingAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    rejectFundingAction.mockResolvedValueOnce({ successKey: "imprest.success.rejected" });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <FundingActions funding={REQUESTED} role="director" />
      </NextIntlClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: en.imprest.actions.reject }));
    await user.type(screen.getByLabelText(en.imprest.fields.rejectionReason), "Not this week");
    await user.click(screen.getByRole("button", { name: en.imprest.actions.confirmReject }));
    expect(await screen.findByText(en.imprestErrors.unconfirmed)).toBeVisible();

    // Approving now would send the rejection's key, and Try again beside it would replay the
    // rejection. Until Try again finds out, the other action stays closed.
    expect(screen.getByRole("button", { name: en.imprest.actions.approve })).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.success.rejected);
  });
});
