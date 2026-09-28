import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * Issue #69. A late count moves its day from Not counted to Awaiting Manager confirmation, and the
 * page refreshes with the day in its new state. The Cashier must still read the server's answer
 * then, so the control stays mounted and keeps it; and a reason is required before anything is sent.
 */

const enterLateCountAction = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  confirmCountAction: vi.fn(),
  sendBackCountAction: vi.fn(),
  enterCountAction: vi.fn(),
  enterLateCountAction: (...args: unknown[]) => enterLateCountAction(...args),
}));

const { LateCountControl } = await import("@/app/(app)/imprest/count-forms");

const DAY = "2026-09-25";
const view = (mayOpen: boolean) => (
  <NextIntlClientProvider locale="en" messages={en}>
    <LateCountControl businessDate={DAY} dateLabel="Friday, 25 September 2026" mayOpen={mayOpen} replaces={null} />
  </NextIntlClientProvider>
);

beforeEach(() => enterLateCountAction.mockReset());

describe("a late count", () => {
  it("sends the day, the cash and the reason, and keeps the answer once the day is no longer Not counted", async () => {
    const user = userEvent.setup();
    enterLateCountAction.mockResolvedValueOnce({ successKey: "imprest.count.success.countedLate" });
    const { rerender } = render(view(true));

    await user.click(screen.getByRole("button", { name: "Count Friday, 25 September 2026 late" }));
    await user.type(screen.getByLabelText("Why this day wasn't counted"), "Cashier was off sick");
    await user.type(screen.getByLabelText("Cash in the tin"), "149500");
    await user.click(screen.getByRole("button", { name: "Enter late count" }));

    await waitFor(() => expect(enterLateCountAction).toHaveBeenCalledTimes(1));
    const sent = enterLateCountAction.mock.calls[0][1] as FormData;
    expect(sent.get("businessDate")).toBe(DAY);
    expect(sent.get("lateReason")).toBe("Cashier was off sick");
    expect(sent.get("counted")).toBe("149500");
    expect(await screen.findByText(en.imprest.count.success.countedLate)).toBeInTheDocument();

    // The refresh arrives: the day now waits for the Manager.
    rerender(view(false));
    expect(screen.getByText(en.imprest.count.success.countedLate)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /late$/ })).toBeNull();
  });

  it("offers nothing on a day that cannot be counted late now", () => {
    const { container } = render(view(false));
    expect(container).toBeEmptyDOMElement();
  });
});
