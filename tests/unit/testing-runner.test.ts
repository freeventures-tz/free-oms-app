import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { planRefusals } from "@/scripts/testing/plan.mjs";
import { buildSteps, jobsFromOutcomes, runSteps } from "@/scripts/testing/run.mjs";
import { selectTests } from "@/scripts/testing/select.mjs";

/**
 * How a plan becomes commands, and what stops it.
 *
 * Three properties matter. A runner is never started with an empty path list, because Vitest and
 * Playwright both read "no paths" as "every test". Every step that resets or writes a database is
 * preceded by the target check, and a refused check stops the run before the step starts. The
 * release tier ignores the plan's selection: it is always everything.
 */

const HEAD = "b".repeat(40);
const manifest = {
  version: 1,
  activation: { selectiveEnforcement: false },
  suites: {
    unit: ["tests/unit/**/*.test.ts"],
    integration: ["tests/integration/**/*.test.ts"],
    e2e: ["e2e/**/*.spec.ts"],
    pgtap: ["supabase/tests/database/*.sql"],
  },
  minimums: {},
  forceFull: [{ pattern: "lib/money.ts", reason: "money" }],
  docsOnly: ["README.md"],
  domains: { brand: { risk: "low", sources: ["components/brand/**"], e2e: ["e2e/auth.spec.ts"] } },
  groups: { integration: {}, e2e: {} },
  independent: { integration: ["tests/integration/authority.test.ts"], e2e: ["e2e/auth.spec.ts", "e2e/shell.spec.ts"] },
  smoke: { pgtap: [], integration: [], e2e: [] },
};
const files = [
  "README.md",
  "lib/money.ts",
  "components/brand/logo.tsx",
  "tests/unit/logo.test.ts",
  "tests/unit/money.test.ts",
  "tests/integration/authority.test.ts",
  "e2e/auth.spec.ts",
  "e2e/shell.spec.ts",
  "supabase/tests/database/001_auth.sql",
];
const edges = new Map([["tests/unit/logo.test.ts", ["components/brand/logo.tsx"]]]);
const identity = { base: "a".repeat(40), head: HEAD, executedCommit: HEAD, proven: true, problems: [] };
const plan = (path: string) => selectTests({ manifest, files, edges, changes: [{ status: "M", path }], identity, selector: { selectorDigest: "d" } });

const names = (steps: Array<{ name: string }>) => steps.map((step) => step.name);

describe("plan runner", () => {
  it("runs only the selected tests on the local tier, and skips empty suites instead of running them unfiltered", () => {
    const { steps, skipped } = buildSteps(plan("README.md"), "local");
    expect(names(steps)).toEqual(["lint", "typecheck"]);
    expect(skipped.map((skip: { suite: string }) => skip.suite)).toEqual(["unit", "pgtap", "migrationChain", "integration", "e2e"]);
  });

  it("passes explicit paths for a selection", () => {
    const { steps } = buildSteps(plan("components/brand/logo.tsx"), "local");
    const unit = steps.find((step: { name: string }) => step.name === "unit (selected)");
    expect(unit.args).toEqual(["vitest", "run", "--project", "unit", "tests/unit/logo.test.ts"]);
    const e2e = steps.find((step: { name: string }) => step.name === "e2e (selected)");
    expect(e2e.args).toEqual(["playwright", "test", "e2e/auth.spec.ts"]);
    // E2E runs a production build of the current source, then a reset, then the specs.
    expect(names(steps).slice(-3)).toEqual(["build", "reset before E2E", "e2e (selected)"]);
  });

  it("runs every suite, in isolation order, on the development tier while selection is in shadow", () => {
    const { steps } = buildSteps(plan("components/brand/logo.tsx"), "development");
    expect(names(steps)).toEqual([
      "lint",
      "typecheck",
      "unit",
      "build",
      "migration chain",
      "reset before pgTAP",
      "pgTAP",
      "database lint",
      "advisors",
      "reset before integration",
      "integration",
      "reset before E2E",
      "e2e",
    ]);
  });

  it("runs everything on the release tier whatever the plan selected", () => {
    const release = buildSteps(plan("README.md"), "release");
    expect(names(release.steps)).toContain("integration");
    expect(names(release.steps)).toContain("e2e");
    expect(release.steps.find((step: { name: string }) => step.name === "e2e").args).toEqual(["playwright", "test"]);
  });

  it("turns on the opt-in benchmarks only when asked", () => {
    const withBenchmarks = buildSteps(plan("README.md"), "release", { benchmarks: true }).steps;
    expect(withBenchmarks.find((step: { name: string }) => step.name === "e2e").env).toEqual({ FV_BENCHMARK: "1" });
    expect(buildSteps(plan("README.md"), "release").steps.find((step: { name: string }) => step.name === "e2e").env).toEqual({});
  });

  it("checks the targets before every destructive step, and stops before the step when refused", () => {
    const { steps } = buildSteps(plan("lib/money.ts"), "development");
    const spawned: string[] = [];
    const guarded: string[] = [];
    const result = runSteps(steps, {
      root: "/tmp/not-used",
      resultsDir: join(tmpdir(), "oms-unit-runner"),
      guard: (what: string) => {
        guarded.push(what);
        if (what === "reset before integration") throw new Error("NEXT_PUBLIC_SUPABASE_URL host db.example is not loopback");
      },
      spawn: (command: string, args: string[]) => {
        spawned.push(args.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
      print: () => {},
    });
    expect(result.ok).toBe(false);
    expect(guarded).toEqual(["migration chain", "reset before pgTAP", "pgTAP", "database lint", "advisors", "reset before integration"]);
    // Nothing after the refused check ran, and the refused step itself never started.
    expect(spawned.some((line) => line.includes("integration"))).toBe(false);
    expect(result.outcomes.at(-1)).toMatchObject({ name: "reset before integration", ok: false });
  });

  it("stops at the first failing step", () => {
    const { steps } = buildSteps(plan("lib/money.ts"), "development");
    const result = runSteps(steps, {
      root: "/tmp/not-used",
      resultsDir: join(tmpdir(), "oms-unit-runner"),
      guard: () => {},
      spawn: (_command: string, args: string[]) => ({ status: args.includes("typecheck") ? 2 : 0, stdout: "", stderr: "" }),
      print: () => {},
    });
    expect(result.outcomes.map((outcome: { name: string }) => outcome.name)).toEqual(["lint", "typecheck"]);
    expect(jobsFromOutcomes(result.outcomes, ["static", "database"])).toEqual({ static: { result: "failure" } });
  });

  it("refuses a plan made elsewhere, altered, made by another selector, or before the tree changed", () => {
    const made = plan("README.md");
    expect(planRefusals(made, { head: HEAD, digest: "d", worktreeDigest: null })).toEqual([]);
    expect(planRefusals(made, { head: "c".repeat(40), digest: "d", worktreeDigest: null })[0]).toMatch(/this checkout is at/);
    expect(planRefusals(made, { head: HEAD, digest: "other", worktreeDigest: null })[0]).toMatch(/stale/);
    expect(planRefusals({ ...made, risk: "low", fullReasons: ["x"] }, { head: HEAD, digest: "d", worktreeDigest: null })[0]).toMatch(/digest/);

    const local = selectTests({ manifest, files, edges, changes: [], identity: { ...identity, worktreeDigest: "1" }, selector: { selectorDigest: "d" } });
    expect(planRefusals(local, { head: HEAD, digest: "d", worktreeDigest: "2" })).toEqual(["the working tree changed after the plan was made"]);
  });
});
