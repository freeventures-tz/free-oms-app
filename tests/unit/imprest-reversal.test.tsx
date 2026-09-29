import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { fieldErrors } from "@/lib/validation/auth";
import {
  approveReversalSchema,
  rejectReversalSchema,
  requestReversalSchema,
} from "@/lib/validation/imprest";

/**
 * Issue #71: what the browser checks before a reversal command reaches the database (which checks
 * it all again), the feedback the controls give, and the words the screens use.
 */

const requestReversal = vi.fn();
const approveReversal = vi.fn();
const rejectReversal = vi.fn();

vi.mock("@/app/(app)/imprest/actions", () => ({
  requestReversalAction: (...args: unknown[]) => requestReversal(...args),
  approveReversalAction: (...args: unknown[]) => approveReversal(...args),
  rejectReversalAction: (...args: unknown[]) => rejectReversal(...args),
}));

const { DecideReversal, RequestReversal } = await import("@/app/(app)/imprest/reversal-forms");

const POSTING = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const REVERSAL = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

describe("the request input", () => {
  const request = (overrides: Record<string, unknown> = {}) =>
    requestReversalSchema.safeParse({
      postingId: POSTING,
      correct: "45,000",
      reason: "  Receipt   shows 45,000 ",
      idempotencyKey: KEY,
      ...overrides,
    });

  it("carries the correct amount in whole shillings and a tidied reason", () => {
    const parsed = request();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ correct: 45000, reason: "Receipt shows 45,000" });
  });

  it("accepts 0, which undoes the posting", () => {
    expect(request({ correct: "0" }).data?.correct).toBe(0);
  });

  it("refuses a negative, a fraction, words and nothing", () => {
    for (const correct of ["-5", "1500.5", "lots", ""]) {
      const parsed = request({ correct });
      expect(parsed.success, `correct ${correct}`).toBe(false);
      if (!parsed.success) expect(fieldErrors(parsed.error).correct).toMatch(/^reversalErrors\./);
    }
  });

  it("refuses a reason under 3 or over 500 characters", () => {
    for (const reason of ["", "no", "x".repeat(501)]) {
      const parsed = request({ reason });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(fieldErrors(parsed.error).reason).toBe("reversalErrors.reason_required");
    }
  });
});

describe("the decision inputs", () => {
  const base = { reversalId: REVERSAL, expectedVersion: "1", idempotencyKey: KEY };

  it("approve names the request and its version, and carries no amount", () => {
    const parsed = approveReversalSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.expectedVersion).toBe(1);
    expect(Object.keys(parsed.data ?? {}).some((k) => /amount|correct|tzs/.test(k))).toBe(false);
    const bad = approveReversalSchema.safeParse({ ...base, reversalId: "nope" });
    if (!bad.success) expect(fieldErrors(bad.error).reversalId).toBe("reversalErrors.no_reversal");
    expect(bad.success).toBe(false);
  });

  it("reject needs a reason", () => {
    expect(rejectReversalSchema.safeParse({ ...base, reason: "no" }).success).toBe(false);
    expect(rejectReversalSchema.safeParse({ ...base, reason: "Not enough cash" }).success).toBe(true);
  });
});

const intl = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  requestReversal.mockReset();
  approveReversal.mockReset();
  rejectReversal.mockReset();
});

describe("asking for a reversal", () => {
  it("sends the posting, the correct amount and the reason under one key, and keeps the answer", async () => {
    const user = userEvent.setup();
    requestReversal.mockResolvedValue({ successKey: "imprest.reversal.success.requested" });
    const { rerender } = render(intl(<RequestReversal postingId={POSTING} waiting={false} />));

    await user.click(screen.getByTestId("request-reversal-toggle"));
    await user.type(screen.getByLabelText(en.imprest.reversal.correct), "0");
    await user.type(screen.getByLabelText(en.imprest.reversal.reason), "The cash was in the safe");
    await user.click(screen.getByRole("button", { name: en.imprest.reversal.submit }));

    await waitFor(() => expect(requestReversal).toHaveBeenCalledTimes(1));
    const data = requestReversal.mock.calls[0][1] as FormData;
    expect(data.get("postingId")).toBe(POSTING);
    expect(data.get("correct")).toBe("0");
    expect(data.get("reason")).toBe("The cash was in the safe");
    expect(data.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/);

    // The page refreshes with the request waiting: the confirmation stays beside the wait.
    rerender(intl(<RequestReversal postingId={POSTING} waiting />));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.reversal.success.requested);
    expect(screen.getByTestId("reversal-waiting")).toHaveTextContent(en.imprest.reversal.waiting);
    expect(screen.queryByTestId("request-reversal-toggle")).toBeNull();
  });

  it("keeps what was typed when the database refuses", async () => {
    const user = userEvent.setup();
    requestReversal.mockResolvedValue({ error: "reversalErrors.reversal_open" });
    render(intl(<RequestReversal postingId={POSTING} waiting={false} />));
    await user.click(screen.getByTestId("request-reversal-toggle"));
    await user.type(screen.getByLabelText(en.imprest.reversal.correct), "45000");
    await user.type(screen.getByLabelText(en.imprest.reversal.reason), "Receipt shows less");
    await user.click(screen.getByRole("button", { name: en.imprest.reversal.submit }));
    expect(await screen.findByText(en.reversalErrors.reversal_open)).toBeInTheDocument();
    expect(screen.getByLabelText(en.imprest.reversal.correct)).toHaveValue("45000");
  });
});

