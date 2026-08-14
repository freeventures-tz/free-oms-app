import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * The account-recovery interaction, which hands out the only copy of a credential that exists.
 *
 * Recovery is reached exactly when a creation attempt found the account already present and issued
 * nothing. The Director then asks for a new temporary password — and that password is stored in no
 * table, no job row and no log, so whatever this component does with it is final.
 *
 * Two clicks used to mean two reset commands with two different idempotency keys, which meant two
 * different passwords, the first of which stopped working the moment the second landed.
 */

const resetPasswordAction = vi.fn();
const createAccountAction = vi.fn();

vi.mock("@/app/(app)/admin/accounts/actions", () => ({
  createAccountAction: (...args: unknown[]) => createAccountAction(...args),
  resetPasswordAction: (...args: unknown[]) => resetPasswordAction(...args),
}));

const { CreateAccountForm, keepIssuedCredential } = await import(
  "@/app/(app)/admin/accounts/create-account-form"
);

const EXISTING_USER = "0f6c2a5e-1d3b-4c7a-9e21-8b5d4f0a6c11";

/** Drives the form to the state where recovery is offered: the phone already belongs to someone. */
async function reachRecoveryOffer() {
  const user = userEvent.setup();

  createAccountAction.mockResolvedValue({
    error: "admin.errors.phone_in_use",
    recoverableUserId: EXISTING_USER,
  });

  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CreateAccountForm idempotencyKey="11111111-2222-3333-4444-555555555555" />
    </NextIntlClientProvider>,
  );

  await user.type(screen.getByLabelText(/full name/i), "Asha Mushi");
  await user.type(screen.getByLabelText(/phone number/i), "0712345678");
  await user.click(screen.getByRole("button", { name: /^create account$/i }));

  const recover = await screen.findByRole("button", {
    name: /set a new password for this account/i,
  });
  return { user, recover };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryKeys.length = 0;
});

const recoveryKeys: string[] = [];

describe("account recovery, activated twice in quick succession", () => {
  it("issues at most one reset, and never a second password", async () => {
    const first = deferred<Record<string, unknown>>();

    resetPasswordAction.mockImplementation((_previous: unknown, data: FormData) => {
      recoveryKeys.push(String(data.get("idempotencyKey")));
      return first.promise;
    });

    const { user, recover } = await reachRecoveryOffer();

    await user.click(recover);
    // The control locks while the request is in flight, so the second activation cannot start a
    // second command. This is the first of three independent guards.
    expect(recover).toBeDisabled();
    await user.click(recover);

    expect(resetPasswordAction).toHaveBeenCalledTimes(1);

    first.resolve({ temporaryPassword: "Qm7rTk2pVx9Ldb4Z", temporaryPasswordFor: "Asha Mushi" });
    expect(await screen.findByText("Qm7rTk2pVx9Ldb4Z")).toBeInTheDocument();
  });

  it("reuses one idempotency key, so two requests can only ever resolve to one command", async () => {
    // Proves the guarantee directly rather than through the disabled state: even if two requests
    // DO reach the server, they carry the same key and therefore address the same reset command.
    resetPasswordAction.mockImplementation((_previous: unknown, data: FormData) => {
      recoveryKeys.push(String(data.get("idempotencyKey")));
      return Promise.resolve({ error: "admin.errors.claimed_by_other" });
    });

    const { user, recover } = await reachRecoveryOffer();

    await user.click(recover);
    await waitFor(() => expect(recover).toBeEnabled());
    await user.click(recover);

    expect(recoveryKeys).toHaveLength(2);
    expect(recoveryKeys[0]).toBe(recoveryKeys[1]);
    expect(recoveryKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

});

/**
 * The last guard, tested directly rather than through the button.
 *
 * With the two guards above in place a second reset cannot be in flight, so this rule cannot be
 * reached from the interface — which is exactly why it is worth asserting on its own. It is what
 * holds if either of the others is ever weakened.
 */
describe("keeping an issued credential", () => {
  const issued = { temporaryPassword: "Qm7rTk2pVx9Ldb4Z", temporaryPasswordFor: "Asha Mushi" };

  it("refuses to let a later refusal displace a password already on screen", () => {
    expect(keepIssuedCredential(issued, { error: "admin.errors.already_completed" })).toBe(issued);
    expect(keepIssuedCredential(issued, { error: "admin.errors.claimed_by_other" })).toBe(issued);
    expect(keepIssuedCredential(issued, {})).toBe(issued);
  });

  it("refuses to let a SECOND password displace the first, which is the one already given out", () => {
    const second = { temporaryPassword: "Zz9kLp3mWq7Rtb2X" };
    expect(keepIssuedCredential(issued, second)).toBe(issued);
  });

  it("still shows a refusal when no password has been issued", () => {
    const refusal = { error: "admin.errors.claimed_by_other" };
    expect(keepIssuedCredential({}, refusal)).toBe(refusal);
  });
});
