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
 *   5. integration, behind its own reset (one bootstrap per database);
 *   6. build, then E2E behind its own reset.
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
 *   local        what the plan's SELECTION needs: lint, types, the selected unit files, and real
 *                database, HTTP and E2E proof only where the selection reaches them
 *   development  what the plan's EXECUTION requires, in the CI job order (full while in shadow)
 *   release      everything, always, whatever the plan says
 */
/** @param {any} plan @param {string} tier @param {{ benchmarks?: boolean }} [options] @returns {{ steps: any[], skipped: Array<{ suite: string, reason: string }> }} */
export function buildSteps(plan, tier, { benchmarks = false } = {}) {
  if (!["local", "development", "release"].includes(tier)) throw new Error(`unknown tier ${tier}`);
  const source = tier === "local" ? plan.selection : plan.execution;
  const full = (suite) => tier === "release" || source[suite]?.mode === "full";
  const files = (suite) => (tier === "release" ? plan.inventory[suite] : source[suite]?.files ?? []);
  const benchmarkEnv = benchmarks ? { FV_BENCHMARK: "1" } : {};
  const steps = [];
  const skipped = [];

  steps.push({ name: "lint", job: "static", ...npm(["run", "lint"]) });
  steps.push({ name: "typecheck", job: "static", ...npm(["run", "typecheck"]) });

  if (tier !== "local" || full("unit")) {
    steps.push({ name: "unit", job: "static", ...npx(["vitest", "run", "--project", "unit"]) });
  } else if (files("unit").length > 0) {
    steps.push({ name: "unit (selected)", job: "static", ...npx(["vitest", "run", "--project", "unit", ...files("unit")]) });
  } else {
    skipped.push({ suite: "unit", reason: "no unit test selected" });
  }

  const database = tier !== "local" || plan.risk === "high";
  if (tier !== "local") steps.push({ name: "build", job: "static", ...npm(["run", "build"]) });

  if (database) {
    steps.push({ name: "migration chain", job: "database", destructive: true, targets: [], log: "migration-chain.log", ...npm(["run", "test:migration-chain"]) });
    steps.push({ name: "reset before pgTAP", job: "database", destructive: true, targets: [], ...npx(["supabase", "db", "reset"]) });
    steps.push({ name: "pgTAP", job: "database", destructive: true, targets: [], log: "pgtap.log", ...npx(["supabase", "test", "db"]) });
    steps.push({ name: "database lint", job: "database", targets: [], ...npx(["supabase", "db", "lint", "--level", "warning"]) });
    steps.push({ name: "advisors", job: "database", targets: [], ...{ command: process.execPath, args: ["scripts/run-advisors.mjs"] } });
  } else {
    skipped.push({ suite: "pgtap", reason: "local tier runs the database suites only for high-risk plans" });
    skipped.push({ suite: "migrationChain", reason: "local tier runs the database suites only for high-risk plans" });
  }

  const integration = files("integration");
  if (full("integration") || integration.length > 0) {
    steps.push({ name: "reset before integration", job: "integration", destructive: true, ...npx(["supabase", "db", "reset"]) });
    steps.push({
      name: full("integration") ? "integration" : "integration (selected)",
      job: "integration",
      destructive: true,
      env: { ...benchmarkEnv },
      ...npx(["vitest", "run", "--project", "integration", ...(full("integration") ? [] : integration)]),
    });
  } else {
    skipped.push({ suite: "integration", reason: "no integration test selected" });
  }

  const e2e = files("e2e");
  if (full("e2e") || e2e.length > 0) {
    if (tier === "local") steps.push({ name: "build", job: "e2e", ...npm(["run", "build"]) });
    steps.push({ name: "reset before E2E", job: "e2e", destructive: true, ...npx(["supabase", "db", "reset"]) });
    steps.push({
      name: full("e2e") ? "e2e" : "e2e (selected)",
      job: "e2e",
      destructive: true,
      env: { ...benchmarkEnv },
      ...npx(["playwright", "test", ...(full("e2e") ? [] : e2e)]),
    });
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
 * Runs the steps in order and stops at the first failure. Each step's time is measured, and steps
 * with a `log` keep their output in the results directory for the gate to count.
 */
/** @param {any[]} steps @param {any} options @returns {{ ok: boolean, outcomes: any[] }} */
export function runSteps(steps, { root, resultsDir, guard = assertSafeTargets, spawn = spawnSync, now = () => Date.now(), print = console.log }) {
  mkdirSync(resultsDir, { recursive: true });
  const outcomes = [];
  for (const step of steps) {
    if (step.destructive || step.targets) {
      try {
        guard(`${step.name}`, { root, env: testEnvironment(root), require: step.targets ?? ["api"] });
      } catch (error) {
        outcomes.push({ name: step.name, job: step.job, ok: false, durationMs: 0, refused: error.message });
        return { ok: false, outcomes };
      }
    }
    print(`\n▶ ${step.name}: ${[step.command, ...step.args].join(" ")}`);
    const started = now();
    const shell = IS_WINDOWS && step.command !== process.execPath;
    const result = spawn(shell ? step.command : step.command, shell ? step.args.map(quote) : step.args, {
      cwd: root,
      shell,
      env: { ...testEnvironment(root), ...step.env, OMS_TEST_RESULTS_DIR: resultsDir },
      stdio: step.log ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const durationMs = now() - started;
    if (step.log) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      writeFileSync(join(resultsDir, step.log), output);
      print(output);
    }
    const ok = !result.error && result.status === 0;
    outcomes.push({ name: step.name, job: step.job, ok, durationMs, status: result.status ?? null });
    if (!ok) return { ok: false, outcomes };
  }
  return { ok: true, outcomes };
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
    steps: outcomes.map(({ name, job, ok, durationMs, refused }) => ({ name, job, ok, durationMs, ...(refused ? { refused } : {}) })),
    skipped,
    totalMs: outcomes.reduce((total, outcome) => total + outcome.durationMs, 0),
  };
}
