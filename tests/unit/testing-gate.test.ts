import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateGate, renderSummary, skipMatches } from "@/scripts/testing/gate.mjs";
import {
  normaliseMigrationChain,
  normalisePgTap,
  normalisePlaywright,
  normaliseVitest,
} from "@/scripts/testing/reports.mjs";
import { selectTests } from "@/scripts/testing/select.mjs";

/**
 * The aggregate gate, fed the same report formats the runners write.
 *
 * Each case starts from a run where everything passed and breaks exactly one thing the specification
 * says must refuse the gate: a failed, skipped, cancelled or missing job; a missing, empty or
 * partial report; a failed or unexplained skipped test; a dropped device tier; a missing or
 * overlapping shard; too few migration-chain counterexamples; a stale or altered plan. A gate that
 * cannot say no has never said yes, so most of this file is about no.
 */

const HEAD = "b".repeat(40);
const ROOT = "/repo";

const manifest = {
  version: 1,
  activation: { selectiveEnforcement: false },
  suites: {
    unit: ["tests/unit/**/*.test.ts"],
    integration: ["tests/integration/**/*.test.ts"],
    e2e: ["e2e/**/*.spec.ts"],
    pgtap: ["supabase/tests/database/*.sql"],
  },
  minimums: { pgtapFiles: 2, migrationChainCounterexamples: 3 },
  forceFull: [],
  docsOnly: ["README.md"],
  domains: {},
  groups: { integration: {}, e2e: {} },
  independent: { integration: ["tests/integration/authority.test.ts"], e2e: ["e2e/shell.spec.ts", "e2e/sales.spec.ts"] },
  smoke: { pgtap: [], integration: ["tests/integration/authority.test.ts"], e2e: ["e2e/shell.spec.ts"] },
};
const files = [
  "README.md",
  "tests/unit/money.test.ts",
  "tests/unit/report.test.ts",
  "tests/integration/authority.test.ts",
  "e2e/shell.spec.ts",
  "e2e/sales.spec.ts",
  "supabase/tests/database/001_auth.sql",
  "supabase/tests/database/002_stock.sql",
];
const identity = { base: "a".repeat(40), head: HEAD, executedCommit: HEAD, proven: true, problems: [] };
const SELECTOR = "f".repeat(64);

function makePlan(overrides: Record<string, unknown> = {}) {
  return selectTests({
    manifest,
    files,
    edges: new Map(),
    changes: [{ status: "M", path: "README.md" }],
    identity,
    selector: { selectorDigest: SELECTOR },
    ...overrides,
  });
}

function vitestJson(entries: Array<[string, string, string?]>) {
  const byFile = new Map<string, Array<{ title: string; status: string }>>();
  for (const [file, title, status = "passed"] of entries) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ title, status });
  }
  return {
    success: entries.every(([, , status]) => (status ?? "passed") !== "failed"),
    testResults: [...byFile].map(([file, results]) => ({
      name: `${ROOT}/${file}`,
      status: results.some((result) => result.status === "failed") ? "failed" : "passed",
      startTime: 1000,
      endTime: 3000,
      assertionResults: results.map((result) => ({ ancestorTitles: ["suite"], title: result.title, status: result.status, duration: 5 })),
    })),
  };
}

function playwrightJson(entries: Array<[string, string, string, string?]>, unexpected = 0) {
  return {
    stats: { duration: 60_000, unexpected },
    errors: [],
    suites: [...new Set(entries.map(([file]) => file))].map((file) => ({
      title: file,
      file,
      specs: entries
        .filter(([entryFile]) => entryFile === file)
        .map(([, project, title, status = "expected"]) => ({
          title,
          file,
          tests: [{ projectName: project, status, results: status === "flaky" ? [{ duration: 10 }, { duration: 10 }] : [{ duration: 10 }] }],
        })),
    })),
  };
}

const PGTAP = [
  "supabase/tests/database/001_auth.sql .. ok",
  "supabase/tests/database/002_stock.sql .. ok",
  "All tests successful.",
  "Files=2, Tests=40,  2 wallclock secs",
  "Result: PASS",
].join("\n");

const CHAIN = ["--- counterexample: one ---", "--- counterexample: two ---", "--- counterexample: three ---", "", "migration-chain: PASS"].join("\n");

const allE2e: Array<[string, string, string, string?]> = [];
for (const file of ["shell.spec.ts", "sales.spec.ts"]) {
  for (const project of ["mobile", "tablet", "desktop"]) allE2e.push([file, project, "works"]);
}

