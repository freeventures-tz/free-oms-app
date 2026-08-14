import { expect, test } from "@playwright/test";

import { fixtures, signIn } from "./fixtures";

/**
 * Installability, and the promise that comes with it (docs/pwa.md).
 *
 * Every one of these fails silently in real life: a manifest behind the proxy still returns 200 —
 * to a redirect — and the only symptom is that the browser stops offering to install, with nothing
 * said anywhere. So they are asserted rather than assumed.
 */

test.describe("installability", () => {
  test("serves the manifest to someone who has not signed in", async ({ page }) => {
    const response = await page.request.get("/manifest.webmanifest");

    expect(response.status()).toBe(200);
    // A redirect to /sign-in would arrive as HTML and still be a 200 after following it.
    expect(response.headers()["content-type"]).toContain("manifest");

    const manifest = await response.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");

    // Android needs both sizes, and a maskable icon or it renders the artwork inside a white blob.
    const sizes = (purpose: string) =>
      manifest.icons
        .filter((icon: { purpose?: string }) => (icon.purpose ?? "any") === purpose)
        .map((icon: { sizes: string }) => icon.sizes);

    expect(sizes("any")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(sizes("maskable")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  test("every icon the manifest promises actually exists", async ({ page }) => {
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();

    for (const icon of manifest.icons as { src: string }[]) {
      const response = await page.request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()["content-type"], icon.src).toContain("image/png");
    }

    // The tab icon and the one iOS asks for by name are linked from the document, not the manifest.
    for (const path of ["/favicon.ico", "/icons/apple-touch-icon-180.png"]) {
      expect((await page.request.get(path)).status(), path).toBe(200);
    }
  });

  test("serves the service worker as a script to someone who has not signed in", async ({
    page,
  }) => {
    const response = await page.request.get("/sw.js");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("javascript");
  });

  test("registers the service worker on the sign-in screen", async ({ page }) => {
    await page.goto("/sign-in");

    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.scope;
    });

    // Root scope, or it would not control the application it is meant to make installable.
    expect(new URL(scope).pathname).toBe("/");
  });
});

test("the service worker stores nothing, before or after signing in", async ({ page }) => {
  // The security promise in docs/pwa.md §4: staff share phones, a service-worker cache outlives
  // sign-out, and every protected screen is rendered from live database state. So nothing is kept.
  await page.goto("/sign-in");
  await page.evaluate(() => navigator.serviceWorker.ready);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);

  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expect(page).toHaveURL(/dashboard/);

  // Having rendered a protected, Director-only screen, there is still nothing in the cache.
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
