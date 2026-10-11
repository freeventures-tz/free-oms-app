import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { benchmarkSteps } from "@/scripts/testing/benchmarks.mjs";
import { planRefusals } from "@/scripts/testing/plan.mjs";
import { buildSteps, jobsFromOutcomes, runSteps, stepEnvironment } from "@/scripts/testing/run.mjs";
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
    // pgTAP holds the mandatory database smoke, so it runs in full on every tier (finding R6).
    expect(names(steps)).toEqual(["lint", "typecheck", "reset before pgTAP", "pgTAP", "database lint", "advisors"]);
    expect(skipped.map((skip: { suite: string }) => skip.suite)).toEqual(["unit", "migrationChain", "integration", "e2e"]);
  });

  it("R6: keeps full pgTAP, lint and advisors on a lower-risk local plan, and runs the chain only when the plan selects it", () => {
    const lower = plan("components/brand/logo.tsx");
    expect(lower.risk).toBe("low");
    const local = names(buildSteps(lower, "local").steps);
    for (const step of ["reset before pgTAP", "pgTAP", "database lint", "advisors"]) expect(local).toContain(step);
    expect(local).not.toContain("migration chain");

    const high = plan("lib/money.ts");
    expect(high.selection.migrationChain.mode).toBe("full");
    expect(names(buildSteps(high, "local").steps)).toContain("migration chain");
  });

  it("passes explicit paths for a selection, to the listing and the run alike", () => {
    const { steps } = buildSteps(plan("components/brand/logo.tsx"), "local");
    const step = (name: string) => steps.find((entry: { name: string }) => entry.name === name);
    expect(step("list unit").args).toEqual(["vitest", "list", "--project", "unit", "--json={results}/unit.vitest-list.json", "tests/unit/logo.test.ts"]);
    expect(step("unit (selected)").args).toEqual(["vitest", "run", "--project", "unit", "tests/unit/logo.test.ts"]);
    expect(step("list e2e").args).toEqual(["playwright", "test", "--list", "--reporter=json", "e2e/auth.spec.ts"]);
    expect(step("e2e (selected)").args).toEqual(["playwright", "test", "e2e/auth.spec.ts"]);
    // E2E builds the current source, records that build, lists, resets, then runs.
    expect(names(steps).slice(-5)).toEqual(["build for E2E", "record the tested build", "list e2e", "reset before E2E", "e2e (selected)"]);
  });

  it("runs every suite, in isolation order, on the development tier while selection is in shadow", () => {
    const { steps } = buildSteps(plan("components/brand/logo.tsx"), "development");
    expect(names(steps)).toEqual([
      "lint",
      "typecheck",
      "list unit",
      "unit",
      "build",
      "migration chain",
      "reset before pgTAP",
      "pgTAP",
      "database lint",
      "advisors",
      "list integration",
      "reset before integration",
      "integration",
      "build for E2E",
      "record the tested build",
      "list e2e",
      "reset before E2E",
      "e2e",
    ]);
  });

  it("R3: lists without writing the run's results, and the listing of integration comes before its reset", () => {
    const { steps } = buildSteps(plan("lib/money.ts"), "development");
    for (const name of ["list unit", "list integration", "list e2e"]) {
      expect(steps.find((step: { name: string }) => step.name === name).env.OMS_TEST_RESULTS_DIR).toBe("");
    }
    const order = names(steps);
    expect(order.indexOf("list integration")).toBeLessThan(order.indexOf("reset before integration"));
    expect(steps.find((step: { name: string }) => step.name === "list integration").destructive).toBe(true);
  });

  it("runs everything on the release tier whatever the plan selected", () => {
    const release = buildSteps(plan("README.md"), "release");
    expect(names(release.steps)).toContain("integration");
    expect(names(release.steps)).toContain("migration chain");
    expect(release.steps.find((step: { name: string }) => step.name === "e2e").args).toEqual(["playwright", "test"]);
  });

  it("R2: runs the benchmarks after the main suites on the release tier, never inside them", () => {
    const release = buildSteps(plan("README.md"), "release").steps;
    const order = names(release);
    for (const step of release) expect(step.env?.FV_BENCHMARK, step.name).toBeUndefined();
    expect(order.indexOf("integration benchmarks")).toBe(order.indexOf("integration") + 1);
    expect(order.indexOf("e2e benchmarks")).toBe(order.indexOf("e2e") + 1);
    expect(release.find((step: { name: string }) => step.name === "e2e benchmarks").args).toEqual([
      "scripts/testing/benchmarks.mjs", "--suite", "e2e", "--results", "{results}",
    ]);

    // Elsewhere only on request.
    expect(names(buildSteps(plan("lib/money.ts"), "development").steps)).not.toContain("e2e benchmarks");
    expect(names(buildSteps(plan("lib/money.ts"), "development", { benchmarks: true }).steps)).toContain("e2e benchmarks");
  });

  it("R2: runs each benchmark file alone, after its own reset, the way the specs document", () => {
    const benchmarks = {
      e2e: [
        { file: "e2e/imprest-funding.spec.ts", grep: "mobile benchmark" },
        { file: "e2e/stock-mobile-benchmark.spec.ts", grep: "phone over 4G" },
      ],
      integration: [{ file: "tests/integration/stock-benchmark.test.ts" }],
    };
    const e2e = benchmarkSteps({ benchmarks }, "e2e");
    expect(e2e.map((step: { name: string }) => step.name)).toEqual([
      "reset before benchmark imprest-funding",
      "benchmark imprest-funding",
      "reset before benchmark stock-mobile-benchmark",
      "benchmark stock-mobile-benchmark",
    ]);
    expect(e2e[1].args).toEqual(["playwright", "test", "--project=mobile", "e2e/imprest-funding.spec.ts", "-g", "mobile benchmark"]);
    expect(e2e[1].env).toEqual({ FV_BENCHMARK: "1", OMS_E2E_RESULTS_NAME: "e2e-benchmark-imprest-funding.playwright.json" });
    // Each pass is its own job, so one slow benchmark does not stop the others under keep-going.
    expect(new Set(e2e.map((step: { job: string }) => step.job)).size).toBe(2);
    for (const step of e2e) expect(step.destructive).toBe(true);

    const integration = benchmarkSteps({ benchmarks }, "integration");
    expect(integration[1].args).toEqual(["vitest", "run", "--project", "integration", "tests/integration/stock-benchmark.test.ts"]);
    expect(integration[1].env).toEqual({ FV_BENCHMARK: "1", OMS_TEST_SUITE: "integration-benchmark" });

    expect(() => benchmarkSteps({}, "e2e")).toThrow(/lists no e2e benchmarks/);
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
        if (what === "list integration") throw new Error("NEXT_PUBLIC_SUPABASE_URL host db.example is not loopback");
      },
      spawn: (command: string, args: string[]) => {
        spawned.push(args.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
      print: () => {},
    });
    expect(result.ok).toBe(false);
    expect(guarded).toEqual(["migration chain", "reset before pgTAP", "pgTAP", "database lint", "advisors", "list integration"]);
    // Nothing after the refused check ran, and the refused step itself never started.
    expect(spawned.some((line) => line.includes("integration"))).toBe(false);
    expect(result.outcomes.at(-1)).toMatchObject({ name: "list integration", ok: false });
  });

  it("R2: an ambient FV_BENCHMARK=1 never reaches a main-suite step; only a benchmark pass sets it", () => {
    expect(stepEnvironment({ FV_BENCHMARK: "1", PATH: "/bin" }, "/results", undefined)).toEqual({ PATH: "/bin", OMS_TEST_RESULTS_DIR: "/results", FV_BENCHMARK: "0" });
    expect(stepEnvironment({ FV_BENCHMARK: "1" }, "/results", { FV_BENCHMARK: "1", OMS_TEST_SUITE: "integration-benchmark" }).FV_BENCHMARK).toBe("1");

    // Through runSteps, with the flag set in the shell that started the run.
    const seen: Record<string, string | undefined> = {};
    const previous = process.env.FV_BENCHMARK;
    process.env.FV_BENCHMARK = "1";
    try {
      const release = buildSteps(plan("README.md"), "release").steps.filter((step: { name: string }) => ["integration", "e2e"].includes(step.name));
      const [benchmark] = benchmarkSteps({ benchmarks: { integration: [{ file: "tests/integration/stock-benchmark.test.ts" }] } }, "integration").slice(1);
      runSteps([...release, benchmark], {
        root: mkdtempSync(join(tmpdir(), "oms-ambient-")),
        resultsDir: mkdtempSync(join(tmpdir(), "oms-ambient-results-")),
        guard: () => {},
        spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
          seen[args.join(" ")] = options.env.FV_BENCHMARK;
          return { status: 0, stdout: "", stderr: "" };
        },
        print: () => {},
      });
    } finally {
      if (previous === undefined) delete process.env.FV_BENCHMARK;
      else process.env.FV_BENCHMARK = previous;
    }
    expect(seen["vitest run --project integration"]).toBe("0");
    expect(seen["playwright test"]).toBe("0");
    expect(seen["vitest run --project integration tests/integration/stock-benchmark.test.ts"]).toBe("1");
  });

  describe("R2 through a real child that loads the .env files itself", () => {
    // The test setups load .env.test.local and .env.local with dotenv, which fills in only what is
    // unset. A variable the runner deletes comes back from those files, so the child runs exactly
    // the setups' own dotenv calls and reports what the specs would read.
    const setupFiles = ["tests/setup/integration-global.ts", "tests/setup/integration.ts", "e2e/global-setup.ts"];
    const dotenvCalls = setupFiles.map((file) => readFileSync(join(process.cwd(), file), "utf8").match(/^config\(\{ path: "[^"]+", quiet: true \}\);$/gm) ?? []);
    const dotenvPath = createRequire(join(process.cwd(), "package.json")).resolve("dotenv");

    function childSees(input: "shell" | ".env.local" | ".env.test.local", own?: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), "oms-child-env-"));
      const resultsDir = mkdtempSync(join(tmpdir(), "oms-child-env-results-"));
      if (input !== "shell") writeFileSync(join(root, input), "FV_BENCHMARK=1\n");
      const script = [`const { config } = require(${JSON.stringify(dotenvPath)});`, ...dotenvCalls[0], "process.stdout.write(String(process.env.FV_BENCHMARK));"].join("\n");
      const previous = process.env.FV_BENCHMARK;
      if (input === "shell") process.env.FV_BENCHMARK = "1";
      else delete process.env.FV_BENCHMARK;
      try {
        const result = runSteps([{ name: "integration", job: "integration", command: process.execPath, args: ["-e", script], stdoutTo: "seen.txt", env: own }], {
          root,
          resultsDir,
          guard: () => {},
          print: () => {},
        });
        expect(result.ok).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.FV_BENCHMARK;
        else process.env.FV_BENCHMARK = previous;
      }
      return readFileSync(join(resultsDir, "seen.txt"), "utf8");
    }

    it("runs the same dotenv calls the integration and E2E setups make", () => {
      for (const calls of dotenvCalls) {
        expect(calls).toEqual(['config({ path: ".env.test.local", quiet: true });', 'config({ path: ".env.local", quiet: true });']);
      }
    });

    for (const input of ["shell", ".env.local", ".env.test.local"] as const) {
      it(`keeps FV_BENCHMARK disabled in a main step when ${input} sets it to 1`, () => {
        expect(childSees(input)).toBe("0");
      });

      it(`keeps FV_BENCHMARK=1 in a benchmark pass when ${input} sets it`, () => {
        expect(childSees(input, { FV_BENCHMARK: "1", OMS_TEST_SUITE: "integration-benchmark" })).toBe("1");
      });
    }
  });

  it("fills in the results directory and keeps a listing's stdout apart from its stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-runner-"));
    const calls: string[][] = [];
    runSteps(
      [
        { name: "list e2e", job: "e2e", command: "npx", args: ["x", "--json={results}/a.json"], stdoutTo: "e2e.playwright-list.json", env: { OMS_TEST_RESULTS_DIR: "" } },
      ],
      {
        root: "/tmp/not-used",
        resultsDir: dir,
        guard: () => {},
        spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
          calls.push(args);
          expect(options.env.OMS_TEST_RESULTS_DIR).toBe("");
          return { status: 0, stdout: '{"suites":[]}', stderr: "a warning" };
        },
        print: () => {},
      },
    );
    expect(calls[0].at(-1)).toBe(`--json=${dir}/a.json`);
    expect(readFileSync(join(dir, "e2e.playwright-list.json"), "utf8")).toBe('{"suites":[]}');
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

  it("with keep-going, a failure ends only its own job, the way CI's jobs are independent", () => {
    const { steps } = buildSteps(plan("lib/money.ts"), "development");
    const result = runSteps(steps, {
      root: "/tmp/not-used",
      resultsDir: join(tmpdir(), "oms-unit-runner"),
      keepGoing: true,
      guard: () => {},
      spawn: (_command: string, args: string[]) => ({ status: args.includes("unit") ? 1 : 0, stdout: "", stderr: "" }),
      print: () => {},
    });
    expect(result.ok).toBe(false);
    // The static job stops at unit, so its build is skipped; every other job still runs, and the
    // E2E job builds for itself.
    expect(result.outcomes.find((outcome: { name: string }) => outcome.name === "build")).toMatchObject({ skipped: true, ok: false });
    for (const name of ["migration chain", "pgTAP", "integration", "build for E2E", "e2e"]) {
      expect(result.outcomes.find((outcome: { name: string }) => outcome.name === name), name).toMatchObject({ ok: true });
    }
    expect(jobsFromOutcomes(result.outcomes, ["static", "database", "integration", "e2e"])).toEqual({
      static: { result: "failure" },
      database: { result: "success" },
      integration: { result: "success" },
      e2e: { result: "success" },
    });
  });

  it("with keep-going, a refused target check still stops everything", () => {
    const { steps } = buildSteps(plan("lib/money.ts"), "development");
    const spawned: string[] = [];
    const result = runSteps(steps, {
      root: "/tmp/not-used",
      resultsDir: join(tmpdir(), "oms-unit-runner"),
      keepGoing: true,
      guard: (what: string) => {
        if (what === "migration chain") throw new Error("not loopback");
      },
      spawn: (_command: string, args: string[]) => {
        spawned.push(args.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
      print: () => {},
    });
    expect(result.ok).toBe(false);
    expect(spawned.some((line) => /integration|playwright/.test(line))).toBe(false);
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

  it("R5: refuses a commit-only plan on a working tree with changes, and accepts a worktree plan bound to them", () => {
    // The review's probe: plan a commit, then edit business source, then run under the old identity.
    const made = plan("README.md");
    expect(planRefusals(made, { head: HEAD, digest: "d", worktreeDigest: null, dirty: true })).toEqual([
      "the working tree has changes the plan's commit does not hold: commit them, or plan with --worktree",
    ]);
    const bound = selectTests({ manifest, files, edges, changes: [], identity: { ...identity, worktreeDigest: "1" }, selector: { selectorDigest: "d" } });
    expect(planRefusals(bound, { head: HEAD, digest: "d", worktreeDigest: "1", dirty: true })).toEqual([]);
  });
});
