#!/usr/bin/env node
/**
 * `npm run check [-- --all] [--base <ref>]`
 *
 * The check to run before a pull request. It plans the working tree against the branch's base the
 * way CI will plan the pull request (enforce mode), says which lane the change is in and which
 * suites CI will hold it to, and then runs the static checks: lint, types, the unit suite and the
 * build. Those need no database and take a few minutes.
 *
 * `--all` also runs the database-backed suites the plan requires, in CI's order, against this
 * checkout's own local stack. Use it when you want the proof before pushing; CI runs the same plan
 * either way, and a push to main runs every suite.
 *
 * The base is where this branch left `origin/main` (or `main` when there is no remote), unless
 * `--base` names another commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, gitRunner, parseArgs } from "./common.mjs";
import { buildSteps, runSteps, timingReport } from "./run.mjs";
import { SUITES, runSelectCli } from "./select.mjs";

/** The commit the branch is measured from. */
/** @param {(args: string[]) => string} git @param {string | undefined} requested @returns {string} */
export function checkBase(git, requested) {
  const candidates = requested ? [requested] : ["origin/main", "main"];
  for (const ref of candidates) {
    try {
      return git(["merge-base", ref, "HEAD"]);
    } catch {
      // Try the next one: a clone without the remote still has a local main.
    }
  }
  throw new Error(`no base: none of ${candidates.join(", ")} shares history with this branch`);
}

/** What the plan will hold a pull request to, one line per suite. */
/** @param {any} plan @returns {string[]} */
export function describePlan(plan) {
  const lines = [`lane: ${plan.lane} (risk ${plan.risk})`];
  for (const suite of SUITES) {
    const run = plan.execution[suite];
    lines.push(
      run.mode === "none"
        ? `  ${suite}: not needed (${run.reason})`
        : `  ${suite}: ${run.mode === "full" ? "all" : "selected"}, ${run.files.length} of ${plan.inventory[suite].length} file(s)`,
    );
  }
  lines.push(`  migration chain: ${plan.execution.migrationChain.mode === "none" ? "not needed" : "runs"}`);
  for (const reason of plan.fullReasons.slice(0, 8)) lines.push(`  everything, because: ${reason}`);
  if (plan.fullReasons.length > 8) lines.push(`  … and ${plan.fullReasons.length - 8} more reason(s)`);
  return lines;
}

export function runCheckCli(argv, root = process.cwd(), print = console.log) {
  const args = parseArgs(argv);
  const known = new Set(["all", "base", "keep-going"]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);

  const git = gitRunner(root);
  const head = git(["rev-parse", "HEAD"]);
  const base = checkBase(git, typeof args.base === "string" ? args.base : undefined);
  const planPath = resolve(root, "oms-test/plan/check-plan.json");
  mkdirSync(resolve(root, "oms-test/plan"), { recursive: true });
  const plan = runSelectCli(["--base", base, "--head", head, "--worktree", "--mode", "enforce", "--output", planPath], root);
  for (const line of describePlan(plan)) print(line);

  // A listing exists so a gate can require every listed test to have run. Nothing here is gated,
  // and listing the unit suite takes as long as running it, so the listings are left out.
  const { steps: planned, skipped } = buildSteps(plan, "local");
  const steps = planned.filter((step) => !step.name.startsWith("list "));
  const chosen = args.all === true ? steps : steps.filter((step) => step.job === "static");
  const resultsDir = resolve(root, "oms-test/results");
  const { ok, outcomes } = runSteps(chosen, { root, resultsDir, keepGoing: args["keep-going"] === true, print });
  const timing = timingReport(outcomes, skipped);
  writeFileSync(resolve(resultsDir, "timing.json"), `${canonicalJson(timing)}\n`);
  return { ok, plan, timing, ranAll: args.all === true, left: steps.length - chosen.length };
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = runCheckCli(process.argv.slice(2));
    console.log("");
    for (const step of result.timing.steps) {
      console.log(`${step.ok ? "ok  " : "FAIL"} ${step.name} ${Math.round(step.durationMs / 1000)} s${step.refused ? ` — ${step.refused}` : ""}`);
    }
    if (!result.ranAll && result.left > 0) {
      console.log(`\nCI runs the rest of this plan on the pull request. To run it here first: npm run check -- --all`);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`check refused: ${error.message}`);
    process.exit(2);
  }
}
