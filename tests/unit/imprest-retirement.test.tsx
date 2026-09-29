import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { deficitOf } from "@/lib/imprest/retirement";
import { fieldErrors } from "@/lib/validation/auth";
import {
  approveRetirementSchema,
  rejectRetirementSchema,
  submitRetirementSchema,
} from "@/lib/validation/imprest";

/**
 * Issue #72: what the browser checks before a retirement command reaches the database (which checks
 * it all again), the feedback the controls give, the deficit the screens show, and the words.
 */

const submitRetirement = vi.fn();
const approveRetirement = vi.fn();
const rejectRetirement = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  submitRetirementAction: (...args: unknown[]) => submitRetirement(...args),
  approveRetirementAction: (...args: unknown[]) => approveRetirement(...args),
  rejectRetirementAction: (...args: unknown[]) => rejectRetirement(...args),
}));

const { RetirementActions } = await import("@/app/(app)/imprest/retirement-forms");

// Elements, not wrapper components: a rerender must meet the same component to keep its state.
const submitting = (countId: string) => <RetirementActions submit={{ countId }} decide={null} />;
const deciding = (retirement: { id: string; version: number }) => (
  <RetirementActions submit={null} decide={retirement} />
);

const COUNT = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const RETIREMENT = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

describe("the submission input", () => {
  it("names the closing count and carries a tidied reason", () => {
    const parsed = submitRetirementSchema.safeParse({ countId: COUNT, reason: "  Month   end ", idempotencyKey: KEY });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ countId: COUNT, reason: "Month end" });
  });

  it("refuses a reason under 3 or over 500 characters, and a missing count", () => {
    for (const reason of ["", "no", "x".repeat(501)]) {
      const parsed = submitRetirementSchema.safeParse({ countId: COUNT, reason, idempotencyKey: KEY });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(fieldErrors(parsed.error).reason).toBe("retirementErrors.reason_required");
    }
    const noCount = submitRetirementSchema.safeParse({ countId: "", reason: "Month end", idempotencyKey: KEY });
    expect(noCount.success).toBe(false);
    if (!noCount.success) expect(fieldErrors(noCount.error).countId).toBe("retirementErrors.count_required");
  });
});

describe("the decision inputs", () => {
  const base = { retirementId: RETIREMENT, expectedVersion: "2", idempotencyKey: KEY };

  it("approve names the retirement and its version, and nothing else", () => {
    const parsed = approveRetirementSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.expectedVersion).toBe(2);
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(["expectedVersion", "idempotencyKey", "retirementId"]);
  });

  it("reject needs a reason", () => {
    expect(rejectRetirementSchema.safeParse({ ...base, reason: "no" }).success).toBe(false);
    expect(rejectRetirementSchema.safeParse({ ...base, reason: "Count again with me" }).success).toBe(true);
  });
});

describe("the deficit", () => {
  it("is every unexplained loss and count shortage in full, never netted by an excess", () => {
    const losses = [{ postingId: "a", disbursementId: "d", disbursementNo: "FV-DSB-1", amount: 3000 }];
    const shortages = [
      { countId: "c1", businessDate: "2026-09-28", amount: 1000 },
      { countId: "c2", businessDate: "2026-09-29", amount: 1000 },
    ];
    expect(deficitOf({ losses, shortages })).toBe(5000);
    expect(deficitOf({ losses: [], shortages: [] })).toBe(0);
  });
});

const intl = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  submitRetirement.mockReset();
  approveRetirement.mockReset();
  rejectRetirement.mockReset();
});

