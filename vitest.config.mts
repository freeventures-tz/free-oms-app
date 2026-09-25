import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Integration files that run before every other file, in this order.
 *
 * Vitest orders files by cached duration and size, not by name, and the integration files share one
 * database. `imprest-funding.test.ts` proves that concurrent first requests race to OPEN the one
 * imprest fund, which is only a race while no fund exists. Other files open or join that fund too
 * (lost-response, disbursements), so without this the race could quietly become six requests
 * joining a fund that is already there, and still pass.
 */
const RUN_FIRST = ["tests/integration/imprest-funding.test.ts"];

function rank(spec: TestSpecification): number {
  const path = spec.moduleId.replaceAll("\\", "/");
  const index = RUN_FIRST.findIndex((file) => path.endsWith(file));
  return index === -1 ? RUN_FIRST.length : index;
}

class RunFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Array.prototype.sort is stable, so everything not named above keeps Vitest's own order.
    return [...(await super.sort(files))].sort((a, b) => rank(a) - rank(b));
  }
}

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
    // Vitest accepts a sequencer only at the root, not per project.
    sequence: { sequencer: RunFirstSequencer },
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