describe("a Director's decision", () => {
  const reversal = { id: REVERSAL, version: 1, original: 47000, correct: 45000 };

  it("says what will be posted and where the balance lands, then sends no amount", async () => {
    const user = userEvent.setup();
    approveReversal.mockResolvedValue({ successKey: "imprest.reversal.success.approved" });
    const { rerender } = render(
      intl(<DecideReversal reversal={reversal} open postedBalance={150000} freeToApprove={140000} />),
    );
    const help = screen.getByTestId("approve-reversal-form");
    expect(help).toHaveTextContent("47,000");
    expect(help).toHaveTextContent("a replacement of TZS 45,000");
    expect(help).toHaveTextContent("150,000 to TZS 152,000");

    await user.click(screen.getByTestId("approve-reversal"));
    await waitFor(() => expect(approveReversal).toHaveBeenCalledTimes(1));
    const data = approveReversal.mock.calls[0][1] as FormData;
    expect(data.get("reversalId")).toBe(REVERSAL);
    expect(data.get("expectedVersion")).toBe("1");
    expect([...data.keys()].some((k) => /amount|correct/.test(k))).toBe(false);

    // Decided: the controls go and the confirmation stays.
    rerender(intl(<DecideReversal reversal={reversal} open={false} postedBalance={null} freeToApprove={null} />));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.reversal.success.approved);
    expect(screen.queryByTestId("approve-reversal")).toBeNull();
  });

  it("keeps a lost approval on its own key: only Try again, never a rejection under it", async () => {
    const user = userEvent.setup();
    approveReversal.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({
      successKey: "imprest.reversal.success.approved",
    });
    render(intl(<DecideReversal reversal={reversal} open postedBalance={150000} freeToApprove={140000} />));

    await user.click(screen.getByTestId("approve-reversal"));
    expect(await screen.findByText(en.reversalErrors.unconfirmed)).toBeInTheDocument();
    expect(screen.getByTestId("reject-reversal-toggle")).toBeDisabled();
    expect(screen.getByTestId("approve-reversal")).toBeDisabled();
    expect(rejectReversal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: en.common.retry }));
    await waitFor(() => expect(approveReversal).toHaveBeenCalledTimes(2));
    const first = approveReversal.mock.calls[0][1] as FormData;
    const second = approveReversal.mock.calls[1][1] as FormData;
    expect(second.get("idempotencyKey")).toBe(first.get("idempotencyKey"));
    expect(await screen.findByRole("status")).toHaveTextContent(en.imprest.reversal.success.approved);
  });

  it("names a pure undo as having no replacement", () => {
    render(
      intl(
        <DecideReversal reversal={{ ...reversal, correct: 0 }} open postedBalance={150000} freeToApprove={0} />,
      ),
    );
    expect(screen.getByTestId("approve-reversal-form")).toHaveTextContent(en.imprest.reversal.noReplacement);
  });

  it("rejects with a reason", async () => {
    const user = userEvent.setup();
    rejectReversal.mockResolvedValue({ successKey: "imprest.reversal.success.rejected" });
    render(intl(<DecideReversal reversal={reversal} open postedBalance={150000} freeToApprove={140000} />));
    await user.click(screen.getByTestId("reject-reversal-toggle"));
    await user.type(screen.getByLabelText(en.imprest.reversal.rejectReason), "Not enough cash");
    await user.click(screen.getByRole("button", { name: en.imprest.reversal.rejectConfirm }));
    await waitFor(() => expect(rejectReversal).toHaveBeenCalledTimes(1));
    expect((rejectReversal.mock.calls[0][1] as FormData).get("reason")).toBe("Not enough cash");
  });

  it("shows nothing for a decided request this viewer did not decide", () => {
    const { container } = render(
      intl(<DecideReversal reversal={reversal} open={false} postedBalance={null} freeToApprove={null} />),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the words", () => {
  it("has every reversal message in English and Swahili", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(sw.imprest.reversal)).toEqual(keys(en.imprest.reversal));
    expect(keys(sw.reversalErrors)).toEqual(keys(en.reversalErrors));
    expect(en.imprest.reversal.help).not.toMatch(/encumb/i);
  });
});
