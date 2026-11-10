/**
 * Turns each runner's own output into one shape the gate can count.
 *
 * A results directory holds files named for their suite and format:
 *
 *   unit.vitest.json, integration.vitest.json      Vitest's JSON reporter
 *   e2e.playwright.json                            Playwright's JSON reporter
 *   e2e.playwright.shard-2-of-3.json               one shard of a sharded run
 *   pgtap.log                                      `supabase test db` output (pg_prove)
 *   migration-chain.log                            `npm run test:migration-chain` output
 *   migration-chain.shard-2-of-4.log               one shard of the chain's proofs (`--shard 2/4`)
 *   unit.vitest-list.json, integration.vitest-list.json, e2e.playwright-list.json
 *                                                  the tests each runner listed before running
 *   e2e.playwright-list.shard-2-of-3.json          one shard's listing; a suite's listings add up
 *   artifact.json                                  the build the E2E job tested (release.mjs)
 *   e2e-benchmark-<name>.playwright.json, integration-benchmark.vitest.json
 *                                                  an isolated benchmark pass (benchmarks.mjs)
 *
 * Every test becomes { id, suite, file, project, title, status, retries, durationMs } with status
 * one of passed, failed, skipped or flaky (passed only on a retry). A file that cannot be parsed is
 * a refusal, not an empty report.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { toPosix } from "./common.mjs";

const NAME = /^(unit|integration|e2e|pgtap|migration-chain)\.(vitest\.json|playwright\.json|log)$|^(e2e)\.playwright\.shard-(\d+)-of-(\d+)\.json$/;
const CHAIN_SHARD = /^migration-chain\.shard-(\d+)-of-(\d+)\.log$/;

function repoPath(root, path) {
  const posix = toPosix(isAbsolute(path) ? relative(root, path) : path);
  return posix.replace(/^\.\//, "");
}

/** @param {string} suite @param {any} json @param {string} root @returns {any} */
export function normaliseVitest(suite, json, root) {
  const tests = [];
  for (const file of json.testResults ?? []) {
    const path = repoPath(root, file.name);
    for (const result of file.assertionResults ?? []) {
      const title = [...(result.ancestorTitles ?? []), result.title].join(" > ");
      const status =
        result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "skipped";
      tests.push({
        id: `${suite}:${path}:${title}`,
        suite,
        file: path,
        project: null,
        title,
        status,
        retries: Math.max(0, (result.retryCount ?? 0)),
        durationMs: Math.round(result.duration ?? 0),
      });
    }
    // A file that failed to load has no assertion results at all; it must still count as a failure.
    if ((file.assertionResults ?? []).length === 0 && file.status === "failed") {
      tests.push({
        id: `${suite}:${path}:(file failed to run)`,
        suite,
        file: path,
        project: null,
        title: "(file failed to run)",
        status: "failed",
        retries: 0,
        durationMs: 0,
      });
    }
  }
  const starts = (json.testResults ?? []).map((file) => file.startTime).filter(Number.isFinite);
  const ends = (json.testResults ?? []).map((file) => file.endTime).filter(Number.isFinite);
  return {
    suite,
    shard: null,
    tests,
    durationMs: Number.isFinite(json.wallMs) ? json.wallMs : starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null,
    runnerSuccess: json.success === true,
  };
}

