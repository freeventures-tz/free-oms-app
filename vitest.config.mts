import { defineConfig } from "vitest/config";

/**
 * Two projects, because they have different jobs and different costs.
 *
 *   unit        — pure logic and components, jsdom, no network. Fast enough to run on every save.
 *   integration — real HTTP against the LOCAL Supabase stack. These are the tests that catch the
 *                 things a direct PostgreSQL session cannot see: schema exposure, key privileges,
 *                 and what Supabase Auth actually does.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          globals: true,
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/setup/unit.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          globals: true,
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/setup/integration.ts"],
          // Bootstraps the one Director the whole run shares. Exactly one bootstrap is permitted
          // per database, so it cannot be per-file.
          globalSetup: ["tests/setup/integration-global.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Provisioning tests share one bootstrap job and one Auth instance, so they run in order.
          fileParallelism: false,
        },
      },
    ],
  },
});
