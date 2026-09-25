import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * Greptile on PR #58. When the answer to a cancel, reject or withdraw never arrives, the outcome is
 * unknown until Try again resends the same request. Closing and reopening the reason form must not
 * throw that request away: a fresh key would turn a committed cancel into a stale-version refusal.
 */

const cancelDisbursementAction = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  cancelDisbursementAction: (...args: unknown[]) => cancelDisbursementAction(...args),
  approveDisbursementAction: vi.fn(),
  rejectDisbursementAction: vi.fn(),
  withdrawDisbursementAction: vi.fn(),
  proposeDisbursementAction: vi.fn(),
  requestFundingAction: vi.fn(),
  confirmReceivedAction: vi.fn(),
  approveFundingAction: vi.fn(),
  rejectFundingAction: vi.fn(),
  increaseApprovalAction: vi.fn(),
  provideFundingAction: vi.fn(),
  reportMismatchAction: vi.fn(),
  correctHandoverAction: vi.fn(),
}));

const { DisbursementActions } = await import("@/app/(app)/imprest/disbursement-forms");

const APPROVED = {
  id: "0b7b0a55-0000-4000-8000-000000000055",
  version: 2,
  status: "approved" as const,
  amount: 9000,
};

const keyOf = (call: number) =>
  (cancelDisbursementAction.mock.calls[call][1] as FormData).get("idempotencyKey");

beforeEach(() => cancelDisbursementAction.mockReset());

describe("a cancel whose answer was lost", () => {
  it("keeps the unresolved request when the reason form is closed and reopened", async () => {
    const user = userEvent.setup();
    cancelDisbursementAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    cancelDisbursementAction.mockResolvedValueOnce({ successKey: "imprest.spending.success.cancelled" });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DisbursementActions disbursement={APPROVED} role="manager" isOwn={false} />
      </NextIntlClientProvider>,
    );
    const toggle = () => screen.getByRole("button", { name: en.imprest.spending.actions.cancel });
    await user.click(toggle());
    await user.type(screen.getByLabelText(en.imprest.spending.fields.cancellationReason), "Welder did not come");
    await user.click(screen.getByRole("button", { name: en.imprest.spending.actions.confirmCancel }));
    expect(await screen.findByText(en.spendingErrors.unconfirmed)).toBeVisible();

    // Close the form, then open it again.
    await user.click(toggle());
    await user.click(toggle());

    expect(screen.getByText(en.spendingErrors.unconfirmed)).toBeVisible();
    await user.click(await screen.findByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(cancelDisbursementAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.spending.success.cancelled);
    expect(keyOf(1)).toBe(keyOf(0));
  });
});
