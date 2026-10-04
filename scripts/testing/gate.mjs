#!/usr/bin/env node
/**
 * `npm run test:gate -- --plan <plan.json> --results <dir> [--jobs <needs.json>] [--base-plan <plan.json>]
 *                       [--head <sha>] [--gate "Development Gate"] [--summary <file>] [--report <file>]`
 *
 * The one decision behind both required checks, Development Gate and Release Gate. It passes only
 * when it can see, for itself, that everything the plan requires ran and passed:
 *
 *   - the plan is well formed, unaltered, made by this checkout's selector and for this head;
 *   - every expected job finished with success (failed, cancelled, skipped, timed out and absent
 *     are all refusals);
 *   - every required test file ran, on every responsive project for E2E, with at least one passing
 *     test per suite, no failure, and no skip that is not on the reviewed list;
 *   - shards, if any, all arrived and do not overlap;
 *   - the migration chain still runs every counterexample, and pgTAP every file.
 *
 * Coverage the approved base requires is required here too, whatever the head's own plan says: a
 * pull request cannot shrink its own gate by shipping a smaller plan. While the base has no selector
 * (this transition), that minimum is the full inventory.
 *
 * Retries that rescued a test are not failures, but each one is listed: a green retry is a
 * reliability finding until someone explains the first failure.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLAN_SCHEMA_VERSION, RESPONSIVE_PROJECTS, canonicalJson, parseArgs, readJson, selectorDigest } from "./common.mjs";
import { readResults } from "./reports.mjs";
import { EXPECTED_JOBS, SUITES, planDigest } from "./select.mjs";

const REPORTED_SUITES = [...SUITES, "migrationChain"];

/** Which job must have produced each suite's report. */
export const SUITE_JOB = { unit: "static", integration: "integration", e2e: "e2e", pgtap: "database", migrationChain: "database" };

/** An exact string, or a `/regular expression/`. */
function textMatches(pattern, value) {
  if (pattern.length > 1 && pattern.startsWith("/") && pattern.endsWith("/")) return new RegExp(pattern.slice(1, -1)).test(value);
  return pattern === value;
}

/** @param {any} entry @param {any} test */
export function skipMatches(entry, test) {
  if (entry.suite !== test.suite || !textMatches(entry.file, test.file)) return false;
  if (entry.projects && entry.projects !== "*" && !entry.projects.includes(test.project)) return false;
  return textMatches(entry.title, test.title);
}

/**
 * The pure decision.
 *
 *   plan        the head's plan (parsed), or null when it is missing or unreadable
 *   basePlan    the approved base's plan, or null when the base has no selector
 *   jobs        { jobName: { result } } as GitHub's `needs` context reports it
 *   reports     normalised reports (reports.mjs)
 *   knownSkips  the reviewed skip list
 *   expect      { head, selectorDigest } this checkout and event say the plan must match
 *   gate        "Development Gate" or "Release Gate"
 */
