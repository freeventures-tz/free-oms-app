import { expect, test } from "@playwright/test";

import {
  changePasswordOutOfBand,
  enterPhone,
  expectLandsOn,
  fixtures,
  gatedCrashFor,
  gatedFor,
  signIn,
  submitPassword,
} from "./fixtures";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";

/**
 * Runs on all three device tiers (see playwright.config.ts). Authentication is the one journey every
 * member of staff makes on whatever device they have, so "it works on desktop" is not an answer.
 */

test.describe("sign-in", () => {
  test("offers phone and password only — no signup, no OTP, no self-service reset", async ({
    page,
  }) => {
    await page.goto("/sign-in");

    await expect(page.getByLabel(/phone number/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^continue$/i })).toBeVisible();

    // There is no account-creation path in the interface, because there is none at all.
    await expect(page.getByRole("link", { name: /sign up|create account|register/i })).toHaveCount(0);
    await expect(page.getByText(/one[- ]time|otp|verification code/i)).toHaveCount(0);
    // Nor a self-service reset. The screen does not explain that either — someone who cannot sign
    // in asks their Director without being told to — so what matters is that no control offers it.
    await expect(
      page.getByRole("link", { name: /forgot|reset|recover/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /forgot|reset|recover/i }),
    ).toHaveCount(0);

    await enterPhone(page, "0712345678");

    await expect(page.getByLabel(/enter your password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByText(/one[- ]time|otp|verification code/i)).toHaveCount(0);
  });

  test("step one advances on the format alone, and never says whether the account exists", async ({
    page,
  }) => {
    await page.goto("/sign-in");

    // A number no account holds reaches the password step exactly like one that does. If step one
    // ever consulted the server, these two would diverge and the flow would become an oracle.
    await enterPhone(page, "0712000001");
    await expect(page.getByLabel(/enter your password/i)).toBeVisible();

    // Nothing on the way through claimed anything about the account either way.
    await expect(page.getByText(/no account|not found|unknown number|exists/i)).toHaveCount(0);
  });

  test("the password can be revealed and hidden again", async ({ page }) => {
    await page.goto("/sign-in");
    await enterPhone(page, "0712345678");

    const password = page.getByLabel(/enter your password/i);
    await password.fill("Whatever12345");
    await expect(password).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: /show password/i }).click();
    await expect(password).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: /hide password/i }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("shows the number in the form it will be stored as, while it is typed", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel(/phone number/i).fill("0712345678");
    await expect(page.getByText("+255 712 345 678")).toBeVisible();
  });

  test("switches language before anyone has signed in", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Kiswahili" }).click();
    await expect(page.getByRole("heading", { name: "Ingia" })).toBeVisible();
    await page.getByRole("button", { name: "Kiingereza" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("gives the same neutral failure whether or not the account exists", async ({ page }) => {
    // Scoped to the form: Next.js renders its own route announcer with role="alert", and matching
    // that instead would make this assertion pass without ever reading the failure message.
    const failureMessage = page.locator("form").getByRole("alert");

    await signIn(page, "0712000001", "WrongPassword123");
    const unknown = await failureMessage.innerText();

    const { director } = fixtures();
    await signIn(page, director.phone, "WrongPassword123");
    const wrongPassword = await failureMessage.innerText();

    expect(unknown).toBe(wrongPassword);
    expect(unknown).not.toMatch(/not found|no account|incorrect password/i);
  });

  test("keeps an unauthenticated visitor out of the application", async ({ page }) => {
    await page.goto("/orders");
    await expectLandsOn(page, "/sign-in");
  });
});

test.describe("forced first login", () => {
  test("blocks everything until the temporary password is replaced", async ({ page }, testInfo) => {
    const gated = gatedFor(testInfo);

    await signIn(page, gated.phone, gated.password);
    await expectLandsOn(page, "/first-login");

    // No shell, no navigation, no data — the gate is not a UI convention.
    await expect(page.getByRole("link", { name: /orders|payments|dashboard/i })).toHaveCount(0);

    // Typing the address directly does not get past it either.
    await page.goto("/payments");
    await expectLandsOn(page, "/first-login");
  });

  test("states the password rules before the user types", async ({ page }, testInfo) => {
    const gated = gatedFor(testInfo);
    await signIn(page, gated.phone, gated.password);

    await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
    await expect(page.getByText(/one capital letter/i)).toBeVisible();
    await expect(page.getByText(/one number/i)).toBeVisible();
  });

  test("completes, and only then grants the role landing", async ({ page }, testInfo) => {
    const gated = gatedFor(testInfo);
    const newPassword = generateTemporaryPassword();

    await signIn(page, gated.phone, gated.password);
    await expectLandsOn(page, "/first-login");

    await page.getByLabel(/new password/i).fill(newPassword);
    await page.getByLabel(/type it again/i).fill(newPassword);
    await page.getByRole("button", { name: /save and continue/i }).click();

    // This fixture is a Cashier, so completion lands on the payment and dispatch queue.
    await expectLandsOn(page, "/payments");

    // The new password is the one that works now.
    await page.request.post("/auth/sign-out");
    await page.goto("/sign-in");
    await signIn(page, gated.phone, newPassword);
    await expectLandsOn(page, "/payments");
  });
});

test.describe("first login after a crash between Auth and the database", () => {
  test("finishes with the password already chosen, and never asks for another", async ({
    page,
  }, testInfo) => {
    const gated = gatedCrashFor(testInfo);
    const chosen = generateTemporaryPassword();

    // The password change reached Supabase Auth and the marker was written; nothing else happened.
    await changePasswordOutOfBand(gated.userId, chosen);

    // The chosen password is what signs in now — the temporary one is gone.
    await signIn(page, gated.phone, chosen);
    await expectLandsOn(page, "/first-login");

    // The screen asks for no password, because there is nothing left to change.
    await expect(page.getByText(/one step left/i)).toBeVisible();
    await expect(page.getByLabel(/new password/i)).toHaveCount(0);

    await page.getByRole("button", { name: /finish and continue/i }).click();
    await expectLandsOn(page, "/payments");

    // And the password they chose before the crash is still the one that works.
    await page.request.post("/auth/sign-out");
    await signIn(page, gated.phone, chosen);
    await expectLandsOn(page, "/payments");
  });
});

test.describe("the sign-in redirect target", () => {
  // `?next=` is attacker-reachable: it is in a link anyone can send. Only same-origin paths may be
  // honoured, and everything else falls back to the role landing.
  test("honours a same-origin path", async ({ page }) => {
    const { cashier } = fixtures();
    await page.goto("/sign-in?next=%2Forders");
    await enterPhone(page, cashier.phone);
    await submitPassword(page, cashier.password);
    await expectLandsOn(page, "/orders");
  });

  for (const [label, value] of [
    ["protocol-relative", "%2F%2Fevil.example"],
    ["absolute", "https%3A%2F%2Fevil.example"],
    ["backslash", "%2F%5Cevil.example"],
  ] as const) {
    test(`refuses a ${label} target and lands on the role page instead`, async ({ page }) => {
      const { cashier } = fixtures();
      await page.goto(`/sign-in?next=${value}`);
      await enterPhone(page, cashier.phone);
      await submitPassword(page, cashier.password);

      // Landed on their own role page, and — the point of the test — still on our own origin.
      await expectLandsOn(page, "/payments");
      expect(new URL(page.url()).host).toBe("127.0.0.1:3000");
    });
  }
});
