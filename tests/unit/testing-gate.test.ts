import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baselineRefusals, evaluateGate, followsLane, renderSummary, skipMatches } from "@/scripts/testing/gate.mjs";
import {
  normaliseMigrationChain,
  normalisePgTap,
  normalisePlaywright,
  normaliseVitest,
} from "@/scripts/testing/reports.mjs";
import { BOOTSTRAP_BASELINES, baselinePlan, planDigest, selectTests, validateManifest } from "@/scripts/testing/select.mjs";

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
const BASE_TREE = "e".repeat(40);

/**
 * The approved record for the fixture's base, which has no selector. Its patterns are the base's
 * runner configuration, deliberately broader than the manifest's, and its floors are its own.
 */
const BOOTSTRAP = {
  [identity.base]: {
    tree: BASE_TREE,
    suites: {
      unit: ["tests/unit/**/*.test.{ts,tsx}"],
      integration: ["tests/integration/**/*.test.ts"],
      e2e: ["e2e/**/*.{spec,test}.{ts,tsx}"],
      pgtap: ["supabase/tests/**/*.sql"],
    },
    counts: { unit: 2, integration: 1, e2e: 2, pgtap: 2 },
    migrations: ["supabase/migrations/*.sql"],
    minimums: { migrations: 0, pgtapFiles: 2, pgtapAssertions: 40, migrationChainCounterexamples: 3, responsiveProjects: ["mobile", "tablet", "desktop"] },
  },
};

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

/** The approved base's plan over the base's own tree, as select.mjs --baseline writes it for a base with a selector. */
function makeBasePlan(overrides: Record<string, unknown> = {}) {
  return selectTests({
    manifest,
    files,
    edges: new Map(),
    changes: [],
    mode: "full",
    identity: { ...identity, inventoryRev: identity.base },
    selector: { selectorDigest: SELECTOR },
    ...overrides,
  });
}