/** @param {any} json @param {{ index: number, total: number } | null} [shard] @returns {any} */
export function normalisePlaywright(json, shard = null) {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const file = `e2e/${toPosix(spec.file ?? suite.file)}`;
      for (const test of spec.tests ?? []) {
        const title = [...titles, spec.title].join(" > ");
        const results = test.results ?? [];
        const status =
          test.status === "expected"
            ? "passed"
            : test.status === "flaky"
              ? "flaky"
              : test.status === "skipped"
                ? "skipped"
                : "failed";
        tests.push({
          id: `e2e:${file}:${test.projectName}:${title}`,
          suite: "e2e",
          file,
          project: test.projectName,
          title,
          status,
          retries: Math.max(0, results.length - 1),
          durationMs: results.reduce((total, result) => total + (result.duration ?? 0), 0),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.title && !child.title.endsWith(".ts") ? [...titles, child.title] : titles);
  };
  for (const suite of json.suites ?? []) walk(suite, []);
  return {
    suite: "e2e",
    shard,
    tests,
    durationMs: Number.isFinite(json.stats?.duration) ? Math.round(json.stats.duration) : null,
    runnerSuccess: (json.stats?.unexpected ?? 1) === 0 && (json.errors ?? []).length === 0,
  };
}

/**
 * pg_prove prints one line per file (`.../001_authorization.sql .. ok`) and a summary
 * (`Files=28, Tests=1886, ...` then `Result: PASS`). Each FILE becomes one test here; its assertion
 * count comes from the summary.
 */
/** @param {string} text @returns {any} */
export function normalisePgTap(text) {
  const tests = [];
  for (const match of text.matchAll(/(supabase\/tests\/database\/[\w.-]+\.sql|[\w.-]+\.sql)\s+\.+\s*(.*)$/gm)) {
    const name = match[1].includes("/") ? match[1] : `supabase/tests/database/${match[1]}`;
    const outcome = match[2].trim();
    const status = /^ok\b/.test(outcome) ? (/skipped/i.test(outcome) ? "skipped" : "passed") : "failed";
    tests.push({ id: `pgtap:${name}`, suite: "pgtap", file: name, project: null, title: name, status, retries: 0, durationMs: 0 });
  }
  const summary = text.match(/Files=(\d+),\s*Tests=(\d+)/);
  const result = text.match(/Result:\s*(PASS|FAIL)/);
  return {
    suite: "pgtap",
    shard: null,
    tests,
    assertions: summary ? Number(summary[2]) : null,
    durationMs: null,
    runnerSuccess: result?.[1] === "PASS",
  };
}

/**
 * Each counterexample the harness announces is one test; PASS on the last line is the verdict. A
 * shard's tests carry the shard in their IDs, because the same counterexample name recurs in many
 * phases and two shards may each hold their own first one.
 */
/** @param {string} text @param {{ index: number, total: number } | null} [shard] @returns {any} */
export function normaliseMigrationChain(text, shard = null) {
  const tests = [];
  const prefix = shard ? `migration-chain:${shard.index}/${shard.total}` : "migration-chain";
  for (const match of text.matchAll(/^--- counterexample: (.+?) ---$/gm)) {
    tests.push({
      id: `${prefix}:${tests.length + 1}:${match[1]}`,
      suite: "migrationChain",
      file: "scripts/migration-chain-check.mjs",
      project: null,
      title: match[1],
      status: "passed",
      retries: 0,
      durationMs: 0,
    });
  }
  const passed = /^migration-chain: PASS$/m.test(text);
  if (!passed) for (const test of tests) test.status = "failed";
  return { suite: "migrationChain", shard, tests, durationMs: null, runnerSuccess: passed };
}

/**
 * The test IDs a runner says exist, before anything runs: `vitest list --json` (an array of
 * `{ name, file }`, name already joined with " > ") or `playwright test --list --reporter=json`.
 * The IDs use the same form as the run reports, so the gate can require every listed test to have
 * run.
 */
/** @param {string} suite @param {any} json @param {string} root @returns {Set<string>} */
export function listedIds(suite, json, root) {
  if (suite === "e2e") return new Set(normalisePlaywright(json).tests.map((test) => test.id));
  if (!Array.isArray(json)) throw new Error("a Vitest listing is an array");
  return new Set(json.map((entry) => `${suite}:${repoPath(root, entry.file)}:${entry.name}`));
}

const LISTING = /^(unit|integration)\.vitest-list\.json$|^(e2e)\.playwright-list(?:\.shard-\d+-of-\d+)?\.json$/;

/**
 * Reads every report in a directory. Returns the run reports, the listings by suite, the recorded
 * build artifact (artifact.json, written by the E2E job after its build), and every problem.
 */
/** @param {string} dir @param {string} root @returns {{ reports: any[], listings: Record<string, Set<string>>, artifact: any, problems: string[] }} */
export function readResults(dir, root) {
  const reports = [];
  /** @type {Record<string, Set<string>>} */
  const listings = {};
  let artifact = null;
  const problems = [];
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    return { reports, listings, artifact, problems: [`results directory ${dir} cannot be read: ${error.message}`] };
  }
  for (const name of names) {
    const listing = name.match(LISTING);
    if (listing) {
      const suite = listing[1] ?? listing[2];
      try {
        // Each E2E shard lists its own specs, so a suite's listings are added together.
        const listed = listedIds(suite, JSON.parse(readFileSync(join(dir, name), "utf8")), root);
        listings[suite] = new Set([...(listings[suite] ?? []), ...listed]);
      } catch (error) {
        problems.push(`${name} cannot be parsed: ${error.message}`);
      }
      continue;
    }
    // Benchmark passes (benchmarks.mjs): their tests keep the main suite's IDs, marked as benchmarks.
    const benchmark = name.match(/^e2e-benchmark-[\w.-]+\.playwright\.json$|^integration-benchmark\.vitest\.json$/);
    if (benchmark) {
      try {
        const json = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const report = name.startsWith("e2e") ? normalisePlaywright(json) : normaliseVitest("integration", json, root);
        reports.push({ ...report, benchmark: true, source: name });
      } catch (error) {
        problems.push(`${name} cannot be parsed: ${error.message}`);
      }
      continue;
    }
    if (name === "artifact.json") {
      try {
        artifact = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (error) {
        problems.push(`${name} cannot be parsed: ${error.message}`);
      }
      continue;
    }
    const chainShard = name.match(CHAIN_SHARD);
    if (chainShard) {
      reports.push(normaliseMigrationChain(readFileSync(join(dir, name), "utf8"), { index: Number(chainShard[1]), total: Number(chainShard[2]) }));
      continue;
    }
    const match = name.match(NAME);
    if (!match) continue;
    const text = readFileSync(join(dir, name), "utf8");
    try {
      if (match[4]) {
        reports.push(normalisePlaywright(JSON.parse(text), { index: Number(match[4]), total: Number(match[5]) }));
      } else if (match[2] === "vitest.json") {
        reports.push(normaliseVitest(match[1], JSON.parse(text), root));
      } else if (match[2] === "playwright.json") {
        reports.push(normalisePlaywright(JSON.parse(text)));
      } else if (match[1] === "pgtap") {
        reports.push(normalisePgTap(text));
      } else if (match[1] === "migration-chain") {
        reports.push(normaliseMigrationChain(text));
      } else {
        problems.push(`${name} is not a recognised report`);
      }
    } catch (error) {
      problems.push(`${name} cannot be parsed: ${error.message}`);
    }
  }
  return { reports, listings, artifact, problems };
}
