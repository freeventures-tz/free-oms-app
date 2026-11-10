/**
 * Turning a plan into commands, and running them with timings.
 *
 * Shared by `test:plan` (local and development tiers) and `test:release` (the full candidate run).
 * The ordering is the isolation contract for a single local stack:
 *
 *   1. static checks, which touch no database;
 *   2. the migration chain, alone, because it resets to historical boundaries and restores the
 *      latest database itself;
 *   3. a fresh reset, then pgTAP, which needs an untouched database for its plan counts;
 *   4. database lint and advisors;
 *   5. the integration listing, then a reset, then integration (one bootstrap per database);
 *   6. build, a record of that build, the E2E listing, then E2E behind its own reset.
 *
 * Every step that resets, writes or reads a database names its `targets`, and the runner checks the
 * targets (target-guard.mjs) immediately before each one. A suite with nothing selected is skipped
 * and recorded as not selected: no runner is ever started with an empty path list, because Vitest
 * and Playwright both treat "no paths" as "every test".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertSafeTargets, testEnvironment } from "./target-guard.mjs";

const IS_WINDOWS = process.platform === "win32";

function npx(args) {
  return { command: "npx", args };
}

function npm(args) {
  return { command: "npm", args };
}

/**
 * The steps for a tier.
 *
 *   local        what the plan's SELECTION needs: lint, types, the selected unit files, the full
 *                pgTAP suite (which holds the mandatory database smoke), database lint and advisors
 *                every time, the migration chain when the plan selects it, and HTTP and E2E proof
 *                where the selection reaches them. For a plan made in enforce mode (`npm run
 *                check`) it is the plan's EXECUTION instead: exactly what CI will hold the pull
 *                request to, so a database suite the lane leaves out is left out here too
 *   development  what the plan's EXECUTION requires, in the CI job order (full while in shadow)
 *   release      everything, always, whatever the plan says, then every opt-in benchmark
 *
 * Each runner lists its tests before it runs them, so the gate can require every listed test to
 * have run. `{results}` in an argument is the results directory, filled in by runSteps.
 */