describe("submitting", () => {
  it("sends the closing count and the reason under one key, then shows the answer", async () => {
    const user = userEvent.setup();
    submitRetirement.mockResolvedValue({ successKey: "imprest.retirement.success.submitted" });
    const { rerender } = render(intl(submitting(COUNT)));

    await user.type(screen.getByLabelText(en.imprest.retirement.reason), "Month end");
    await user.click(screen.getByRole("button", { name: en.imprest.retirement.submit }));

    await waitFor(() => expect(submitRetirement).toHaveBeenCalledTimes(1));
    const data = submitRetirement.mock.calls[0][1] as FormData;
    expect(data.get("countId")).toBe(COUNT);
    expect(data.get("reason")).toBe("Month end");
    expect(data.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.retirement.success.submitted);

    // The page refreshes into the submitted state, which has no form: the answer stays.
    rerender(intl(<RetirementActions submit={null} decide={null} />));
    expect(screen.getByRole("status")).toHaveTextContent(en.imprest.retirement.success.submitted);
    expect(screen.queryByRole("button", { name: en.imprest.retirement.submit })).toBeNull();
  });

  it("names every blocker when refused, and keeps what was typed", async () => {
    const user = userEvent.setup();
    submitRetirement.mockResolvedValue({
      error: "retirementErrors.blocked",
      errorValues: { blockers: "FV-DSB-20260929-0004, FV-IMP-20260929-0002" },
    });
    render(intl(submitting(COUNT)));
    await user.type(screen.getByLabelText(en.imprest.retirement.reason), "Month end");
    await user.click(screen.getByRole("button", { name: en.imprest.retirement.submit }));
    expect(await screen.findByText(/FV-DSB-20260929-0004, FV-IMP-20260929-0002/)).toBeInTheDocument();
    expect(screen.getByLabelText(en.imprest.retirement.reason)).toHaveValue("Month end");
  });
});

describe("a Director's decision", () => {
  const retirement = { id: RETIREMENT, version: 1 };

  it("asks once more before the irreversible approval, then sends the version", async () => {
    const user = userEvent.setup();
    approveRetirement.mockResolvedValue({ successKey: "imprest.retirement.success.approved" });
    const { rerender } = render(intl(deciding(retirement)));

    await user.click(screen.getByTestId("approve-retirement"));
    expect(approveRetirement).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-retirement-form")).toHaveTextContent(en.imprest.retirement.confirmHelp);

    await user.click(screen.getByTestId("confirm-retirement"));
    await waitFor(() => expect(approveRetirement).toHaveBeenCalledTimes(1));
    const data = approveRetirement.mock.calls[0][1] as FormData;
    expect(data.get("retirementId")).toBe(RETIREMENT);
    expect(data.get("expectedVersion")).toBe("1");
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.retirement.success.approved);

    // The page refreshes into the next fund, with nothing to decide: the answer stays.
    rerender(intl(<RetirementActions submit={null} decide={null} />));
    expect(screen.getByRole("status")).toHaveTextContent(en.imprest.retirement.success.approved);
    expect(screen.queryByTestId("approve-retirement")).toBeNull();
  });

  it("keeps a lost approval on its own key: only Try again, never a rejection under it", async () => {
    const user = userEvent.setup();
    approveRetirement.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({
      successKey: "imprest.retirement.success.approved",
    });
    render(intl(deciding(retirement)));

    await user.click(screen.getByTestId("approve-retirement"));
    await user.click(screen.getByTestId("confirm-retirement"));
    expect(await screen.findByText(en.retirementErrors.unconfirmed)).toBeInTheDocument();
    expect(screen.getByTestId("reject-retirement-toggle")).toBeDisabled();
    expect(screen.getByTestId("approve-retirement")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(approveRetirement).toHaveBeenCalledTimes(2));
    const first = approveRetirement.mock.calls[0][1] as FormData;
    const second = approveRetirement.mock.calls[1][1] as FormData;
    expect(second.get("idempotencyKey")).toBe(first.get("idempotencyKey"));
    expect(rejectRetirement).not.toHaveBeenCalled();
  });

  it("rejects with a reason", async () => {
    const user = userEvent.setup();
    rejectRetirement.mockResolvedValue({ successKey: "imprest.retirement.success.rejected" });
    render(intl(deciding(retirement)));
    await user.click(screen.getByTestId("reject-retirement-toggle"));
    await user.type(screen.getByLabelText(en.imprest.retirement.rejectReason), "Count again with me");
    await user.click(screen.getByRole("button", { name: en.imprest.retirement.rejectConfirm }));
    await waitFor(() => expect(rejectRetirement).toHaveBeenCalledTimes(1));
    expect((rejectRetirement.mock.calls[0][1] as FormData).get("reason")).toBe("Count again with me");
  });
});

describe("the words", () => {
  it("has every retirement message in English and Swahili, in plain words", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(sw.imprest.retirement)).toEqual(keys(en.imprest.retirement));
    expect(keys(sw.imprest.fundRecord)).toEqual(keys(en.imprest.fundRecord));
    expect(keys(sw.retirementErrors)).toEqual(keys(en.retirementErrors));
    expect(JSON.stringify([en.imprest.retirement, en.imprest.fundRecord, en.retirementErrors])).not.toMatch(
      /encumb/i,
    );
  });
});
