import { expect, test } from "@playwright/test";

import { enterPhone, expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Mobile is not the desktop layout compressed (design.md §3). Each tier gets an intentional layout,
 * and the destinations are identical in all three — no destination is desktop-only.
 */

test("the navigation matches the device tier", async ({ page }, testInfo) => {
  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  const menuButton = page.getByRole("button", { name: /^menu$/i });
  const sidebar = page.locator("aside");

  if (testInfo.project.name === "mobile") {
    // A hamburger opens a left drawer over a scrim; the sidebar is not shown inline.
    await expect(menuButton).toBeVisible();
    await expect(sidebar).toBeHidden();

    await menuButton.click();
    await expect(page.locator("#fv-drawer")).toBeVisible();
  } else {
    // Tablet rail and desktop sidebar both keep the destinations permanently visible.
    await expect(menuButton).toHaveCount(0);
    await expect(sidebar).toBeVisible();
  }
});

test("the rail or sidebar sits beside the page, not above it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the phone has a drawer, not a rail");

  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  // Checked on the two screens where the tablet rail was seen stacked above the page.
  for (const path of ["/orders", "/imprest"]) {
    await page.goto(path);
    const rail = await page.locator("aside").boundingBox();
    const main = await page.locator("main").boundingBox();
    expect(rail, `${path}: rail`).not.toBeNull();
    expect(main, `${path}: main`).not.toBeNull();

    // Side by side: the page starts where the rail ends, and both start at the top of the screen.
    expect(main!.x, `${path}: main starts after the rail`).toBeGreaterThanOrEqual(
      rail!.x + rail!.width - 1,
    );
    expect(rail!.y, `${path}: rail starts at the top`).toBeLessThanOrEqual(1);
    expect(main!.y, `${path}: main is not pushed below the rail`).toBeLessThan(rail!.height);
  }
});

test("every destination the role has is reachable on every device", async ({ page }, testInfo) => {
  const { director } = fixtures();
  await signIn(page, director.phone, director.password);

  const navigation = await openNavigation(page, testInfo);

  for (const name of [/dashboard/i, /^orders$/i, /payments/i, /user accounts/i]) {
    await expect(navigation.getByRole("link", { name })).toBeVisible();
  }
});

test("the sign-in screen never scrolls sideways", async ({ page }) => {
  await page.goto("/sign-in");

  const noOverflow = async () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );

  expect(await noOverflow()).toBe(true);

  // The password step is a different layout — twelve segments in a row — so it is checked too.
  await enterPhone(page, "0712345678");
  await expect(page.getByLabel(/enter your password/i)).toBeVisible();
  expect(await noOverflow()).toBe(true);
});

test("touch targets on the sign-in form meet the 44px floor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "44px is a floor on touch devices");

  await page.goto("/sign-in");

  for (const locator of [
    page.getByLabel(/phone number/i),
    page.getByRole("button", { name: /^continue$/i }),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await enterPhone(page, "0712345678");

  for (const locator of [
    page.getByLabel(/enter your password/i),
    // The reveal control is a target in its own right, and the smallest one on the screen.
    page.getByRole("button", { name: /show password/i }),
    page.getByRole("button", { name: /^sign in$/i }),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("the language switcher is offered before anyone signs in, on every device", async ({
  page,
}) => {
  await page.goto("/sign-in");

  for (const name of [/^english$/i, /^kiswahili$/i]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  }
});