function goodReports() {
  return [
    normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"], ["tests/unit/report.test.ts", "pages"]]), ROOT),
    normaliseVitest("integration", vitestJson([["tests/integration/authority.test.ts", "refuses"]]), ROOT),
    normalisePlaywright(playwrightJson(allE2e)),
    normalisePgTap(PGTAP),
    normaliseMigrationChain(CHAIN),
  ];
}

const goodJobs = { plan: { result: "success" }, static: { result: "success" }, database: { result: "success" }, integration: { result: "success" }, e2e: { result: "success" } };

function decide(overrides: Partial<Parameters<typeof evaluateGate>[0]> = {}) {
  return evaluateGate({
    plan: makePlan(),
    jobs: goodJobs,
    reports: goodReports(),
    knownSkips: [],
    expect: { head: HEAD, selectorDigest: SELECTOR },
    ...overrides,
  });
}

function replace(suite: string, report: unknown) {
  return [...goodReports().filter((entry) => entry.suite !== suite), report];
}

describe("the aggregate gate", () => {
  it("passes a complete, green run", () => {
    const decision = decide();
    expect(decision.refusals).toEqual([]);
    expect(decision.pass).toBe(true);
    expect(decision.summary.e2e).toMatchObject({ passed: 6, failed: 0 });
    expect(decision.summary.pgtap.assertions).toBe(40);
  });

  for (const result of ["failure", "cancelled", "skipped"]) {
    it(`refuses a job that finished as ${result}`, () => {
      const decision = decide({ jobs: { ...goodJobs, integration: { result } } });
      expect(decision.pass).toBe(false);
      expect(decision.refusals).toContain(`job integration finished as ${result}`);
    });
  }

  it("refuses an absent job", () => {
    const jobs: Record<string, { result: string }> = { ...goodJobs };
    delete jobs.e2e;
    expect(decide({ jobs }).refusals).toContain("job e2e is absent");
  });

  it("refuses when the planner failed", () => {
    expect(decide({ jobs: { ...goodJobs, plan: { result: "failure" } } }).refusals).toContain("job plan finished as failure");
  });

  it("refuses without a plan", () => {
    expect(decide({ plan: null }).refusals).toEqual(["no plan: the planner did not produce one"]);
  });

  it("refuses a plan that was edited after it was made", () => {
    const plan = makePlan();
    plan.execution.unit.files = ["tests/unit/money.test.ts"];
    expect(decide({ plan }).refusals).toContain("plan digest does not match its contents: the plan was altered or is malformed");
  });

  it("refuses a stale plan from another selector, or for another head", () => {
    expect(decide({ expect: { head: HEAD, selectorDigest: "0".repeat(64) } }).refusals[0]).toMatch(/plan is stale/);
    expect(decide({ expect: { head: "c".repeat(40), selectorDigest: SELECTOR } }).refusals[0]).toMatch(/plan is for head/);
  });

  it("refuses a suite whose report never arrived", () => {
    expect(decide({ reports: goodReports().filter((report) => report.suite !== "integration") }).refusals)
      .toContain("integration: no report arrived from job integration");
  });

  it("refuses a successful job that ran zero tests", () => {
    const decision = decide({ reports: replace("unit", normaliseVitest("unit", { success: true, testResults: [] }, ROOT)) });
    expect(decision.refusals).toContain("unit: no test passed (zero-test success is refused)");
  });

  it("refuses a failed test even when the job claims success", () => {
    const failing = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds", "failed"], ["tests/unit/report.test.ts", "pages"]]), ROOT);
    const decision = decide({ reports: replace("unit", failing) });
    expect(decision.refusals.some((line: string) => line.startsWith("unit: 1 failed"))).toBe(true);
  });

  it("refuses a file that failed to load, which has no test results at all", () => {
    const json = vitestJson([["tests/unit/report.test.ts", "pages"]]);
    json.testResults.push({ name: `${ROOT}/tests/unit/money.test.ts`, status: "failed", startTime: 0, endTime: 0, assertionResults: [] });
    json.success = false;
    expect(decide({ reports: replace("unit", normaliseVitest("unit", json, ROOT)) }).pass).toBe(false);
  });

  it("refuses a runner that reported failure outside any single test", () => {
    const report = normalisePlaywright(playwrightJson(allE2e, 1));
    expect(decide({ reports: replace("e2e", report) }).refusals).toContain(
      "e2e: the runner reported failure (a setup or load error outside any single test)",
    );
  });

  it("refuses a required file that did not run", () => {
    const partial = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    expect(decide({ reports: replace("unit", partial) }).refusals).toContain("unit: required file tests/unit/report.test.ts did not run");
  });

  it("refuses E2E that skipped a device tier", () => {
    const noTablet = allE2e.filter(([file, project]) => !(file === "sales.spec.ts" && project === "tablet"));
    expect(decide({ reports: replace("e2e", normalisePlaywright(playwrightJson(noTablet))) }).refusals).toContain(
      "e2e: e2e/sales.spec.ts did not run on tablet",
    );
  });

  it("refuses a plan that drops a device tier", () => {
    const plan = makePlan();
    plan.execution.projects = ["mobile", "desktop"];
    expect(decide({ plan }).refusals).toContain("e2e: the plan drops the tablet project");
  });

  it("refuses an unexplained skip and accepts one on the reviewed list", () => {
    const skipped = normalisePlaywright(playwrightJson([...allE2e, ["sales.spec.ts", "desktop", "stepper", "skipped"]]));
    expect(decide({ reports: replace("e2e", skipped) }).refusals).toContain("e2e: unexplained skip e2e:e2e/sales.spec.ts:desktop:stepper");

    const known = [{ suite: "e2e", file: "e2e/sales.spec.ts", title: "stepper", projects: ["tablet", "desktop"], reason: "phone only" }];
    expect(decide({ reports: replace("e2e", skipped), knownSkips: known }).pass).toBe(true);

    const wrongTier = [{ ...known[0], projects: ["tablet"] }];
    expect(decide({ reports: replace("e2e", skipped), knownSkips: wrongTier }).pass).toBe(false);
  });

  it("passes a test rescued by a retry, but lists it", () => {
    const flaky = normalisePlaywright(playwrightJson([...allE2e.slice(1), ["shell.spec.ts", "mobile", "works", "flaky"]]));
    const decision = decide({ reports: replace("e2e", flaky) });
    expect(decision.pass).toBe(true);
    expect(decision.warnings[0]).toMatch(/e2e:e2e\/shell\.spec\.ts:mobile:works passed only on retry 1/);
  });

  it("refuses a missing shard, and shards that report the same test", () => {
    const first = normalisePlaywright(playwrightJson(allE2e.filter(([file]) => file === "shell.spec.ts")), { index: 1, total: 2 });
    const second = normalisePlaywright(playwrightJson(allE2e.filter(([file]) => file === "sales.spec.ts")), { index: 2, total: 2 });
    const others = goodReports().filter((report) => report.suite !== "e2e");

    expect(decide({ reports: [...others, first, second] }).pass).toBe(true);
    expect(decide({ reports: [...others, first] }).refusals).toContain("e2e: shard 2 of 2 is missing");
    const overlap = normalisePlaywright(playwrightJson(allE2e), { index: 2, total: 2 });
    expect(decide({ reports: [...others, first, overlap] }).refusals).toContain("e2e: 3 test(s) reported by more than one shard");
  });

  it("refuses a migration chain that ran fewer counterexamples than the floor", () => {
    const short = normaliseMigrationChain("--- counterexample: one ---\nmigration-chain: PASS");
    expect(decide({ reports: replace("migrationChain", short) }).refusals).toContain(
      "migrationChain: 1 counterexamples ran; at least 3 are required",
    );
  });

  it("refuses a migration chain that did not end in PASS", () => {
    const failed = normaliseMigrationChain(CHAIN.replace("migration-chain: PASS", "migration-chain: FAIL"));
    expect(decide({ reports: replace("migrationChain", failed) }).pass).toBe(false);
  });

  it("refuses pgTAP when a file failed or fewer files ran than the floor", () => {
    const failed = normalisePgTap(PGTAP.replace("002_stock.sql .. ok", "002_stock.sql .. Failed 1/20 subtests").replace("PASS", "FAIL"));
    expect(decide({ reports: replace("pgtap", failed) }).pass).toBe(false);
    const one = normalisePgTap("supabase/tests/database/001_auth.sql .. ok\nFiles=1, Tests=20\nResult: PASS");
    const refusals = decide({ reports: replace("pgtap", one) }).refusals;
    expect(refusals).toContain("pgtap: 1 files ran; at least 2 are required");
    expect(refusals).toContain("pgtap: required file supabase/tests/database/002_stock.sql did not run");
  });

  it("refuses two unsharded reports for one suite", () => {
    expect(decide({ reports: [...goodReports(), normalisePgTap(PGTAP)] }).refusals).toContain("pgtap: 2 unsharded reports; expected one");
  });

  it("requires what the approved base requires, whatever the head's plan says", () => {
    // A head plan running only one unit file (as an enforcing plan might) against a base that
    // requires both: the second is required anyway, so a report without it refuses.
    const activated = { ...manifest, activation: { selectiveEnforcement: true } };
    const head = selectTests({ manifest: activated, files, edges: new Map(), changes: [{ status: "M", path: "tests/unit/money.test.ts" }], identity, mode: "enforce", selector: { selectorDigest: SELECTOR } });
    expect(head.execution.unit.files).toEqual(["tests/unit/money.test.ts"]);
    const base = makePlan();

    const onlyMoney = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    const decision = decide({ plan: head, basePlan: base, reports: replace("unit", onlyMoney) });
    expect(decision.refusals).toContain("unit: required file tests/unit/report.test.ts did not run");
    expect(decision.warnings[0]).toMatch(/approved base requires 1 file/);
  });

  it("requires the full inventory when the base has no selector", () => {
    const activated = { ...manifest, activation: { selectiveEnforcement: true } };
    const head = selectTests({ manifest: activated, files, edges: new Map(), changes: [{ status: "M", path: "tests/unit/money.test.ts" }], identity, mode: "enforce", selector: { selectorDigest: SELECTOR } });
    const onlyMoney = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    expect(decide({ plan: head, basePlan: null, reports: replace("unit", onlyMoney) }).pass).toBe(false);
  });

  it("refuses a Release Gate on anything but a full plan", () => {
    expect(decide({ gate: "Release Gate" }).refusals).toContain("a Release Gate requires a full plan");
    expect(decide({ gate: "Release Gate", plan: makePlan({ mode: "full" }) }).pass).toBe(true);
  });

  it("reports a failing test the shadow selection would have missed", () => {
    // README only: the selection is the smoke set, so a failing sales spec is an omission.
    const failing = normalisePlaywright(playwrightJson([...allE2e.filter(([file]) => file !== "sales.spec.ts"), ["sales.spec.ts", "mobile", "works", "unexpected"], ["sales.spec.ts", "tablet", "works"], ["sales.spec.ts", "desktop", "works"]], 1));
    const decision = decide({ reports: replace("e2e", failing) });
    expect(decision.shadow.omissions).toEqual(["e2e:e2e/sales.spec.ts:mobile:works"]);
    expect(renderSummary(decision)).toContain("Failing tests the selection would have missed");
  });

  it("matches reviewed skips by exact text or by /pattern/, file and title alike", () => {
    const test = { suite: "e2e", file: "e2e/imprest-funding.spec.ts", project: "tablet", title: "imprest funding mobile benchmark > times it" };
    expect(skipMatches({ suite: "e2e", file: "/^e2e\\/imprest-[a-z-]+\\.spec\\.ts$/", title: "/mobile benchmark > /", projects: "*" }, test)).toBe(true);
    expect(skipMatches({ suite: "e2e", file: "e2e/imprest-funding.spec.ts", title: "/mobile benchmark > /", projects: ["mobile"] }, test)).toBe(false);
    expect(skipMatches({ suite: "e2e", file: "e2e/sales.spec.ts", title: "/mobile benchmark > /", projects: "*" }, test)).toBe(false);
    expect(skipMatches({ suite: "integration", file: "e2e/imprest-funding.spec.ts", title: "/./", projects: "*" }, test)).toBe(false);
  });

  it("every reviewed skip says why, who owns it and when it is reviewed", () => {
    const { skips } = JSON.parse(readFileSync(join(process.cwd(), "scripts/testing/known-skips.json"), "utf8"));
    for (const entry of skips) {
      expect(entry.reason.length, JSON.stringify(entry)).toBeGreaterThan(20);
      expect(entry.owner).toBeTruthy();
      expect(entry.review).toBeTruthy();
      expect(["unit", "integration", "e2e", "pgtap"]).toContain(entry.suite);
    }
  });

  it("refuses unreadable report files by name", () => {
    expect(decide({ reportProblems: ["unit.vitest.json cannot be parsed: Unexpected token"] }).refusals).toContain(
      "unit.vitest.json cannot be parsed: Unexpected token",
    );
  });
});
