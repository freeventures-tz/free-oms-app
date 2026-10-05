#!/usr/bin/env node
/**
 * `node scripts/testing/benchmarks.mjs --suite e2e|integration [--results <dir>]`
 *
 * Runs the opt-in performance benchmarks the way each spec documents: one benchmark file at a
 * time, after its own database reset, with `FV_BENCHMARK=1`, and (for E2E) on the mobile project
 * only, filtered to the benchmark block. Each pass writes its own results file
 * (`e2e-benchmark-<name>.playwright.json`, `integration-benchmark.vitest.json`).
 *
 * The benchmarks are never switched on inside the main suite. They take many samples and leave the
 * records behind, and the suites share one database, so later specs would read state they never
 * made. The Release Gate accepts a benchmark skipped in the main run only when the same test
 * passed in its isolated pass here.
 *
 * The reviewed list of benchmark files is `benchmarks` in scripts/testing/manifest.json.
 */
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, readJson } from "./common.mjs";
import { runSteps } from "./run.mjs";

/** The steps for one suite's benchmark passes: a reset, then the file alone, per benchmark file. */
/** @param {any} manifest @param {string} suite @returns {any[]} */
export function benchmarkSteps(manifest, suite) {
  const entries = manifest?.benchmarks?.[suite];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`the manifest lists no ${suite} benchmarks`);
  const steps = [];
  for (const entry of entries) {
    const name = basename(entry.file).replace(/\.(spec|test)\.ts$/, "");
    steps.push({ name: `reset before benchmark ${name}`, job: `benchmark ${name}`, destructive: true, command: "npx", args: ["supabase", "db", "reset"] });
    if (suite === "e2e") {
      steps.push({
        name: `benchmark ${name}`,
        job: `benchmark ${name}`,
        destructive: true,
        env: { FV_BENCHMARK: "1", OMS_E2E_RESULTS_NAME: `e2e-benchmark-${name}.playwright.json` },
        command: "npx",
        args: ["playwright", "test", "--project=mobile", entry.file, "-g", entry.grep],
      });
    } else {
      steps.push({
        name: `benchmark ${name}`,
        job: `benchmark ${name}`,
        destructive: true,
        env: { FV_BENCHMARK: "1", OMS_TEST_SUITE: "integration-benchmark" },
        command: "npx",
        args: ["vitest", "run", "--project", "integration", entry.file],
      });
    }
  }
  return steps;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.suite !== "e2e" && args.suite !== "integration") throw new Error("--suite must be e2e or integration");
    const root = process.cwd();
    const resultsDir = resolve(root, typeof args.results === "string" ? args.results : process.env.OMS_TEST_RESULTS_DIR || "oms-test/results");
    const steps = benchmarkSteps(readJson(resolve(root, "scripts/testing/manifest.json")), args.suite);
    // Every pass runs even when one fails, so a slow benchmark does not hide the others.
    const { ok, outcomes } = runSteps(steps, { root, resultsDir, keepGoing: true });
    for (const outcome of outcomes) console.log(`${outcome.ok ? "ok  " : "FAIL"} ${outcome.name}`);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`benchmarks refused: ${error.message}`);
    process.exit(2);
  }
}
