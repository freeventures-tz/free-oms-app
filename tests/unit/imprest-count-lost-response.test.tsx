import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * Greptile on PR #74. When the Manager's confirmation gets no answer it may already have committed,
 * and only Try again, resending the same request under the same key, can find out. Opening Send
 * back meanwhile would send a different command under that key and hide the answer, so it stays
 * closed until the outcome is known.
 */

const confirmCountAction = vi.fn();
const sendBackCountAction = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  confirmCountAction: (...args: unknown[]) => confirmCountAction(...args),
  sendBackCountAction: (...args: unknown[]) => sendBackCountAction(...args),
  enterCountAction: vi.fn(),
  enterLateCountAction: vi.fn(),
}));

const { CountControls } = await import("@/app/(app)/imprest/count-forms");

const WAITING = {
  id: "0b7b0a55-0000-4000-8000-000000000010",
  version: 1,
  expected: 150000,
  counted: 149000,
  variance: -1000,
};

const keyOf = (mock: ReturnType<typeof vi.fn>, call: number) =>
  (mock.mock.calls[call][1] as FormData).get("idempotencyKey");

beforeEach(() => {
  confirmCountAction.mockReset();
  sendBackCountAction.mockReset();
});

describe("a confirmation whose answer was lost", () => {
  it("keeps Send back closed, and Try again resends the same confirmation", async () => {
    const user = userEvent.setup();
    confirmCountAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    confirmCountAction.mockResolvedValueOnce({ successKey: "imprest.count.success.confirmed" });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <CountControls role="manager" businessDate="2026-09-28" mayCount={false} replaces={null} waiting={WAITING} />
      </NextIntlClientProvider>,
    );

    await user.click(screen.getByText("Counting error"));
    await user.click(screen.getByRole("button", { name: "Confirm shortage of TZS 1,000" }));

    expect(await screen.findByText(en.countErrors.unconfirmed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send back" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(confirmCountAction).toHaveBeenCalledTimes(2));
    expect(keyOf(confirmCountAction, 1)).toBe(keyOf(confirmCountAction, 0));
    expect(await screen.findByText(en.imprest.count.success.confirmed)).toBeInTheDocument();
    expect(sendBackCountAction).not.toHaveBeenCalled();
  });

  it("keeps Confirm closed after a send-back whose answer was lost", async () => {
    const user = userEvent.setup();
    sendBackCountAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <CountControls role="manager" businessDate="2026-09-28" mayCount={false} replaces={null} waiting={WAITING} />
      </NextIntlClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Send back" }));
    await user.type(screen.getByLabelText("What the Cashier should check"), "Count the coins again");
    await user.click(screen.getByRole("button", { name: "Send back for a recount" }));

    expect(await screen.findByText(en.countErrors.unconfirmed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm shortage of TZS 1,000" })).toBeDisabled();
    expect(confirmCountAction).not.toHaveBeenCalled();
  });
});
