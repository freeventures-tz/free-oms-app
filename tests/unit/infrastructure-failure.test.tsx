import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import { DATA_UNAVAILABLE, requireRows, requireText } from "@/lib/supabase/query";

/**
 * What happens when the system itself fails, rather than refusing.
 *
 * design.md §12.5 names three kinds of error and they need different remedies: a validation error
 * beside its field, an operation failure on the affected record, and system unavailability at page
 * level. The first two were covered. This file covers the third, and the case that produces it:
 * a request that never reaches a verdict at all.
 *
 * The distinction that matters most here is between "there is nothing" and "we could not find out".
 * A Director shown an empty account list during an outage has been told something false about their
 * own business.
 */

const resetPasswordAction = vi.fn();
const setActiveAction = vi.fn();
const changeRoleAction = vi.fn();
const changePhoneAction = vi.fn();
const createAccountAction = vi.fn();

vi.mock("@/app/(app)/admin/accounts/actions", () => ({
  createAccountAction: (...args: unknown[]) => createAccountAction(...args),
  resetPasswordAction: (...args: unknown[]) => resetPasswordAction(...args),
  setActiveAction: (...args: unknown[]) => setActiveAction(...args),
  changeRoleAction: (...args: unknown[]) => changeRoleAction(...args),
  changePhoneAction: (...args: unknown[]) => changePhoneAction(...args),
}));

const { AccountsList } = await import("@/app/(app)/admin/accounts/accounts-list");
const { CreateAccountForm } = await import("@/app/(app)/admin/accounts/create-account-form");
const { default: AppError } = await import("@/app/(app)/error");

const ACCOUNT = {
  id: "0f6c2a5e-1d3b-4c7a-9e21-8b5d4f0a6c11",
  fullName: "Asha Mushi",
  phoneE164: "+255712345678",
  role: "cashier" as const,
  isActive: true,
  mustChangePassword: false,
};