/** @param {any} options @returns {any} */
export function evaluateGate({ plan, basePlan = null, jobs = {}, reports = [], reportProblems = [], knownSkips = [], expect = {}, gate = "Development Gate" }) {
  const refusals = [];
  const warnings = [];

  if (!plan) {
    return { pass: false, gate, refusals: ["no plan: the planner did not produce one"], warnings, summary: {} };
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) refusals.push(`plan schema ${plan.schemaVersion} is not ${PLAN_SCHEMA_VERSION}`);
  if (plan.digest !== planDigest(plan)) refusals.push("plan digest does not match its contents: the plan was altered or is malformed");
  if (!plan.execution || !plan.inventory) {
    return { pass: false, gate, refusals: [...refusals, "plan has no execution or inventory"], warnings, summary: {} };
  }
  if (expect.selectorDigest && plan.selector?.selectorDigest !== expect.selectorDigest) {
    refusals.push("plan is stale: it was made by a different selector or manifest than this checkout holds");
  }
  if (expect.head && plan.identity?.head !== expect.head) {
    refusals.push(`plan is for head ${plan.identity?.head ?? "(none)"}, but this run tests ${expect.head}`);
  }
  if (expect.head && plan.identity?.executedCommit && plan.identity.executedCommit !== expect.head) {
    refusals.push(`plan was made on ${plan.identity.executedCommit}, not on ${expect.head}`);
  }
  if (gate === "Release Gate" && plan.mode !== "full") refusals.push("a Release Gate requires a full plan");

  // The minimum is whatever the base requires, or everything when the base has no selector yet.
  const required = {};
  for (const suite of SUITES) {
    const own = plan.execution[suite]?.files ?? [];
    const minimum = basePlan ? (basePlan.execution?.[suite]?.files ?? plan.inventory[suite]) : plan.inventory[suite];
    required[suite] = [...new Set([...own, ...minimum])].sort();
    if (required[suite].length > own.length) {
      warnings.push(`${suite}: the approved base requires ${required[suite].length - own.length} file(s) the head plan left out; they are required anyway`);
    }
  }

  for (const job of [...new Set([...EXPECTED_JOBS, ...(plan.expectedJobs ?? [])])]) {
    const result = jobs[job]?.result;
    if (!result) refusals.push(`job ${job} is absent`);
    else if (result !== "success") refusals.push(`job ${job} finished as ${result}`);
  }
  if (jobs.plan && jobs.plan.result !== "success") refusals.push(`job plan finished as ${jobs.plan.result}`);

  refusals.push(...reportProblems);

  const bySuite = Object.fromEntries(REPORTED_SUITES.map((suite) => [suite, reports.filter((report) => report.suite === suite)]));
  const summary = {};
  for (const suite of REPORTED_SUITES) {
    const suiteReports = bySuite[suite];
    if (suiteReports.length === 0) {
      refusals.push(`${suite}: no report arrived from job ${SUITE_JOB[suite]}`);
      continue;
    }

    const shards = suiteReports.filter((report) => report.shard);
    if (shards.length > 0) {
      const total = shards[0].shard.total;
      const seen = new Set(shards.map((report) => report.shard.index));
      for (let index = 1; index <= total; index++) if (!seen.has(index)) refusals.push(`${suite}: shard ${index} of ${total} is missing`);
      if (shards.some((report) => report.shard.total !== total)) refusals.push(`${suite}: shards disagree on the shard count`);
      if (shards.length !== suiteReports.length) refusals.push(`${suite}: sharded and unsharded reports are mixed`);
    } else if (suiteReports.length > 1) {
      refusals.push(`${suite}: ${suiteReports.length} unsharded reports; expected one`);
    }

    const tests = suiteReports.flatMap((report) => report.tests);
    const ids = new Map();
    for (const test of tests) ids.set(test.id, (ids.get(test.id) ?? 0) + 1);
    const overlapping = [...ids].filter(([, count]) => count > 1).map(([id]) => id);
    // Two identical titles in one file are the suite's own business, not overlap, unless shards ran.
    if (shards.length > 0 && overlapping.length > 0) refusals.push(`${suite}: ${overlapping.length} test(s) reported by more than one shard`);

    const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
    for (const test of tests) counts[test.status] += 1;
    summary[suite] = {
      ...counts,
      total: tests.length,
      retries: tests.reduce((total, test) => total + test.retries, 0),
      durationMs: suiteReports.reduce((total, report) => total + (report.durationMs ?? 0), 0) || null,
      assertions: suiteReports.find((report) => report.assertions != null)?.assertions ?? null,
    };

    if (counts.passed + counts.flaky === 0) refusals.push(`${suite}: no test passed (zero-test success is refused)`);
    if (counts.failed > 0) {
      const names = tests.filter((test) => test.status === "failed").slice(0, 10).map((test) => test.id);
      refusals.push(`${suite}: ${counts.failed} failed: ${names.join("; ")}${counts.failed > 10 ? "; …" : ""}`);
    }
    if (suiteReports.some((report) => report.runnerSuccess === false) && counts.failed === 0) {
      refusals.push(`${suite}: the runner reported failure (a setup or load error outside any single test)`);
    }
    for (const test of tests.filter((entry) => entry.status === "skipped")) {
      if (!knownSkips.some((entry) => skipMatches(entry, test))) refusals.push(`${suite}: unexplained skip ${test.id}`);
    }
    for (const test of tests.filter((entry) => entry.status === "flaky" || (entry.status === "passed" && entry.retries > 0))) {
      warnings.push(`${suite}: ${test.id} passed only on retry ${test.retries}; record why the first attempt failed`);
    }

    if (suite === "migrationChain") {
      const minimum = plan.minimums?.migrationChainCounterexamples ?? 0;
      if (tests.length < minimum) refusals.push(`migrationChain: ${tests.length} counterexamples ran; at least ${minimum} are required`);
      continue;
    }

    const files = new Set(tests.map((test) => test.file));
    for (const file of required[suite]) {
      if (!files.has(file)) refusals.push(`${suite}: required file ${file} did not run`);
    }
    if (suite === "e2e") {
      const projects = plan.execution.projects ?? RESPONSIVE_PROJECTS;
      for (const project of RESPONSIVE_PROJECTS) {
        if (!projects.includes(project)) refusals.push(`e2e: the plan drops the ${project} project`);
      }
      for (const file of required.e2e) {
        for (const project of projects) {
          if (!tests.some((test) => test.file === file && test.project === project)) {
            refusals.push(`e2e: ${file} did not run on ${project}`);
          }
        }
      }
    }
    if (suite === "pgtap" && plan.minimums?.pgtapFiles && files.size < plan.minimums.pgtapFiles) {
      refusals.push(`pgtap: ${files.size} files ran; at least ${plan.minimums.pgtapFiles} are required`);
    }
  }

  // Shadow comparison: a failing test the selection would have left out is the one thing that
  // blocks activating selection. It is recorded on every run, pass or fail.
  const omissions = [];
  for (const suite of SUITES) {
    const selected = new Set(plan.selection?.[suite]?.files ?? []);
    for (const test of bySuite[suite]?.flatMap((report) => report.tests) ?? []) {
      if ((test.status === "failed" || test.status === "flaky") && !selected.has(test.file)) omissions.push(test.id);
    }
  }

  return {
    pass: refusals.length === 0,
    gate,
    refusals,
    warnings,
    summary,
    shadow: {
      risk: plan.risk,
      fullReasons: plan.fullReasons ?? [],
      selected: Object.fromEntries(SUITES.map((suite) => [suite, plan.selection?.[suite]?.files?.length ?? null])),
      inventory: Object.fromEntries(SUITES.map((suite) => [suite, plan.inventory[suite].length])),
      omissions,
    },
  };
}

