import { defineConfig, devices } from "@playwright/test";

/**
 * When OMS_TEST_RESULTS_DIR is set (CI, `npm run test:plan`, `npm run test:release`), Playwright
 * also writes its JSON report there, one file per shard, which is what the Development Gate and
 * Release Gate count. Unset, the reporters are unchanged.
 */
const RESULTS_DIR = process.env.OMS_TEST_RESULTS_DIR;
const shard = (process.argv.find((arg) => arg.startsWith("--shard="))?.slice(8) ?? "").match(/^(\d+)\/(\d+)$/);
const RESULTS_FILE = shard ? `e2e.playwright.shard-${shard[1]}-of-${shard[2]}.json` : "e2e.playwright.json";
const BASE_REPORTERS: Array<[string] | [string, Record<string, unknown>]> = process.env.CI
  ? [["github"], ["list"]]
  : [["list"]];

/**
 * The three device tiers are separate projects, because the interface is intentionally different on
 * each one and "it works on desktop" says nothing about the drawer (design.md §3.2–§3.5).
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: RESULTS_DIR
    ? [...BASE_REPORTERS, ["json", { outputFile: `${RESULTS_DIR}/${RESULTS_FILE}` }]]
    : BASE_REPORTERS,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    locale: "en-GB",
    timezoneId: "Africa/Dar_es_Salaam",
  },

  // Viewport-driven, because the layout switches on CSS breakpoints rather than on a user-agent
  // string. One browser engine keeps CI light; what is being proven here is the responsive
  // behaviour, not cross-browser rendering.
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 }, // xs — below the 640px `sm` breakpoint
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 834, height: 1112 }, // md — the icon-rail tier
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, // xl
    },
  ],

  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3000",
    // NEVER reuse. A server left running from an earlier run keeps serving the previous build, so
    // the browser asks for chunk names that no longer exist, hydration never happens, and every
    // client-side test fails for a reason that has nothing to do with the code under test. That
    // cost an hour once; a port already in use is now a loud error instead.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
