import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * The account row, activated more than once.
 *
 * Every control here moves an account: a new password, a deactivation, a role, a login identifier.
 * A second activation that reaches the server is not a cosmetic problem — one double-click on the
 * recovery control once issued two temporary passwords, the first of which had already been handed
 * over and stopped working (memory.md §6). These are the row's own guards, tested where they live.
 */

const resetPasswordAction = vi.fn();
const setActiveAction = vi.fn();
const changeRoleAction = vi.fn();
const changePhoneAction = vi.fn();

vi.mock("@/app/(app)/admin/accounts/actions", () => ({
  resetPasswordAction: (...args: unknown[]) => resetPasswordAction(...args),
  setActiveAction: (...args: unknown[]) => setActiveAction(...args),
  changeRoleAction: (...args: unknown[]) => changeRoleAction(...args),
  changePhoneAction: (...args: unknown[]) => changePhoneAction(...args),
}));

const { AccountsList } = await import("@/app/(app)/admin/accounts/accounts-list");

const ACCOUNT = {
  id: "0f6c2a5e-1d3b-4c7a-9e21-8b5d4f0a6c11",
  fullName: "Asha Mushi",
  phoneE164: "+255712345678",
  role: "cashier" as const,
  isActive: true,
  mustChangePassword: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openRowActions() {
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AccountsList accounts={[ACCOUNT]} currentUserId="99999999-9999-9999-9999-999999999999" />
    </NextIntlClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: /^actions$/i }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a row action activated repeatedly", () => {
  it("reaches the server exactly once, however many times it is pressed", async () => {
    const inFlight = deferred<Record<string, unknown>>();
    resetPasswordAction.mockImplementation(() => inFlight.promise);

    await openRowActions();
    const reset = screen.getByRole("button", { name: /set a new password/i });

    // Dispatched natively and synchronously, so all five land in the SAME tick — before React has
    // had any chance to commit a pending state. This is the window the disabled attribute alone
    // does not cover, and the reason the row also holds a ref latch.
    for (let i = 0; i < 5; i++) reset.click();

    await waitFor(() => expect(reset).toBeDisabled());
    expect(resetPasswordAction).toHaveBeenCalledTimes(1);

    inFlight.resolve({ temporaryPassword: "Qm7rTk2pVx9Ldb4Z" });
    expect(await screen.findByText("Qm7rTk2pVx9Ldb4Z")).toBeInTheDocument();
  });

  it("shows the pending state on the control that was pressed, not on the whole row", async () => {
    const inFlight = deferred<Record<string, unknown>>();
    resetPasswordAction.mockImplementation(() => inFlight.promise);

    await openRowActions();
    const reset = screen.getByRole("button", { name: /set a new password/i });
    const deactivate = screen.getByRole("button", { name: /^switch off$/i });

    reset.click();

    await waitFor(() => expect(reset).toHaveAttribute("aria-busy", "true"));
    // The others are locked because work is in flight, but they are not claiming to be working.
    expect(deactivate).toBeDisabled();
    expect(deactivate).not.toHaveAttribute("aria-busy");

    // Settled before the test ends: React holds a transition open for as long as its promise is
    // unresolved, and leaving one dangling makes the NEXT test's controls look pending.
    inFlight.resolve({ error: "admin.errors.generic" });
    await waitFor(() => expect(reset).toBeEnabled());
  });
});

describe("a row action that the server refuses", () => {
  it("offers a retry that addresses the SAME command rather than starting a second one", async () => {
    const keys: string[] = [];
    resetPasswordAction.mockImplementation((_previous: unknown, data: FormData) => {
      keys.push(String(data.get("idempotencyKey")));
      return Promise.resolve({ error: "admin.errors.generic" });
    });

    const user = await openRowActions();
    await user.click(screen.getByRole("button", { name: /set a new password/i }));

    // The refusal is inline on this record, and it is paired with a way forward (§12.5).
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: /try again/i });

    // Still locked for the instant the transition takes to settle — the guard releasing itself,
    // which is exactly what it should do rather than needing a reload.
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    await waitFor(() => expect(resetPasswordAction).toHaveBeenCalledTimes(2));
    // Same key both times: two requests can only ever resolve to one reset command.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("never claims success the server did not give", async () => {
    resetPasswordAction.mockResolvedValue({ error: "admin.errors.not_permitted" });

    const user = await openRowActions();
    await user.click(screen.getByRole("button", { name: /set a new password/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // No credential, and no success line, on a request that was refused (§12.7 rule 5).
    expect(screen.queryByText(/temporary password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/updated/i)).not.toBeInTheDocument();
  });
});
