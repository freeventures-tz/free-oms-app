import { expect, test } from "@playwright/test";

import { expectLandsOn, fixtures, freshPhone, openNavigation, signIn } from "./fixtures";

/**
 * Landing is by role, immediately after authentication, with no intermediate menu (design.md §4.1),
 * and the role comes from live database state rather than the token.
 */

test("a Sales Representative lands on Orders", async ({ page }) => {
  const { salesRep } = fixtures();
  await signIn(page, salesRep.phone, salesRep.password);
  await expectLandsOn(page, "/orders");
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
});

test("a Cashier lands on the payment and dispatch queue", async ({ page }) => {
  const { cashier } = fixtures();
  await signIn(page, cashier.phone, cashier.password);
  await expectLandsOn(page, "/payments");
});

test("a Director lands on the dashboard and can reach account administration", async ({ page }) => {
  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: /user accounts/i })).toBeVisible();
});

test("account administration is hidden from a Cashier, not merely disabled", async ({
  page,
}, testInfo) => {
  const { cashier } = fixtures();
  await signIn(page, cashier.phone, cashier.password);
  await expectLandsOn(page, "/payments");

  // Nothing in the interface offers it — no greyed control, no tooltip, no entry at all.
  const navigation = await openNavigation(page, testInfo);
  await expect(navigation.getByRole("link", { name: /user accounts/i })).toHaveCount(0);

  // ...and typing the address gets a refusal that does not describe what is behind it.
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: /don't have access/i })).toBeVisible();
  await expect(page.getByText(/director/i)).toHaveCount(0);
});

test("the dashboard is refused to a Sales Representative", async ({ page }) => {
  const { salesRep } = fixtures();
  await signIn(page, salesRep.phone, salesRep.password);
  // Wait for the session to be established before navigating, or the request races the sign-in
  // redirect and is refused for having no session rather than for having the wrong role.
  await expectLandsOn(page, "/orders");

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /don't have access/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /go to my home page/i })).toBeVisible();
});

test("signing out returns to sign-in and ends the session", async ({ page }, testInfo) => {
  const { salesRep } = fixtures();
  await signIn(page, salesRep.phone, salesRep.password);
  await expectLandsOn(page, "/orders");

  // Sign-out lives with the identity: in the drawer on a phone, in the shell everywhere else.
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: /^menu$/i }).click();
    await page.locator("#fv-drawer").getByRole("button", { name: /^sign out$/i }).click();
  } else {
    await page.getByRole("button", { name: /^sign out$/i }).first().click();
  }
  await expectLandsOn(page, "/sign-in");

  await page.goto("/orders");
  await expectLandsOn(page, "/sign-in");
});

test("a Director recovers an account whose creation response was lost", async ({ page }) => {
  const { director } = fixtures();
  const phone = freshPhone();

  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");
  await page.goto("/admin/accounts");

  // Create the account for real. The whole journey depends on it genuinely existing afterwards.
  await page.getByLabel(/full name/i).fill("Recovered Account");
  await page.getByLabel(/phone number/i).fill(phone);
  await page.getByRole("button", { name: /^create account$/i }).click();
  await expect(page.getByText(/temporary password/i)).toBeVisible();

  // The Director loses the response and reloads. A refresh mints a NEW idempotency key, so the
  // resubmission is a new job — and the phone is what stops it becoming a second account.
  await page.goto("/admin/accounts");
  await page.getByLabel(/full name/i).fill("Recovered Account");
  await page.getByLabel(/phone number/i).fill(phone);
  await page.getByRole("button", { name: /^create account$/i }).click();

  // It names the situation, and offers the action that actually helps.
  await expect(page.getByText(/already belongs to an account/i)).toBeVisible();

  const recover = page.getByRole("button", { name: /set a new password for this account/i });
  await expect(recover).toBeVisible();
  await recover.click();

  // A usable credential, shown once, for the account that was already there.
  await expect(page.getByText(/temporary password/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /i have given it to them/i })).toBeVisible();
});