function inEnglish(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a row action whose request never reaches a verdict", () => {
  it("does not crash, and says plainly that it failed", async () => {
    resetPasswordAction.mockRejectedValue(new Error("network"));

    const user = userEvent.setup();
    inEnglish(<AccountsList accounts={[ACCOUNT]} currentUserId="someone-else" />);
    await user.click(screen.getByRole("button", { name: /^actions$/i }));
    await user.click(screen.getByRole("button", { name: /set a new password/i }));

    // Not a blank screen, not a stuck spinner, and not a false success.
    expect(await screen.findByRole("alert")).toHaveTextContent(/that did not work/i);
    expect(screen.queryByText(/temporary password/i)).not.toBeInTheDocument();
  });

  it("releases the control and keeps the retry offered", async () => {
    changeRoleAction.mockRejectedValue(new Error("network"));

    const user = userEvent.setup();
    inEnglish(<AccountsList accounts={[ACCOUNT]} currentUserId="someone-else" />);
    await user.click(screen.getByRole("button", { name: /^actions$/i }));
    await user.selectOptions(screen.getByLabelText(/change role/i), "manager");
    await user.click(screen.getByRole("button", { name: /^change role$/i }));

    const retry = await screen.findByRole("button", { name: /try again/i });
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("preserves what was typed, and retries the SAME command", async () => {
    const keys: string[] = [];
    changePhoneAction.mockImplementation((_previous: unknown, data: FormData) => {
      keys.push(String(data.get("idempotencyKey")));
      return Promise.reject(new Error("network"));
    });

    const user = userEvent.setup();
    inEnglish(<AccountsList accounts={[ACCOUNT]} currentUserId="someone-else" />);
    await user.click(screen.getByRole("button", { name: /^actions$/i }));

    const field = screen.getByLabelText(/change phone number/i);
    await user.type(field, "0765432109");
    await user.click(screen.getByRole("button", { name: /^change phone number$/i }));

    const retry = await screen.findByRole("button", { name: /try again/i });
    // The number is still in the field — a failure must not make someone type it again.
    expect(field).toHaveValue("0765432109");

    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    // Same key both times, so a request that DID reach the server before the connection dropped is
    // resumed rather than duplicated.
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("account creation whose request never reaches a verdict", () => {
  it("reports the failure inline and keeps every detail that was typed", async () => {
    createAccountAction.mockRejectedValue(new Error("network"));

    const user = userEvent.setup();
    inEnglish(<CreateAccountForm idempotencyKey="11111111-2222-3333-4444-555555555555" />);

    await user.type(screen.getByLabelText(/full name/i), "Asha Mushi");
    await user.type(screen.getByLabelText(/phone number/i), "0712345678");
    await user.selectOptions(screen.getByLabelText(/^role$/i), "manager");
    await user.click(screen.getByRole("button", { name: /^create account$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/that did not work/i);
    expect(screen.queryByText(/temporary password/i)).not.toBeInTheDocument();

    // React clears an uncontrolled field once a form action completes — including when it completes
    // with a failure. Nothing here may be lost, or the Director types it all again.
    expect(screen.getByLabelText(/full name/i)).toHaveValue("Asha Mushi");
    expect(screen.getByLabelText(/phone number/i)).toHaveValue("0712345678");
    expect(screen.getByLabelText(/^role$/i)).toHaveValue("manager");

    // And the form is usable again, not stuck pending.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^create account$/i })).toBeEnabled(),
    );
  });
});

describe("account recovery whose request never reaches a verdict", () => {
  it("reports the failure and leaves the recovery offered", async () => {
    createAccountAction.mockResolvedValue({
      error: "admin.errors.phone_in_use",
      recoverableUserId: ACCOUNT.id,
    });
    resetPasswordAction.mockRejectedValue(new Error("network"));

    const user = userEvent.setup();
    inEnglish(<CreateAccountForm idempotencyKey="11111111-2222-3333-4444-555555555555" />);

    await user.type(screen.getByLabelText(/full name/i), "Asha Mushi");
    await user.type(screen.getByLabelText(/phone number/i), "0712345678");
    await user.click(screen.getByRole("button", { name: /^create account$/i }));

    const recover = await screen.findByRole("button", {
      name: /set a new password for this account/i,
    });
    await user.click(recover);

    await waitFor(() => expect(recover).toBeEnabled());
    expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(
      /that did not work/i,
    );
    expect(screen.queryByText(/temporary password/i)).not.toBeInTheDocument();
  });
});

describe("a route whose data could not be read", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => consoleError.mockClear());

  it("refuses to pass a failed read off as an empty list", () => {
    expect(() =>
      requireRows({ data: null, error: { message: 'relation "profiles" does not exist' } }, "x"),
    ).toThrow(DATA_UNAVAILABLE);
  });

  it("keeps the provider's own words out of the thrown error, and in the log", () => {
    const leaky = 'permission denied for table profiles: user "sb_x" at 10.0.0.4';
    let thrown: unknown;
    try {
      requireRows({ data: null, error: { message: leaky } }, "admin.accounts.profiles");
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).not.toContain(leaky);
    expect(String(thrown)).toContain("admin.accounts.profiles");
    // Still diagnosable — the detail goes to the server log, which is the one place it belongs.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(leaky));
  });

  it("still treats a genuinely empty result as empty", () => {
    expect(requireRows({ data: [], error: null }, "x")).toEqual([]);
    expect(requireRows({ data: null, error: null }, "x")).toEqual([]);
  });

  it("refuses a scalar the caller has already established must exist", () => {
    // `requireRows` has an empty answer to return, because "no orders yet" is a real state. A
    // single value the caller only asks for once it knows the record is there has none: a null, a
    // blank or the wrong type all mean the read did not work.
    expect(() => requireText({ data: null, error: null }, "sales.order_creator")).toThrow(
      `${DATA_UNAVAILABLE}: sales.order_creator`,
    );
    expect(() => requireText({ data: "", error: null }, "sales.order_creator")).toThrow(
      DATA_UNAVAILABLE,
    );
    expect(() => requireText({ data: "   ", error: null }, "sales.order_creator")).toThrow(
      DATA_UNAVAILABLE,
    );
    expect(() => requireText({ data: 42, error: null }, "sales.order_creator")).toThrow(
      DATA_UNAVAILABLE,
    );

    expect(requireText({ data: "Asha Mushi", error: null }, "sales.order_creator")).toBe(
      "Asha Mushi",
    );
  });

  it("keeps a scalar's provider message and its unusable value out of the thrown error", () => {
    const leaky = 'permission denied for function: user "sb_x" at 10.0.0.4';
    expect(() => requireText({ data: null, error: { message: leaky } }, "sales.order_creator"))
      .toThrow(DATA_UNAVAILABLE);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(leaky));

    consoleError.mockClear();

    expect(() => requireText({ data: { secret: "0712345678" }, error: null }, "sales.order_creator"))
      .toThrow(DATA_UNAVAILABLE);
    // The SHAPE is what a log needs; the value could be anything, so it is never written down.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("where text was expected"));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("0712345678"));
  });

  it("hands the boundary the same failure shape whichever read failed", () => {
    // The page-level state below is reached by a thrown Error, not by a special one. Both helpers
    // therefore throw the same marker, so a new read cannot arrive at that boundary with a message
    // the route has no state for.
    const shapes = [
      () => requireRows({ data: null, error: { message: "x" } }, "sales.order_lines"),
      () => requireText({ data: null, error: null }, "sales.order_creator"),
    ];
    for (const shape of shapes) {
      expect(shape).toThrow(new RegExp(`^${DATA_UNAVAILABLE}: sales\\.`));
    }
  });

  it("shows a page-level state with a retry that re-fetches the route", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();

    inEnglish(<AppError error={Object.assign(new Error("boom"), { digest: "abc123" })} retry={retry} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/could not be loaded/i);
    // Says what a person actually needs to know: nothing was lost and nothing was changed.
    expect(screen.getByRole("alert")).toHaveTextContent(/nothing you did was lost/i);
    // The underlying error is never put on the screen; only the log handle is.
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders that state entirely in Swahili", async () => {
    const sw = (await import("@/messages/sw.json")).default;
    render(
      <NextIntlClientProvider locale="sw" messages={sw}>
        <AppError error={new Error("boom")} retry={vi.fn()} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Ukurasa huu haukuweza kupakiwa",
    );
    expect(screen.getByRole("button", { name: "Jaribu tena" })).toBeInTheDocument();
  });
});