/** @param {any} decision @returns {string} */
export function renderSummary(decision) {
  const lines = [`## ${decision.gate}: ${decision.pass ? "PASS" : "REFUSED"}`, ""];
  if (decision.refusals.length > 0) {
    lines.push("### Refused because", "", ...decision.refusals.map((line) => `- ${line}`), "");
  }
  if (Object.keys(decision.summary).length > 0) {
    lines.push("### Suites", "", "| Suite | Passed | Failed | Skipped | Flaky | Retries | Time |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const [suite, s] of Object.entries(decision.summary)) {
      const time = s.durationMs ? `${Math.round(s.durationMs / 1000)} s` : "not measured";
      lines.push(`| ${suite} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.flaky} | ${s.retries} | ${time} |`);
    }
    lines.push("");
  }
  if (decision.shadow) {
    lines.push(
      "### Shadow selection",
      "",
      `Risk ${decision.shadow.risk}. The selection would have run:`,
      "",
      ...Object.entries(decision.shadow.selected).map(([suite, count]) => `- ${suite}: ${count} of ${decision.shadow.inventory[suite]}`),
      "",
      decision.shadow.omissions.length === 0
        ? "No failing test fell outside the selection."
        : `Failing tests the selection would have missed: ${decision.shadow.omissions.join("; ")}`,
      "",
    );
    if (decision.shadow.fullReasons.length > 0) {
      lines.push("Full because:", "", ...decision.shadow.fullReasons.slice(0, 20).map((line) => `- ${line}`), "");
    }
  }
  if (decision.warnings.length > 0) lines.push("### Warnings", "", ...decision.warnings.map((line) => `- ${line}`), "");
  return `${lines.join("\n")}\n`;
}

function readOptionalJson(path) {
  if (!path || path === true || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function runGateCli(argv, root = process.cwd(), env = process.env) {
  const args = parseArgs(argv);
  const known = new Set(["plan", "results", "jobs", "base-plan", "head", "gate", "summary", "report", "known-skips"]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  if (typeof args.results !== "string") throw new Error("--results <dir> is required");

  const plan = readOptionalJson(args.plan);
  const basePlan = readOptionalJson(args["base-plan"]);
  const jobs = typeof args.jobs === "string" ? readOptionalJson(args.jobs) ?? {} : JSON.parse(env.OMS_GATE_NEEDS ?? "{}");
  const { reports, problems } = readResults(args.results, root);
  const knownSkips = readJson(typeof args["known-skips"] === "string" ? args["known-skips"] : resolve(root, "scripts/testing/known-skips.json")).skips;

  const decision = evaluateGate({
    plan,
    basePlan,
    jobs,
    reports,
    reportProblems: problems,
    knownSkips,
    expect: { head: typeof args.head === "string" ? args.head : undefined, selectorDigest: selectorDigest(root) },
    gate: typeof args.gate === "string" ? args.gate : "Development Gate",
  });

  const summary = renderSummary(decision);
  if (typeof args.summary === "string") appendFileSync(args.summary, summary);
  if (typeof args.report === "string") writeFileSync(args.report, `${canonicalJson(decision)}\n`);
  return { decision, summary };
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const { decision, summary } = runGateCli(process.argv.slice(2));
    console.log(summary);
    process.exit(decision.pass ? 0 : 1);
  } catch (error) {
    console.error(`test:gate refused: ${error.message}`);
    process.exit(2);
  }
}