/** A git that knows one commit, the base, holding `tree` and no selector. */
function gitWithBase(tree: string[], treeId = BASE_TREE) {
  return (args: string[]) => {
    if (args[0] === "cat-file" && args[2] === `${identity.base}^{commit}`) return "";
    if (args[0] === "rev-parse" && args[1] === `${identity.base}^{tree}`) return treeId;
    if (args[0] === "ls-tree" && args.includes(identity.base!)) {
      const scoped = args.at(-1) === "scripts/testing" ? tree.filter((path) => path.startsWith("scripts/testing/")) : tree;
      return scoped.join("\0");
    }
    throw new Error(`git ${args.join(" ")} exited 128: unknown revision`);
  };
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

/** What each runner would have listed: by default, exactly the tests its report holds. */
function listingsOf(reports: Array<{ suite: string; tests: Array<{ id: string }> }>) {
  const listings: Record<string, Set<string>> = {};
  for (const report of reports) {
    if (!["unit", "integration", "e2e"].includes(report.suite)) continue;
    listings[report.suite] ??= new Set();
    for (const test of report.tests) listings[report.suite].add(test.id);
  }
  return listings;
}

const ARTIFACT = { commit: HEAD, digest: "a".repeat(64), files: 100, clean: true, buildEnvironment: {} };

function decide(overrides: Partial<Parameters<typeof evaluateGate>[0]> = {}) {
  const reports = overrides.reports ?? goodReports();
  return evaluateGate({
    plan: makePlan(),
    jobs: goodJobs,
    reports,
    listings: listingsOf(reports),
    basePlan: makeBasePlan(),
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
    expect(decision.warnings.some((line: string) => line.includes("e2e:e2e/shell.spec.ts:mobile:works passed only on retry 1"))).toBe(true);
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
    // A head plan altered to require one unit file, against a base that requires both: the second
    // is required anyway, so a report without it refuses.
    const shrunk = makePlan();
    shrunk.execution.unit = { mode: "selected", files: ["tests/unit/money.test.ts"] };
    const head = { ...shrunk, digest: planDigest(shrunk) };
    const base = makePlan();

    const onlyMoney = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    const decision = decide({ plan: head, basePlan: base, reports: replace("unit", onlyMoney) });
    expect(decision.refusals).toContain("unit: required file tests/unit/report.test.ts did not run");
    expect(decision.warnings.some((line: string) => /approved base requires 1 file/.test(line))).toBe(true);
  });

  it("requires the full inventory when the base has no selector", () => {
    const head = selectTests({ manifest, files, edges: new Map(), changes: [{ status: "M", path: "tests/unit/money.test.ts" }], identity, selector: { selectorDigest: SELECTOR } });
    const basePlan = baselinePlan({ root: ROOT, git: gitWithBase(files), base: identity.base!, head: HEAD, bootstrap: BOOTSTRAP });
    const onlyMoney = normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    expect(decide({ plan: head, basePlan, reports: replace("unit", onlyMoney) }).refusals).toContain("unit: required file tests/unit/report.test.ts did not run");
  });

  describe("a pull request on a lane", () => {
    // The fixture's manifest with enforcement on, one screen domain, and the paths a real manifest
    // sends to full coverage.
    const lanes = {
      ...manifest,
      activation: { selectiveEnforcement: true },
      forceFull: [{ pattern: "supabase/**", reason: "database" }],
      domains: { sales: { risk: "medium", sources: ["app/sales/**"], e2e: ["e2e/sales.spec.ts"] } },
    };
    const laneFiles = [...files, "app/sales/page.tsx"];
    const lanePlan = (changes: Array<{ status: string; path: string }>, extra: Record<string, unknown> = {}) =>
      selectTests({ manifest: lanes, files: laneFiles, edges: new Map(), changes, identity, mode: "enforce", selector: { selectorDigest: SELECTOR }, ...extra });
    const screen = () => lanePlan([{ status: "M", path: "app/sales/page.tsx" }]);
    const unitAndE2e = () => goodReports().filter((report) => report.suite === "unit" || report.suite === "e2e");
    const laneJobs = { plan: { result: "success" }, static: { result: "success" }, database: { result: "skipped" }, integration: { result: "skipped" }, e2e: { result: "success" } };

    it("passes with only the jobs its plan needs, and says what it left out and why", () => {
      const plan = screen();
      expect(followsLane(plan)).toBe(true);
      expect(plan.expectedJobs).toEqual(["static", "e2e"]);
      const reports = unitAndE2e();
      const decision = evaluateGate({ plan, jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.refusals).toEqual([]);
      expect(decision.pass).toBe(true);
      expect(decision.lane).toBe("screen");
      expect(decision.notRequired.map((entry: { suite: string }) => entry.suite)).toEqual(["integration", "pgtap", "migrationChain"]);
      expect(renderSummary(decision)).toContain("### Lane: screen");
      expect(renderSummary(decision)).toContain("no database input changed");
    });

    it("needs no base plan, because a lane deletes no test and changes no rule", () => {
      const reports = unitAndE2e();
      const decision = evaluateGate({ plan: screen(), basePlan: null, jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.pass).toBe(true);
    });

    it("still refuses when a job the plan needs was skipped, failed or never arrived", () => {
      const reports = unitAndE2e();
      const run = (jobs: Record<string, { result: string }>) =>
        evaluateGate({ plan: screen(), jobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } }).refusals;
      expect(run({ ...laneJobs, e2e: { result: "skipped" } })).toContain("job e2e finished as skipped");
      expect(run({ ...laneJobs, static: { result: "failure" } })).toContain("job static finished as failure");
      const withoutPlanner = Object.fromEntries(Object.entries(laneJobs).filter(([job]) => job !== "plan"));
      expect(run(withoutPlanner)).toContain("job plan is absent");
    });

    it("refuses a job it did not need, if that job ran and did not succeed", () => {
      const reports = unitAndE2e();
      const decision = evaluateGate({ plan: screen(), jobs: { ...laneJobs, database: { result: "failure" } }, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.refusals).toContain("job database was not required for this change, but it ran and finished as failure");
    });

    it("works the required jobs out from the plan's execution, not from the plan's own list of jobs", () => {
      const altered = screen();
      altered.expectedJobs = ["static"];
      const plan = { ...altered, digest: planDigest(altered) };
      const reports = unitAndE2e();
      const jobs = { plan: { result: "success" }, static: { result: "success" }, e2e: { result: "skipped" } };
      const decision = evaluateGate({ plan, jobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.refusals).toContain("job e2e finished as skipped");
    });

    it("refuses a required spec that did not run on every project", () => {
      const mobileOnly = normalisePlaywright(playwrightJson(allE2e.filter(([, project]) => project === "mobile")));
      const reports = [...unitAndE2e().filter((report) => report.suite !== "e2e"), mobileOnly];
      const decision = evaluateGate({ plan: screen(), jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.refusals).toContain("e2e: e2e/sales.spec.ts did not run on tablet");
    });

    it("refuses a plan that leaves suites out although the database changed, whatever made the plan", () => {
      // The selector sends supabase/** to full coverage. A plan that says otherwise was made by a
      // selector or manifest that no longer does, and the gate does not take its word.
      const altered = screen();
      altered.changes = [...altered.changes, { status: "M", path: "supabase/migrations/001_first.sql" }];
      const plan = { ...altered, digest: planDigest(altered) };
      const reports = unitAndE2e();
      const decision = evaluateGate({ plan, jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(decision.refusals.some((line: string) => /runs only part of .*supabase\/migrations\/001_first\.sql changed, which needs every suite/.test(line))).toBe(true);
    });

    it("a change that forces full coverage is not on a lane: every job and the base plan are required again", () => {
      const plan = lanePlan([{ status: "M", path: "supabase/tests/database/001_auth.sql" }]);
      expect(followsLane(plan)).toBe(false);
      expect(plan.lane).toBe("critical");
      expect(decide({ plan, jobs: laneJobs }).refusals).toEqual(expect.arrayContaining(["job database finished as skipped", "job integration finished as skipped"]));
      expect(decide({ plan, basePlan: null }).refusals[0]).toMatch(/^no baseline/);
      expect(decide({ plan }).pass).toBe(true);
    });

    it("a Release Gate never follows a lane", () => {
      const reports = unitAndE2e();
      const decision = evaluateGate({ plan: screen(), jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], artifact: ARTIFACT, expect: { head: HEAD, selectorDigest: SELECTOR }, gate: "Release Gate" });
      expect(decision.refusals).toEqual(expect.arrayContaining(["a Release Gate requires a full plan", "job database finished as skipped"]));
    });

    it("holds the reports to the shards the plan split the specs into", () => {
      const plan = lanePlan([{ status: "M", path: "app/sales/page.tsx" }], { maxShards: 2, manifest: { ...lanes, e2eMinutes: { "e2e/shell.spec.ts": 20, "e2e/sales.spec.ts": 20 } } });
      expect(plan.execution.e2e.shards).toEqual([["e2e/sales.spec.ts"], ["e2e/shell.spec.ts"]]);
      const shard = (file: string, index: number) => normalisePlaywright(playwrightJson(allE2e.filter(([entry]) => entry === file)), { index, total: 2 });
      const others = unitAndE2e().filter((report) => report.suite !== "e2e");
      const both = [...others, shard("sales.spec.ts", 1), shard("shell.spec.ts", 2)];
      const run = (reports: ReturnType<typeof unitAndE2e>) =>
        evaluateGate({ plan, jobs: laneJobs, reports, listings: listingsOf(reports), knownSkips: [], expect: { head: HEAD, selectorDigest: SELECTOR } });
      expect(run(both).pass).toBe(true);
      expect(run(unitAndE2e()).refusals).toContain("e2e: the plan splits the specs into 2 shards, and the reports are not those shards");
      expect(run([...others, shard("sales.spec.ts", 1)]).refusals).toContain("e2e: shard 2 of 2 is missing");
    });
  });

  it("refuses a Release Gate on anything but a full plan", () => {
    expect(decide({ gate: "Release Gate" }).refusals).toContain("a Release Gate requires a full plan");
    expect(decide({ gate: "Release Gate", plan: makePlan({ mode: "full" }), artifact: ARTIFACT }).pass).toBe(true);
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

  it("accepts #100's seven responsive-shell tier skips, and nothing beside them", () => {
    const { skips } = JSON.parse(readFileSync(join(process.cwd(), "scripts/testing/known-skips.json"), "utf8"));
    const RAIL = "the rail or sidebar sits beside the page, not above it";
    const ICONS = "the icon rail fits its items and names them on focus";
    const REACH = "the sidebar stays in reach at the bottom of a long page";
    const TOP_BAR = "the phone top bar fits a 320px screen";
    const seven: Array<[string, string]> = [
      ["tablet", RAIL],
      ["mobile", ICONS],
      ["tablet", ICONS],
      ["mobile", REACH],
      ["tablet", REACH],
      ["tablet", TOP_BAR],
      ["desktop", TOP_BAR],
    ];
    const asSkipped = (rows: Array<[string, string]>) =>
      normalisePlaywright(
        playwrightJson([...allE2e, ...rows.map(([project, title]): [string, string, string, string] => ["responsive-shell.spec.ts", project, title, "skipped"])]),
      );

    const accepted = decide({ reports: replace("e2e", asSkipped(seven)), knownSkips: skips });
    expect(accepted.refusals).toEqual([]);
    expect(accepted.pass).toBe(true);

    // Each test still has to run on the tier it is for.
    const wrongTier: Array<[string, string]> = [
      ["desktop", RAIL],
      ["desktop", ICONS],
      ["desktop", REACH],
      ["mobile", TOP_BAR],
    ];
    for (const row of wrongTier) {
      const refused = decide({ reports: replace("e2e", asSkipped([row])), knownSkips: skips });
      expect(refused.pass, row.join(" ")).toBe(false);
      expect(refused.refusals).toContain(`e2e: unexplained skip e2e:e2e/responsive-shell.spec.ts:${row[0]}:${row[1]}`);
    }

    // A title the list does not name is refused on every tier, in the same file.
    for (const project of ["mobile", "tablet", "desktop"]) {
      const title = "a skip link is the first stop and lands on the page";
      const refused = decide({ reports: replace("e2e", asSkipped([[project, title]])), knownSkips: skips });
      expect(refused.pass, project).toBe(false);
      expect(refused.refusals).toContain(`e2e: unexplained skip e2e:e2e/responsive-shell.spec.ts:${project}:${title}`);
    }
  });

  describe("review findings R1 to R4", () => {
    it("R3: refuses one passing test per file when the runner listed more", () => {
      // The review's probe: a report with just one passing case per required file. The listing says
      // money.test.ts also holds "subtracts", which never ran.
      const listings = listingsOf(goodReports());
      listings.unit.add("unit:tests/unit/money.test.ts:suite > subtracts");
      const refusals = decide({ listings }).refusals;
      expect(refusals).toContain("unit: 1 listed test(s) did not run: unit:tests/unit/money.test.ts:suite > subtracts");
    });

    it("R3: refuses a suite whose listing never arrived", () => {
      const listings = listingsOf(goodReports());
      delete listings.integration;
      expect(decide({ listings }).refusals).toContain("integration: no test listing arrived, so the run cannot be checked test by test");
    });

    it("R3: refuses an absent planner job", () => {
      const jobs: Record<string, { result: string }> = { ...goodJobs };
      delete jobs.plan;
      expect(decide({ jobs }).refusals).toContain("job plan is absent");
    });

    it("R4: holds the base's numeric floors when the head lowers its own", () => {
      // The head's manifest lowers the counterexample floor to one; the base's is three.
      const lowered = { ...manifest, minimums: { ...manifest.minimums, migrationChainCounterexamples: 1 } };
      const head = makePlan({ manifest: lowered });
      const one = normaliseMigrationChain("--- counterexample: one ---\nmigration-chain: PASS");
      const reports = replace("migrationChain", one);
      expect(decide({ plan: head, basePlan: makeBasePlan(), reports }).refusals).toContain(
        "migrationChain: 1 counterexamples ran; at least 3 are required",
      );
    });

    it("R4: refuses a change that deletes a test the base requires, unless the manifest retires it", () => {
      const base = makeBasePlan({ files: [...files, "tests/unit/old.test.ts"] });
      expect(decide({ basePlan: base }).refusals).toContain(
        "unit: the base requires tests/unit/old.test.ts, which this change deletes; retire it in the manifest's retiredTests for review, or keep it",
      );

      const retiring = { ...manifest, retiredTests: [{ file: "tests/unit/old.test.ts", reason: "merged into money.test.ts" }] };
      const decision = decide({ plan: makePlan({ manifest: retiring }), basePlan: base });
      expect(decision.pass).toBe(true);
      expect(decision.warnings.some((line: string) => line.includes("tests/unit/old.test.ts is required by the base but retired"))).toBe(true);
    });

    it("refuses a pgTAP run below the assertion floor", () => {
      const floored = { ...manifest, minimums: { ...manifest.minimums, pgtapAssertions: 41 } };
      expect(decide({ plan: makePlan({ manifest: floored }) }).refusals).toContain("pgtap: 40 assertions ran; at least 41 are required");
    });

    it("R2: a benchmark skip the Development Gate accepts refuses the Release Gate", () => {
      const benchmarkSkipped = normalisePlaywright(playwrightJson([...allE2e, ["shell.spec.ts", "mobile", "shell mobile benchmark > times it", "skipped"]]));
      const knownSkips = [{ suite: "e2e", file: "e2e/shell.spec.ts", title: "/mobile benchmark > /", projects: "*", gates: ["Development Gate"], reason: "opt-in" }];
      const reports = replace("e2e", benchmarkSkipped);
      expect(decide({ reports, knownSkips }).pass).toBe(true);
      const release = decide({ reports, knownSkips, gate: "Release Gate", plan: makePlan({ mode: "full" }), artifact: ARTIFACT });
      expect(release.refusals).toContain("e2e: unexplained skip e2e:e2e/shell.spec.ts:mobile:shell mobile benchmark > times it");
    });

    it("R2: a Release Gate accepts the main run's benchmark skip only when the test passed in its own pass", () => {
      const id = "shell mobile benchmark > times it";
      const mainRun = normalisePlaywright(playwrightJson([...allE2e, ["shell.spec.ts", "mobile", id, "skipped"]]));
      const knownSkips = [{ suite: "e2e", file: "e2e/shell.spec.ts", title: "/mobile benchmark > /", projects: "*", gates: ["Development Gate"], reason: "opt-in" }];
      const release = (benchmark: unknown[]) =>
        decide({
          reports: [...replace("e2e", mainRun), ...benchmark],
          knownSkips,
          gate: "Release Gate",
          plan: makePlan({ mode: "full" }),
          artifact: ARTIFACT,
        });
      const pass = (status: string, unexpected = 0) => ({
        ...normalisePlaywright(playwrightJson([["shell.spec.ts", "mobile", id, status]], unexpected)),
        benchmark: true,
        source: "e2e-benchmark-shell.playwright.json",
      });

      // Passed alone: the skip stands, and the pass is not counted as a second main E2E report.
      const proven = release([pass("expected")]);
      expect(proven.refusals).toEqual([]);
      expect(proven.summary.benchmarks).toMatchObject({ passed: 1, failed: 0, passes: ["e2e-benchmark-shell.playwright.json"] });

      // Failed alone, or never run: refused.
      expect(release([pass("unexpected", 1)]).refusals).toContain(`benchmarks: 1 failed: e2e:e2e/shell.spec.ts:mobile:${id}`);
      expect(release([]).refusals).toContain(`e2e: unexplained skip e2e:e2e/shell.spec.ts:mobile:${id}`);
      // Skipped inside its own pass (a grep that matched nothing) proves nothing either.
      expect(release([pass("skipped")]).refusals).toContain(`e2e: unexplained skip e2e:e2e/shell.spec.ts:mobile:${id}`);
    });

    it("R2: a benchmark pass that failed outside any test refuses the gate", () => {
      const broken = { ...normalisePlaywright(playwrightJson([], 1)), benchmark: true, source: "e2e-benchmark-x.playwright.json" };
      expect(decide({ reports: [...goodReports(), broken] }).refusals).toContain(
        "benchmarks: e2e-benchmark-x.playwright.json reported failure outside any single test",
      );
    });

    it("R1: refuses a Release Gate with no recorded build, another commit's build, or a build from a dirty tree", () => {
      const full = makePlan({ mode: "full" });
      expect(decide({ gate: "Release Gate", plan: full }).refusals).toContain("no build artifact was recorded by the E2E job");
      expect(decide({ gate: "Release Gate", plan: full, artifact: { ...ARTIFACT, commit: "c".repeat(40) } }).refusals).toContain(
        `the recorded build is of ${"c".repeat(40)}, not ${HEAD}`,
      );
      expect(decide({ gate: "Release Gate", plan: full, artifact: { ...ARTIFACT, clean: false } }).refusals).toContain(
        "the recorded build was made from a working tree with changes",
      );
    });
  });

  describe("second review: the R4 baseline fallback and the R2 inherited benchmark flag", () => {
    const deleting = files.filter((file) => file !== "tests/unit/report.test.ts");
    const withoutReport = () => normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    const headDeleting = (overrides: Record<string, unknown> = {}) => makePlan({ files: deleting, ...overrides });

    it("R4: a base without a selector is planned in full over its own tree, with its approved record's floors", () => {
      const basePlan = baselinePlan({ root: ROOT, git: gitWithBase([...files, "lib/money.ts"]), base: identity.base!, head: HEAD, bootstrap: BOOTSTRAP });
      expect(basePlan.identity.inventoryRev).toBe(identity.base);
      expect(basePlan.mode).toBe("full");
      expect(basePlan.execution.unit.files).toEqual(["tests/unit/money.test.ts", "tests/unit/report.test.ts"]);
      expect(basePlan.minimums).toEqual(BOOTSTRAP[identity.base!].minimums);
      expect(basePlan.digest).toBe(planDigest(basePlan));
      expect(baselineRefusals(makePlan(), basePlan)).toEqual([]);

      const decision = decide({ basePlan });
      expect(decision.pass).toBe(true);
      expect(decision.warnings).toContain(`baseline: ${basePlan.baseline}`);
    });

    it("R4: a base without a selector still refuses a test the change deletes without retiring it", () => {
      const basePlan = baselinePlan({ root: ROOT, git: gitWithBase(files), base: identity.base!, head: HEAD, bootstrap: BOOTSTRAP });
      const decision = decide({ plan: headDeleting(), basePlan, reports: replace("unit", withoutReport()) });
      expect(decision.pass).toBe(false);
      expect(decision.refusals).toContain(
        "unit: the base requires tests/unit/report.test.ts, which this change deletes; retire it in the manifest's retiredTests for review, or keep it",
      );

      const retiring = { ...manifest, retiredTests: [{ file: "tests/unit/report.test.ts", reason: "folded into money.test.ts" }] };
      expect(decide({ plan: headDeleting({ manifest: retiring }), basePlan, reports: replace("unit", withoutReport()) }).pass).toBe(true);
    });

    it("R4: a base with a selector is planned by its own selector, over its own tree", () => {
      const tree = [...files, "scripts/testing/select.mjs", "scripts/testing/manifest.json"];
      const calls: string[][] = [];
      const own = makeBasePlan();
      const basePlan = baselinePlan({
        root: ROOT,
        git: (args: string[]) => (args[0] === "show" ? `// ${args[1]}` : gitWithBase(tree)(args)),
        base: identity.base!,
        head: HEAD,
        run: ((command: string, args: string[]) => {
          calls.push([command, ...args]);
          writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify(own));
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });
      expect(basePlan).toEqual(own);
      const argv = calls[0];
      expect(argv[1]).toMatch(/oms-base-policy-.*[\\/]scripts[\\/]testing[\\/]select\.mjs$/);
      expect(argv.slice(argv.indexOf("--inventory-rev"), argv.indexOf("--inventory-rev") + 2)).toEqual(["--inventory-rev", identity.base]);
      expect(argv[argv.indexOf("--manifest") + 1]).toMatch(/oms-base-policy-.*manifest\.json$/);
    });

    it("R4: unavailable baseline evidence refuses the gate instead of falling back to the head", () => {
      // Missing (the old fallback held the head to its own inventory and floors, and passed).
      const missing = decide({ basePlan: null });
      expect(missing.pass).toBe(false);
      expect(missing.refusals).toContain("no baseline: the approved base's plan is missing, so deleted tests and lowered floors cannot be checked");
      // Missing, while the head deletes a base test: still refused, never judged on the head's tree alone.
      expect(decide({ plan: headDeleting(), basePlan: null, reports: replace("unit", withoutReport()) }).pass).toBe(false);

      // Altered after it was made.
      const altered = { ...makeBasePlan(), minimums: {} };
      expect(decide({ basePlan: altered }).refusals).toContain("baseline digest does not match its contents: the base plan was altered or is malformed");
      // Planned over the head's tree, or another commit's.
      expect(decide({ basePlan: makePlan({ mode: "full" }) }).refusals).toContain(`baseline was planned over the head's tree, not the base ${identity.base}`);
      const elsewhere = makeBasePlan({ identity: { ...identity, inventoryRev: "c".repeat(40) } });
      expect(decide({ basePlan: elsewhere }).refusals).toContain(`baseline was planned over ${"c".repeat(40)}, not the base ${identity.base}`);
      // A suite list missing from the base plan.
      const partial = { ...makeBasePlan(), execution: { ...makeBasePlan().execution, e2e: {} } };
      delete (partial as { digest?: string }).digest;
      expect(decide({ basePlan: { ...partial, digest: planDigest(partial) } }).refusals).toContain("baseline has no file list for e2e");
      // A plan that names no base at all.
      expect(decide({ plan: makePlan({ identity: { ...identity, base: null } }) }).refusals).toContain("no baseline: the plan names no base commit (none)");

      // And baselinePlan never invents one.
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files), base: "", head: HEAD, bootstrap: BOOTSTRAP })).toThrow("the base (none) is not a full commit SHA");
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files), base: "0".repeat(40), head: HEAD, bootstrap: BOOTSTRAP })).toThrow(
        `the base ${"0".repeat(40)} is not in this clone's history`,
      );
    });

    it("R4: a head that lowers its floors is held to the base's, and refused when the base's are unknown", () => {
      const lowered = { ...manifest, minimums: { pgtapFiles: 1, migrationChainCounterexamples: 1 } };
      const reports = [
        ...goodReports().filter((report) => !["pgtap", "migrationChain"].includes(report.suite)),
        normalisePgTap(["supabase/tests/database/001_auth.sql .. ok", "Files=1, Tests=20", "Result: PASS"].join("\n")),
        normaliseMigrationChain("--- counterexample: one ---\nmigration-chain: PASS"),
      ];
      const held = decide({ plan: makePlan({ manifest: lowered }), reports });
      expect(held.refusals).toContain("migrationChain: 1 counterexamples ran; at least 3 are required");
      expect(held.refusals).toContain("pgtap: 1 files ran; at least 2 are required");
      expect(held.minimums).toMatchObject({ pgtapFiles: 2, migrationChainCounterexamples: 3 });

      // Before this fix, no base plan meant the head's lowered floors applied and the gate passed.
      const unknown = decide({ plan: makePlan({ manifest: lowered }), basePlan: null, reports });
      expect(unknown.pass).toBe(false);
      expect(unknown.refusals[0]).toMatch(/^no baseline:/);
    });

    it("R2: refuses a main run in which an inherited FV_BENCHMARK=1 ran the benchmarks", () => {
      const benchmarks = { ...manifest, benchmarks: { e2e: [{ file: "e2e/shell.spec.ts", grep: "mobile benchmark" }], integration: [{ file: "tests/integration/authority.test.ts" }] } };
      const plan = makePlan({ manifest: benchmarks });
      expect(plan.benchmarks).toEqual({ e2e: [{ file: "e2e/shell.spec.ts", grep: "mobile benchmark" }], integration: [{ file: "tests/integration/authority.test.ts" }] });

      // Flag off: the benchmark is skipped in the main run and the reviewed skip covers it.
      const knownSkips = [{ suite: "e2e", file: "e2e/shell.spec.ts", title: "/mobile benchmark > /", projects: "*", reason: "opt-in" }];
      const skipped = normalisePlaywright(playwrightJson([...allE2e, ["shell.spec.ts", "mobile", "shell mobile benchmark > times it", "skipped"]]));
      const integrationOff = normaliseVitest("integration", vitestJson([["tests/integration/other.test.ts", "refuses"]]), ROOT);
      const clean = [...goodReports().filter((report) => !["e2e", "integration"].includes(report.suite)), skipped, integrationOff];
      expect(decide({ plan, reports: clean, knownSkips }).refusals.filter((line: string) => line.includes("benchmark"))).toEqual([]);

      // Flag inherited: the benchmark ran (and passed) inside the main E2E and integration runs.
      const ran = normalisePlaywright(playwrightJson([...allE2e, ["shell.spec.ts", "mobile", "shell mobile benchmark > times it"]]));
      const decision = decide({ plan, reports: replace("e2e", ran), knownSkips });
      expect(decision.pass).toBe(false);
      expect(decision.refusals).toContain(
        "e2e: 1 benchmark test(s) ran inside the main suite, so FV_BENCHMARK was on there: e2e:e2e/shell.spec.ts:mobile:shell mobile benchmark > times it",
      );
      expect(decision.refusals).toContain(
        "integration: 1 benchmark test(s) ran inside the main suite, so FV_BENCHMARK was on there: integration:tests/integration/authority.test.ts:suite > refuses",
      );
      // Ordinary tests in a benchmark spec, outside the benchmark block, are not benchmarks.
      expect(decision.refusals.some((line: string) => line.includes("shell.spec.ts:mobile:works"))).toBe(false);
    });
  });

  describe("third review: the bootstrap baseline is independent of the change", () => {
    const deleting = files.filter((file) => file !== "tests/unit/report.test.ts");
    const withoutReport = () => normaliseVitest("unit", vitestJson([["tests/unit/money.test.ts", "adds"]]), ROOT);
    const bootstrapBase = (tree = files) => baselinePlan({ root: ROOT, git: gitWithBase(tree), base: identity.base!, head: HEAD, bootstrap: BOOTSTRAP });

    it("R4: narrowed suite globs and an unretired deletion still refuse the gate", () => {
      // The review's probe: the head narrows its unit globs so the base's report test falls outside
      // them, then deletes that test without retiring it. Manifest validation has nothing to object to.
      const narrowed = { ...manifest, suites: { ...manifest.suites, unit: ["tests/unit/money*.test.ts"] } };
      const head = makePlan({ manifest: narrowed, files: deleting });
      expect(validateManifest(narrowed, head.inventory)).toEqual([]);
      expect(head.inventory.unit).toEqual(["tests/unit/money.test.ts"]);

      // The base's minimum comes from its record's patterns over its own tree, not the head's globs.
      const basePlan = bootstrapBase();
      expect(basePlan.execution.unit.files).toEqual(["tests/unit/money.test.ts", "tests/unit/report.test.ts"]);
      const decision = decide({ plan: head, basePlan, reports: replace("unit", withoutReport()) });
      expect(decision.pass).toBe(false);
      expect(decision.refusals).toContain(
        "unit: the base requires tests/unit/report.test.ts, which this change deletes; retire it in the manifest's retiredTests for review, or keep it",
      );

      // Narrowed globs alone, with the file left in place, are refused too.
      const kept = makePlan({ manifest: narrowed });
      expect(decide({ plan: kept, basePlan, reports: replace("unit", withoutReport()) }).pass).toBe(false);
    });

    it("R4: lowered floors are held to the bootstrap record's floors", () => {
      // The review's second probe: a valid no-selector baseline, and a head that lowers the chain
      // floor to one counterexample and the pgTAP floor to one assertion.
      const lowered = { ...manifest, minimums: { pgtapFiles: 1, pgtapAssertions: 1, migrationChainCounterexamples: 1 } };
      const reports = [
        ...goodReports().filter((report) => !["pgtap", "migrationChain"].includes(report.suite)),
        normalisePgTap(["supabase/tests/database/001_auth.sql .. ok", "supabase/tests/database/002_stock.sql .. ok", "Files=2, Tests=1", "Result: PASS"].join("\n")),
        normaliseMigrationChain("--- counterexample: one ---\nmigration-chain: PASS"),
      ];
      const basePlan = bootstrapBase();
      expect(baselineRefusals(makePlan({ manifest: lowered }), basePlan)).toEqual([]);
      const decision = decide({ plan: makePlan({ manifest: lowered }), basePlan, reports });
      expect(decision.pass).toBe(false);
      expect(decision.refusals).toContain("migrationChain: 1 counterexamples ran; at least 3 are required");
      expect(decision.refusals).toContain("pgtap: 1 assertions ran; at least 40 are required");
      expect(decision.minimums).toMatchObject({ pgtapFiles: 2, pgtapAssertions: 40, migrationChainCounterexamples: 3 });
    });

    it("R4: a base with no approved record, or one its tree contradicts, has no baseline", () => {
      // No record: refused, never planned from the head's manifest.
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files), base: identity.base!, head: HEAD, bootstrap: {} })).toThrow(
        `the base ${identity.base} has no selector and no approved bootstrap record, so its minimum is unknown`,
      );
      // The record names another tree.
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files, "d".repeat(40)), base: identity.base!, head: HEAD, bootstrap: BOOTSTRAP })).toThrow(
        `the base ${identity.base} has tree ${"d".repeat(40)}, not the approved ${BASE_TREE}`,
      );
      // The tree holds a test the record's count leaves out, or the record's count is lowered.
      expect(() => bootstrapBase([...files, "tests/unit/extra.test.tsx"])).toThrow("unit holds 3 files, the record 2");
      const record = BOOTSTRAP[identity.base!];
      const shrunk = { [identity.base!]: { ...record, counts: { ...record.counts, pgtap: 1 } } };
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files), base: identity.base!, head: HEAD, bootstrap: shrunk })).toThrow("pgtap holds 2 files, the record 1");
      // Floors the tree can confirm must match it.
      const fewerFiles = { [identity.base!]: { ...record, minimums: { ...record.minimums, pgtapFiles: 1 } } };
      expect(() => baselinePlan({ root: ROOT, git: gitWithBase(files), base: identity.base!, head: HEAD, bootstrap: fewerFiles })).toThrow(
        "the tree holds 2 pgTAP files, the record's floor is 1",
      );
      expect(() => bootstrapBase([...files, "supabase/migrations/001_init.sql"])).toThrow("the tree holds 1 migrations, the record 0");
    });

    it("R4: the record for the real base pins its tree, its test counts and the measured floors", () => {
      const record = BOOTSTRAP_BASELINES["2938b3cbaf367069d3b23ff1dbbb793412f8b3af"];
      expect(record.tree).toBe("8d35ee599f654df75a1ce2fc2e8dbb5ec07802cf");
      expect(record.counts).toEqual({ unit: 57, integration: 33, e2e: 25, pgtap: 28 });
      expect(record.minimums).toEqual({
        migrations: 55,
        pgtapFiles: 28,
        pgtapAssertions: 1926,
        migrationChainCounterexamples: 155,
        responsiveProjects: ["mobile", "tablet", "desktop"],
      });
    });
  });

  describe("the record for the rebased base, v0.12.3 (#100)", () => {
    const OLD_BASE = "2938b3cbaf367069d3b23ff1dbbb793412f8b3af";
    const NEW_BASE = "61664cfdfde469955c35a862234c857db7246cfe";
    const NEW_TREE = "b2a6e667f27f82073d3e1493d25034746984941e";
    const numbered = (count: number, path: (n: number) => string) => Array.from({ length: count }, (_, n) => path(n + 1));
    // A tree shaped like the new base: 59 unit, 33 integration, 25 E2E and 28 pgTAP files, 55 migrations.
    const newBaseTree = [
      "README.md",
      ...numbered(57, (n) => `tests/unit/u${n}.test.ts`),
      "tests/unit/app-shell.test.tsx",
      "tests/unit/pager.test.tsx",
      ...numbered(33, (n) => `tests/integration/i${n}.test.ts`),
      ...numbered(25, (n) => `e2e/e${n}.spec.ts`),
      ...numbered(28, (n) => `supabase/tests/database/${n}.sql`),
      ...numbered(55, (n) => `supabase/migrations/${n}.sql`),
    ];
    /** A git that knows one commit, `base`, holding `tree` with tree id `treeId` and no selector. */
    const gitAt = (base: string, tree: string[], treeId: string) => (args: string[]) => {
      if (args[0] === "cat-file" && args[2] === `${base}^{commit}`) return "";
      if (args[0] === "rev-parse" && args[1] === `${base}^{tree}`) return treeId;
      if (args[0] === "ls-tree" && args.includes(base)) return (args.at(-1) === "scripts/testing" ? [] : tree).join("\0");
      throw new Error(`git ${args.join(" ")} exited 128: unknown revision`);
    };
    const plan = (tree = newBaseTree, treeId = NEW_TREE, base = NEW_BASE, bootstrap: Record<string, unknown> = BOOTSTRAP_BASELINES) =>
      baselinePlan({ root: ROOT, git: gitAt(base, tree, treeId), base, head: HEAD, bootstrap });

    it("pins the new base's tree and counts, and keeps the floors measured for the old base", () => {
      const record = BOOTSTRAP_BASELINES[NEW_BASE];
      expect(record.tree).toBe(NEW_TREE);
      expect(record.counts).toEqual({ unit: 59, integration: 33, e2e: 25, pgtap: 28 });
      expect(record.minimums).toEqual(BOOTSTRAP_BASELINES[OLD_BASE].minimums);
      // The same runner configuration decides which files count as tests on both bases.
      expect(record.suites).toEqual(BOOTSTRAP_BASELINES[OLD_BASE].suites);
      expect(record.migrations).toEqual(BOOTSTRAP_BASELINES[OLD_BASE].migrations);
      // The old base's record is still there, unchanged, and nothing else is approved.
      expect(Object.keys(BOOTSTRAP_BASELINES).sort()).toEqual([OLD_BASE, NEW_BASE]);
      expect(BOOTSTRAP_BASELINES[OLD_BASE].tree).toBe("8d35ee599f654df75a1ce2fc2e8dbb5ec07802cf");
      expect(BOOTSTRAP_BASELINES[OLD_BASE].counts).toEqual({ unit: 57, integration: 33, e2e: 25, pgtap: 28 });
    });

    it("plans a matching tree in full with every test required and the record's floors", () => {
      const basePlan = plan();
      expect(basePlan.mode).toBe("full");
      expect(basePlan.identity).toMatchObject({ base: NEW_BASE, inventoryRev: NEW_BASE, baseTree: NEW_TREE });
      expect(basePlan.execution.unit.files).toHaveLength(59);
      expect(basePlan.execution.unit.files).toContain("tests/unit/app-shell.test.tsx");
      expect(basePlan.execution.integration.files).toHaveLength(33);
      expect(basePlan.execution.e2e.files).toHaveLength(25);
      expect(basePlan.execution.pgtap.files).toHaveLength(28);
      expect(basePlan.execution.projects).toEqual(["mobile", "tablet", "desktop"]);
      expect(basePlan.minimums).toMatchObject({ migrations: 55, pgtapFiles: 28, pgtapAssertions: 1926, migrationChainCounterexamples: 155 });
    });

    it("refuses the new base when its tree, test counts, migrations or pgTAP files disagree with the record", () => {
      expect(() => plan(newBaseTree, "d".repeat(40))).toThrow(`the base ${NEW_BASE} has tree ${"d".repeat(40)}, not the approved ${NEW_TREE}`);
      // The old base's record does not cover the new tree, and the new record does not cover the old one.
      expect(() => plan(newBaseTree, NEW_TREE, OLD_BASE)).toThrow(`the base ${OLD_BASE} has tree ${NEW_TREE}, not the approved 8d35ee599f654df75a1ce2fc2e8dbb5ec07802cf`);
      // Each count is checked on its own.
      expect(() => plan(newBaseTree.filter((file) => file !== "tests/unit/pager.test.tsx"))).toThrow("unit holds 58 files, the record 59");
      expect(() => plan([...newBaseTree, "tests/integration/extra.test.ts"])).toThrow("integration holds 34 files, the record 33");
      expect(() => plan(newBaseTree.filter((file) => file !== "e2e/e25.spec.ts"))).toThrow("e2e holds 24 files, the record 25");
      expect(() => plan([...newBaseTree, "supabase/migrations/56.sql"])).toThrow("the tree holds 56 migrations, the record 55");
      expect(() => plan(newBaseTree.filter((file) => file !== "supabase/tests/database/28.sql"))).toThrow(
        "pgtap holds 27 files, the record 28; the tree holds 27 pgTAP files, the record's floor is 28",
      );
      // Without its record the new base has no baseline at all.
      const withoutNew = Object.fromEntries(Object.entries(BOOTSTRAP_BASELINES).filter(([base]) => base !== NEW_BASE));
      expect(() => plan(newBaseTree, NEW_TREE, NEW_BASE, withoutNew)).toThrow(
        `the base ${NEW_BASE} has no selector and no approved bootstrap record, so its minimum is unknown`,
      );
    });
  });

  it("refuses unreadable report files by name", () => {
    expect(decide({ reportProblems: ["unit.vitest.json cannot be parsed: Unexpected token"] }).refusals).toContain(
      "unit.vitest.json cannot be parsed: Unexpected token",
    );
  });
});
