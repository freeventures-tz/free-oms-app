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

  if (testInfo.project.name !== "desktop") {
    // Phones and portrait tablets (`md`, design.md §3.4): a hamburger opens a left drawer over a
    // scrim; the sidebar is not shown inline.
    await expect(menuButton).toBeVisible();
    await expect(sidebar).toBeHidden();

    await menuButton.click();
    const drawer = page.getByRole("dialog", { name: /^menu$/i });
    await expect(drawer).toBeVisible();
    await expect(page.locator("#fv-drawer")).toBeVisible();

    // A real modal: focus is inside it, Esc closes it, and focus goes back to the menu button.
    expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menuButton).toBeFocused();
  } else {
    // The desktop sidebar keeps the destinations permanently visible.
    await expect(menuButton).toHaveCount(0);
    await expect(sidebar).toBeVisible();
  }
});

test("the rail or sidebar sits beside the page, not above it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "phones and portrait tablets have a drawer");

  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  // Checked on the two screens where the tablet rail was seen stacked above the page, at the rail
  // width (`lg`) and at the sidebar width (`xl`).
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/orders", "/imprest"]) {
      await page.goto(path);
      const rail = await page.locator("aside").boundingBox();
      const main = await page.locator("main").boundingBox();
      expect(rail, `${width} ${path}: rail`).not.toBeNull();
      expect(main, `${width} ${path}: main`).not.toBeNull();

      // Side by side: the page starts where the rail ends, and both start at the top of the screen.
      expect(main!.x, `${width} ${path}: main starts after the rail`).toBeGreaterThanOrEqual(
        rail!.x + rail!.width - 1,
      );
      expect(rail!.y, `${width} ${path}: rail starts at the top`).toBeLessThanOrEqual(1);
      expect(main!.y, `${width} ${path}: main is not pushed below the rail`).toBeLessThan(
        rail!.height,
      );
    }
  }
});

test("the icon rail fits its items and names them on focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the rail is the `lg` tier");

  const { director } = fixtures();
  await page.setViewportSize({ width: 1100, height: 900 });
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  const aside = page.locator("aside");
  expect((await aside.boundingBox())!.width).toBe(72);

  // Nothing inside an item spills out of it: the labels that overflowed the old rail are gone.
  const overflowing = await aside
    .getByRole("link")
    .evaluateAll((links) => links.filter((link) => link.scrollWidth > link.clientWidth + 1).length);
  expect(overflowing).toBe(0);

  // The label is the link's name, and shows on keyboard focus as well as hover.
  const storekeepers = aside.getByRole("link", { name: /storekeepers/i });
  await storekeepers.focus();
  await expect(page.getByRole("tooltip")).toHaveText(/storekeepers/i);

  // Who is signed in is still on screen at this tier.
  await expect(page.getByText(/signed in as/i)).toBeVisible();
});

test("the sidebar stays in reach at the bottom of a long page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "phones and portrait tablets have a drawer");

  const { director } = fixtures();
  await page.setViewportSize({ width: 1440, height: 500 });
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator("aside").getByRole("link").first()).toBeInViewport();
});

test("the phone top bar fits a 320px screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "the narrowest phone");

  const { director } = fixtures();
  await page.setViewportSize({ width: 320, height: 640 });
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  const header = page.getByRole("banner");
  expect(await header.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  // The compact switcher keeps both languages, their full names, and the 44px floor.
  for (const name of [/^english$/i, /^kiswahili$/i]) {
    const box = await header.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("a skip link is the first stop and lands on the page", async ({ page }) => {
  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");

  // A fresh load, so focus starts at the top of the document.
  await page.reload();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to main content/i });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
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