/** @param {any} plan @param {string} tier @param {{ benchmarks?: boolean }} [options] @returns {{ steps: any[], skipped: Array<{ suite: string, reason: string }> }} */
export function buildSteps(plan, tier, { benchmarks = false } = {}) {
  if (!["local", "development", "release"].includes(tier)) throw new Error(`unknown tier ${tier}`);
  const lanePlan = plan.mode === "enforce";
  const source = tier === "local" && !lanePlan ? plan.selection : plan.execution;
  const full = (suite) => tier === "release" || source[suite]?.mode === "full";
  const files = (suite) => (tier === "release" ? plan.inventory[suite] : source[suite]?.files ?? []);
  // A release candidate always runs the benchmarks, and the Release Gate accepts a benchmark skipped
  // in the main run only when it passed in its own pass. The main suites never switch them on: they
  // leave their samples in the database the later specs read. Each benchmark file runs alone after
  // its own reset instead (benchmarks.mjs), as the specs document.
  const benchmarkPasses = tier === "release" || benchmarks;
  // Listing must not write the run's results file.
  const listEnv = { OMS_TEST_RESULTS_DIR: "" };
  const steps = [];
  const skipped = [];

  steps.push({ name: "lint", job: "static", ...npm(["run", "lint"]) });
  steps.push({ name: "typecheck", job: "static", ...npm(["run", "typecheck"]) });

  const unit = full("unit") || tier !== "local" ? [] : files("unit");
  if (full("unit") || tier !== "local" || unit.length > 0) {
    steps.push({ name: "list unit", job: "static", env: listEnv, ...npx(["vitest", "list", "--project", "unit", "--json={results}/unit.vitest-list.json", ...unit]) });
    steps.push({ name: unit.length > 0 ? "unit (selected)" : "unit", job: "static", ...npx(["vitest", "run", "--project", "unit", ...unit]) });
  } else {
    skipped.push({ suite: "unit", reason: "no unit test selected" });
  }
  if (tier !== "local" || lanePlan) steps.push({ name: "build", job: "static", ...npm(["run", "build"]) });

  // A lane plan says outright whether the database suites are needed. Any other plan runs pgTAP,
  // lint and advisors every time, and the chain in CI order or when the selection asks for it.
  const required = (key) => tier === "release" || !lanePlan || (source[key]?.mode ?? "full") !== "none";
  const chain = lanePlan && tier !== "release" ? required("migrationChain") : tier !== "local" || plan.selection?.migrationChain?.mode === "full";
  if (chain) {
    steps.push({ name: "migration chain", job: "database", destructive: true, targets: [], log: "migration-chain.log", ...npm(["run", "test:migration-chain"]) });
  } else {
    skipped.push({ suite: "migrationChain", reason: (lanePlan ? source.migrationChain?.reason : plan.selection?.migrationChain?.reason) ?? "not selected" });
  }
  if (required("pgtap")) {
    steps.push({ name: "reset before pgTAP", job: "database", destructive: true, targets: [], ...npx(["supabase", "db", "reset"]) });
    steps.push({ name: "pgTAP", job: "database", destructive: true, targets: [], log: "pgtap.log", ...npx(["supabase", "test", "db"]) });
    steps.push({ name: "database lint", job: "database", targets: [], ...npx(["supabase", "db", "lint", "--level", "warning"]) });
    steps.push({ name: "advisors", job: "database", targets: [], ...{ command: process.execPath, args: ["scripts/run-advisors.mjs"] } });
  } else {
    skipped.push({ suite: "pgtap", reason: source.pgtap?.reason ?? "not required for this change" });
  }

  const integration = full("integration") ? [] : files("integration");
  if (full("integration") || integration.length > 0) {
    // Listing integration runs its global setup, which bootstraps the database's one Director, so
    // it comes before the reset that the run itself needs.
    steps.push({
      name: "list integration",
      job: "integration",
      destructive: true,
      env: listEnv,
      ...npx(["vitest", "list", "--project", "integration", "--json={results}/integration.vitest-list.json", ...integration]),
    });
    steps.push({ name: "reset before integration", job: "integration", destructive: true, ...npx(["supabase", "db", "reset"]) });
    steps.push({
      name: integration.length > 0 ? "integration (selected)" : "integration",
      job: "integration",
      destructive: true,
      ...npx(["vitest", "run", "--project", "integration", ...integration]),
    });
    if (benchmarkPasses) {
      steps.push({
        name: "integration benchmarks",
        job: "integration",
        destructive: true,
        ...{ command: process.execPath, args: ["scripts/testing/benchmarks.mjs", "--suite", "integration", "--results", "{results}"] },
      });
    }
  } else {
    skipped.push({ suite: "integration", reason: "no integration test selected" });
  }

  const e2e = full("e2e") ? [] : files("e2e");
  if (full("e2e") || e2e.length > 0) {
    // The E2E job builds the current source itself, as its CI job does, so it never depends on
    // another job's build, and records that build so a release is bound to what was tested.
    steps.push({ name: "build for E2E", job: "e2e", ...npm(["run", "build"]) });
    steps.push({
      name: "record the tested build",
      job: "e2e",
      ...{ command: process.execPath, args: ["scripts/testing/release.mjs", "--describe-artifact", "--output", "{results}/artifact.json"] },
    });
    steps.push({
      name: "list e2e",
      job: "e2e",
      env: listEnv,
      stdoutTo: "e2e.playwright-list.json",
      ...npx(["playwright", "test", "--list", "--reporter=json", ...e2e]),
    });
    steps.push({ name: "reset before E2E", job: "e2e", destructive: true, ...npx(["supabase", "db", "reset"]) });
    steps.push({
      name: e2e.length > 0 ? "e2e (selected)" : "e2e",
      job: "e2e",
      destructive: true,
      ...npx(["playwright", "test", ...e2e]),
    });
    if (benchmarkPasses) {
      steps.push({
        name: "e2e benchmarks",
        job: "e2e",
        destructive: true,
        ...{ command: process.execPath, args: ["scripts/testing/benchmarks.mjs", "--suite", "e2e", "--results", "{results}"] },
      });
    }
  } else {
    skipped.push({ suite: "e2e", reason: "no E2E spec selected" });
  }

  for (const step of steps) {
    if (step.args.length === 0) throw new Error(`step ${step.name} has no arguments`);
  }
  return { steps, skipped };
}

