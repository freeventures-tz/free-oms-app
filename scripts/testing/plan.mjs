#!/usr/bin/env node
/**
 * `npm run test:plan -- --plan <plan.json> --tier local|development [--results <dir>] [--dry-run]`
 *
 * Runs what a plan says, after proving the plan belongs to this checkout: unaltered, made by this
 * selector and manifest, on this commit and (for a plan made with --worktree) this working tree.
 * A plan that fails any of those is refused before a single command runs.
 *
 * The development tier finishes with the same gate decision CI makes, so a local run and a CI run
 * are judged by one function. Timings for every step go to `<results>/timing.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLAN_SCHEMA_VERSION, canonicalJson, gitRunner, parseArgs, readJson, selectorDigest } from "./common.mjs";
import { evaluateGate, renderSummary } from "./gate.mjs";
import { readResults } from "./reports.mjs";
import { buildSteps, jobsFromOutcomes, runSteps, timingReport } from "./run.mjs";
import { collectIdentity, planDigest } from "./select.mjs";

/** Every reason this checkout may not run this plan. Empty means it may. */
/** @param {any} plan @param {{ head: string, digest: string, worktreeDigest: string | null, dirty?: boolean }} context @returns {string[]} */
export function planRefusals(plan, { head, digest, worktreeDigest, dirty = false }) {
  const refusals = [];
  if (plan?.schemaVersion !== PLAN_SCHEMA_VERSION) refusals.push(`plan schema ${plan?.schemaVersion} is not ${PLAN_SCHEMA_VERSION}`);
  if (!plan || plan.digest !== planDigest(plan)) refusals.push("plan digest does not match its contents");
  if (plan?.selector?.selectorDigest !== digest) refusals.push("plan is stale: this checkout's selector or manifest differs");
  if (plan?.identity?.executedCommit !== head) {
    refusals.push(`plan was made on ${plan?.identity?.executedCommit ?? "(unknown)"}, but this checkout is at ${head}`);
  }
  if (plan?.identity?.worktreeDigest && plan.identity.worktreeDigest !== worktreeDigest) {
    refusals.push("the working tree changed after the plan was made");
  }
  // A plan made without --worktree names a commit, so the files run must be that commit's files.
  if (!plan?.identity?.worktreeDigest && dirty) {
    refusals.push("the working tree has changes the plan's commit does not hold: commit them, or plan with --worktree");
  }
  return refusals;
}

export function runPlanCli(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const known = new Set(["plan", "tier", "results", "dry-run", "benchmarks", "keep-going"]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  if (typeof args.plan !== "string") throw new Error("--plan <plan.json> is required");
  if (args.tier !== "local" && args.tier !== "development") throw new Error("--tier must be local or development");

  const plan = readJson(args.plan);
  const git = gitRunner(root);
  const head = git(["rev-parse", "HEAD"]);
  const worktreeDigest = plan.identity?.worktreeDigest
    ? collectIdentity({
        git,
        base: plan.identity.base,
        head: plan.identity.head,
        worktree: true,
        readFile: (path) => readFileSync(resolve(root, path)),
      }).identity.worktreeDigest
    : null;
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "";
  const refusals = planRefusals(plan, { head, digest: selectorDigest(root), worktreeDigest, dirty });
  if (refusals.length > 0) throw new Error(refusals.join("; "));

  const { steps, skipped } = buildSteps(plan, args.tier, { benchmarks: args.benchmarks === true });
  if (args["dry-run"] === true) return { dryRun: true, steps, skipped };

  const resultsDir = resolve(root, typeof args.results === "string" ? args.results : "oms-test/results");
  const { ok, outcomes } = runSteps(steps, { root, resultsDir, keepGoing: args["keep-going"] === true });
  const timing = timingReport(outcomes, skipped);
  writeFileSync(resolve(resultsDir, "timing.json"), `${canonicalJson(timing)}\n`);

  let decision = null;
  if (args.tier === "development") {
    const { reports, listings, artifact, problems } = readResults(resultsDir, root);
    decision = evaluateGate({
      plan,
      // The plan was validated above, which is the local planner job.
      jobs: { plan: { result: "success" }, ...jobsFromOutcomes(outcomes, plan.expectedJobs) },
      reports,
      listings,
      artifact,
      reportProblems: problems,
      knownSkips: readJson(resolve(root, "scripts/testing/known-skips.json")).skips,
      expect: { head, selectorDigest: selectorDigest(root) },
    });
    writeFileSync(resolve(resultsDir, "gate-report.json"), `${canonicalJson(decision)}\n`);
  }
  return { ok: ok && (decision ? decision.pass : true), outcomes, skipped, timing, decision };
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = runPlanCli(process.argv.slice(2));
    if (result.dryRun) {
      for (const step of result.steps) console.log(`${step.destructive ? "!" : " "} ${step.name}: ${[step.command, ...step.args].join(" ")}`);
      for (const skip of result.skipped) console.log(`  skipped ${skip.suite}: ${skip.reason}`);
      process.exit(0);
    }
    for (const step of result.timing.steps) {
      if (step.skipped) {
        console.log(`skip ${step.name}: job ${step.job} had already failed`);
        continue;
      }
      console.log(`${step.ok ? "ok  " : "FAIL"} ${step.name} ${Math.round(step.durationMs / 1000)} s${step.refused ? ` — ${step.refused}` : ""}`);
    }
    for (const skip of result.skipped) console.log(`skip ${skip.suite}: ${skip.reason}`);
    if (result.decision) console.log(renderSummary(result.decision));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`test:plan refused: ${error.message}`);
    process.exit(2);
  }
}