function quote(arg) {
  return IS_WINDOWS && /[\s()&^|<>"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

/**
 * A step's environment. FV_BENCHMARK is set to "0" over whatever the shell and the .env files hand
 * down, so only a benchmark pass (benchmarks.mjs), which sets "1" on its own step, ever runs the
 * benchmarks. Deleting it is not enough: the test setups load .env.test.local and .env.local again
 * with dotenv, which fills in any variable that is unset, so an explicit value has to be there.
 */
/** @param {Record<string, string | undefined>} inherited @param {string} resultsDir @param {Record<string, string> | undefined} own @returns {Record<string, string | undefined>} */
export function stepEnvironment(inherited, resultsDir, own) {
  return { ...inherited, OMS_TEST_RESULTS_DIR: resultsDir, FV_BENCHMARK: "0", ...own };
}

/**
 * Runs the steps in order. Each step's time is measured, and steps with a `log` keep their output in
 * the results directory for the gate to count.
 *
 * By default the first failure stops the run. With `keepGoing`, a failure ends only its own job and
 * the other jobs still run, which is how CI's independent jobs behave; the gate still refuses. A
 * refused target check always stops everything.
 */
/** @param {any[]} steps @param {any} options @returns {{ ok: boolean, outcomes: any[] }} */
export function runSteps(steps, { root, resultsDir, keepGoing = false, guard = assertSafeTargets, spawn = spawnSync, now = () => Date.now(), print = console.log }) {
  mkdirSync(resultsDir, { recursive: true });
  const outcomes = [];
  const failedJobs = new Set();
  for (const step of steps) {
    if (failedJobs.has(step.job)) {
      outcomes.push({ name: step.name, job: step.job, ok: false, durationMs: 0, skipped: true });
      continue;
    }
    if (step.destructive || step.targets) {
      try {
        guard(`${step.name}`, { root, env: testEnvironment(root), require: step.targets ?? ["api"] });
      } catch (error) {
        outcomes.push({ name: step.name, job: step.job, ok: false, durationMs: 0, refused: error.message });
        return { ok: false, outcomes };
      }
    }
    const args = step.args.map((arg) => arg.replaceAll("{results}", resultsDir));
    print(`\n▶ ${step.name}: ${[step.command, ...args].join(" ")}`);
    const started = now();
    const shell = IS_WINDOWS && step.command !== process.execPath;
    const captured = Boolean(step.log || step.stdoutTo);
    const result = spawn(step.command, shell ? args.map(quote) : args, {
      cwd: root,
      shell,
      // The step's own variables win, so a listing step can switch off the results reporter.
      env: stepEnvironment(testEnvironment(root), resultsDir, step.env),
      stdio: captured ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const durationMs = now() - started;
    if (step.log) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      writeFileSync(join(resultsDir, step.log), output);
      print(output);
    }
    if (step.stdoutTo) {
      writeFileSync(join(resultsDir, step.stdoutTo), result.stdout ?? "");
      if (result.stderr) print(result.stderr);
    }
    const ok = !result.error && result.status === 0;
    outcomes.push({ name: step.name, job: step.job, ok, durationMs, status: result.status ?? null });
    if (!ok) {
      if (!keepGoing) return { ok: false, outcomes };
      failedJobs.add(step.job);
    }
  }
  return { ok: failedJobs.size === 0, outcomes };
}

/** GitHub's `needs` shape, from local step outcomes, so the same gate decision applies locally. */
/** @param {any[]} outcomes @param {string[]} expectedJobs @returns {Record<string, { result: string }>} */
export function jobsFromOutcomes(outcomes, expectedJobs) {
  const jobs = {};
  for (const job of expectedJobs) {
    const mine = outcomes.filter((outcome) => outcome.job === job);
    if (mine.length === 0) continue;
    jobs[job] = { result: mine.every((outcome) => outcome.ok) ? "success" : "failure" };
  }
  return jobs;
}

/** @param {any[]} outcomes @param {any[]} skipped */
export function timingReport(outcomes, skipped) {
  return {
    steps: outcomes.map((outcome) => ({
      name: outcome.name,
      job: outcome.job,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      ...(outcome.refused ? { refused: outcome.refused } : {}),
      ...(outcome.skipped ? { skipped: true } : {}),
    })),
    skipped,
    totalMs: outcomes.reduce((total, outcome) => total + outcome.durationMs, 0),
  };
}
