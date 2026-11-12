// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runBenchmarksCli } from "@/scripts/testing/benchmarks.mjs";
import { runCheckCli } from "@/scripts/testing/check.mjs";
import { gitRunner } from "@/scripts/testing/common.mjs";
import { runPlanCli } from "@/scripts/testing/plan.mjs";
import { describeCandidate, prepareManifest, runReleaseCli } from "@/scripts/testing/release.mjs";
import { freshResultsDir } from "@/scripts/testing/run.mjs";
import { runSelectCli } from "@/scripts/testing/select.mjs";
import { testEnvironment } from "@/scripts/testing/target-guard.mjs";

/**
 * Every top-level run (`npm run test:plan`, `npm run check`, `npm run test:release`) keeps its
 * results in a folder no earlier run has written to.
 *
 * They used to share one folder. A gate reads every report in the folder it is given, so a failed
 * report, a shard, a listing or a benchmark pass left by an earlier run refused a later run whose
 * own checks had all passed. The opposite was worse: when a runner exited successfully without
 * writing its report, the earlier run's passing report was read as this run's.
 *
 * These tests drive the three real entry points over a small git repository. Only the runners are
 * stand-ins: `runner()` plays Vitest, Playwright and the Supabase CLI, and writes the same report
 * files they do. The benchmark step calls the real `benchmarks.mjs` entry, which has to keep adding
 * to the folder of the run that started it.
 */

const LONG = 120_000;
const MANIFEST = {
  version: 1,
  activation: { selectiveEnforcement: true },
  suites: {
    unit: ["tests/unit/**/*.test.ts"],
    integration: ["tests/integration/**/*.test.ts"],
    e2e: ["e2e/**/*.spec.ts"],
    pgtap: ["supabase/tests/database/*.sql"],
  },
  minimums: {},
  retiredTests: [],
  e2eShardMinutes: 6,
  e2eMinutes: {},
  benchmarks: {
    e2e: [{ file: "e2e/bench.spec.ts", grep: "mobile benchmark" }],
    integration: [{ file: "tests/integration/bench.test.ts" }],
  },
  forceFull: [{ pattern: "scripts/**", reason: "test infrastructure" }],
  appCritical: [],
  appWide: [],
  docsOnly: ["README.md"],
  domains: {},
  groups: { integration: {}, e2e: {} },
  independent: { integration: [], e2e: [] },
  smoke: { pgtap: [], integration: [], e2e: [] },
};
const KNOWN_SKIPS = {
  skips: [
    { suite: "integration", file: "tests/integration/bench.test.ts", title: "/^timings > /", projects: "*", gates: ["Development Gate"], reason: "opt-in benchmark" },
    { suite: "e2e", file: "e2e/bench.spec.ts", title: "/mobile benchmark/", projects: "*", gates: ["Development Gate"], reason: "opt-in benchmark" },
    { suite: "e2e", file: "e2e/bench.spec.ts", title: "/mobile benchmark/", projects: ["tablet", "desktop"], reason: "the benchmark runs on the phone only" },
  ],
};
const PROJECTS = ["mobile", "tablet", "desktop"];
const CHAIN_LOG = "--- counterexample: a renamed column ---\nmigration-chain: PASS\n";
const PGTAP_LOG = "supabase/tests/database/001_a.sql .. ok\nFiles=1, Tests=3,  1 wallclock secs\nResult: PASS\n";

type Run = (command: string, args: string[]) => { status: number; stdout: string; stderr: string };
type Fixture = { root: string; base: string; head: string; git: (args: string[]) => string; baselineRun: Run };
type Scenario = { unit?: "pass" | "fail" | "silent"; integration?: "pass" | "silent"; e2e?: "pass" | "silent"; artifact?: "record" | "silent" };
type Spawned = { env: Record<string, string | undefined> };

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one test in each suite, a benchmark in two of them, a build, and two commits. */
function buildRepository(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "oms-fresh-results-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  // The base's own selector plans the baseline, so the repository carries the real one and the
  // files it imports. Every file here is read back from git on each run, so no others are copied.
  mkdirSync(join(root, "scripts/testing"), { recursive: true });
  for (const name of ["select.mjs", "ci.mjs", "graph.mjs", "common.mjs"]) {
    cpSync(resolve(process.cwd(), "scripts/testing", name), join(root, "scripts/testing", name));
  }
  write("scripts/testing/manifest.json", `${JSON.stringify(MANIFEST, null, 2)}\n`);
  write("scripts/testing/known-skips.json", `${JSON.stringify(KNOWN_SKIPS, null, 2)}\n`);
  write(".gitignore", "/oms-test/\n/.next/\n");
  write("package.json", `${JSON.stringify({ name: "fixture", version: "0.0.1", dependencies: {}, devDependencies: {} }, null, 2)}\n`);
  write("package-lock.json", `${JSON.stringify({ name: "fixture", version: "0.0.1", lockfileVersion: 3, packages: { "": { version: "0.0.1" } } }, null, 2)}\n`);
  write("CHANGELOG.md", "# Changelog\n\n## [0.0.1] — 2026-01-01\n\nA fixture.\n");
  write("README.md", "A fixture repository.\n");
  write("lib/a.ts", "export const a = 1;\n");
  write("tests/unit/a.test.ts", "export {};\n");
  write("tests/integration/b.test.ts", "export {};\n");
  write("tests/integration/bench.test.ts", "export {};\n");
  write("e2e/c.spec.ts", "export {};\n");
  write("e2e/bench.spec.ts", "export {};\n");
  write("supabase/tests/database/001_a.sql", "select 1;\n");
  write("supabase/migrations/0001_init.sql", "select 1;\n");
  write("supabase/release-checks/history.txt", "0001_init\n");
  write(".next/server/app.js", "built\n");
  write(".next/static/chunk.js", "built\n");
  write(".next/BUILD_ID", "fixture\n");

  git(root, ["init", "--quiet", "--initial-branch=main"]);
  for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) {
    git(root, ["config", key, value]);
  }
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "-b", "task"]);
  write("lib/a.ts", "export const a = 2;\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", "head"]);
  return { root, base, head: git(root, ["rev-parse", "HEAD"]), git: rememberingGit(root), baselineRun: baselineInProcess(root) };
}

/**
 * The base's selector, run in this process and once per question.
 *
 * A real run copies the base's selector into the temp folder and starts Node on it. On Windows, a
 * script run from the temp folder a moment after it was written makes other test files' temp
 * folders fail to delete ("directory not empty", in `migration-chain-orchestration.test.ts`, 4 runs
 * of 4), and unit files run side by side. The repository's selector here is this checkout's, so
 * calling it directly gives the same plan without starting anything.
 */
function baselineInProcess(root: string): Run {
  const plans = new Map<string, string>();
  return (_node, args) => {
    const output = args[args.indexOf("--output") + 1];
    const question = args.filter((arg, index) => arg !== output && index > 0 && args[index - 1] !== "--manifest").join(" ");
    try {
      if (!plans.has(question)) {
        runSelectCli(args.slice(1), root);
        plans.set(question, readFileSync(output, "utf8"));
      } else writeFileSync(output, plans.get(question)!);
      return { status: 0, stdout: "", stderr: "" };
    } catch (error) {
      return { status: 1, stdout: "", stderr: String(error) };
    }
  };
}

/**
 * Real git, asked each question once. Nothing git tracks changes after the two commits (results go
 * to an ignored folder), so every answer holds for the whole file, and a run here asks about twenty
 * questions. Starting a process for each is most of this file's time on Windows.
 */
function rememberingGit(root: string) {
  const real = gitRunner(root);
  const answers = new Map<string, string>();
  return (args: string[]) => {
    const key = args.join("\0");
    if (!answers.has(key)) answers.set(key, real(args));
    return answers.get(key)!;
  };
}

function vitestReport(root: string, tests: Array<{ file: string; ancestors: string[]; title: string; status: "passed" | "failed" | "pending" }>) {
  return {
    success: tests.every((test) => test.status !== "failed"),
    wallMs: 5,
    testResults: tests.map((test) => ({
      name: join(root, test.file),
      status: test.status === "failed" ? "failed" : "passed",
      assertionResults: [{ ancestorTitles: test.ancestors, title: test.title, status: test.status, duration: 1, retryCount: 0 }],
    })),
  };
}

function playwrightReport(specs: Array<{ file: string; title: string; runs: Array<{ project: string; status: "expected" | "unexpected" | "skipped" }> }>) {
  const runs = specs.flatMap((spec) => spec.runs);
  return {
    suites: specs.map((spec) => ({
      title: spec.file,
      file: spec.file,
      specs: [
        {
          title: spec.title,
          file: spec.file,
          tests: spec.runs.map((run) => ({ projectName: run.project, status: run.status, results: run.status === "skipped" ? [] : [{ duration: 3 }] })),
        },
      ],
      suites: [],
    })),
    stats: { unexpected: runs.filter((run) => run.status === "unexpected").length, duration: 9 },
    errors: [],
  };
}

const UNIT = { file: "tests/unit/a.test.ts", ancestors: ["a"], title: "adds" };
const HTTP = { file: "tests/integration/b.test.ts", ancestors: ["b"], title: "reads" };
const HTTP_BENCH = { file: "tests/integration/bench.test.ts", ancestors: ["timings"], title: "records" };
const everywhere = (status: "expected" | "unexpected" | "skipped") => PROJECTS.map((project) => ({ project, status }));
const E2E_MAIN = playwrightReport([
  { file: "c.spec.ts", title: "shows the page", runs: everywhere("expected") },
  { file: "bench.spec.ts", title: "mobile benchmark saves", runs: everywhere("skipped") },
]);
const E2E_BENCH = playwrightReport([{ file: "bench.spec.ts", title: "mobile benchmark saves", runs: [{ project: "mobile", status: "expected" }] }]);

/**
 * Stands in for the runners. It writes what each one writes, where each one writes it: a listing to
 * the path it was given, a report to `OMS_TEST_RESULTS_DIR`, a log to stdout. `silent` is a runner
 * that exits successfully and writes nothing.
 */
function runner({ root, git: remembered, baselineRun }: Fixture, scenario: Scenario = {}) {
  const calls: string[] = [];
  const guard = () => undefined;
  const print = () => undefined;
  const done = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const spawn = (_command: string, rawArgs: string[], options: Spawned) => {
    const args = rawArgs.map((arg) => arg.replace(/^"(.*)"$/, "$1"));
    const line = args.join(" ");
    calls.push(line);
    const dir = options.env.OMS_TEST_RESULTS_DIR ?? "";
    const save = (name: string, value: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
    const listTo = (value: unknown) => writeFileSync(args.find((arg) => arg.startsWith("--json="))!.slice("--json=".length), JSON.stringify(value));

    // The real entry: it must add its passes to the folder of the run that started it.
    if (line.includes("benchmarks.mjs")) {
      return { status: runBenchmarksCli(args.slice(1), root, { spawn, guard, print }, options.env).ok ? 0 : 1, stdout: "", stderr: "" };
    }
    if (line.includes("--describe-artifact")) {
      if (scenario.artifact !== "silent") runReleaseCli(args.slice(1), root, { git: remembered });
      return done();
    }
    if (line.startsWith("vitest list --project unit")) listTo([{ name: "a > adds", file: join(root, UNIT.file) }]);
    else if (line.startsWith("vitest run --project unit")) {
      if (scenario.unit === "fail") save("unit.vitest.json", vitestReport(root, [{ ...UNIT, status: "failed" }]));
      else if (scenario.unit !== "silent") save("unit.vitest.json", vitestReport(root, [{ ...UNIT, status: "passed" }]));
      return scenario.unit === "fail" ? { status: 1, stdout: "", stderr: "" } : done();
    } else if (line.startsWith("vitest list --project integration")) {
      listTo([{ name: "b > reads", file: join(root, HTTP.file) }, { name: "timings > records", file: join(root, HTTP_BENCH.file) }]);
    } else if (line.startsWith("vitest run --project integration")) {
      if (options.env.OMS_TEST_SUITE === "integration-benchmark") save("integration-benchmark.vitest.json", vitestReport(root, [{ ...HTTP_BENCH, status: "passed" }]));
      else if (scenario.integration !== "silent") save("integration.vitest.json", vitestReport(root, [{ ...HTTP, status: "passed" }, { ...HTTP_BENCH, status: "pending" }]));
    } else if (line.startsWith("playwright test --list")) return done(JSON.stringify(E2E_MAIN));
    else if (line.startsWith("playwright test")) {
      if (options.env.OMS_E2E_RESULTS_NAME) save(options.env.OMS_E2E_RESULTS_NAME, E2E_BENCH);
      else if (scenario.e2e !== "silent") save("e2e.playwright.json", E2E_MAIN);
    } else if (line === "run test:migration-chain") return done(CHAIN_LOG);
    else if (line === "supabase test db") return done(PGTAP_LOG);
    return done();
  };
  return { spawn, guard, print, calls, git: remembered, baselineRun };
}

/**
 * What an earlier run could leave in a results folder, one of each kind the gate reads: a failed
 * report, a failed benchmark pass, shard reports, listings naming tests that no longer exist, and
 * the record of another build. Any one of them refuses a run that reads the folder.
 */
function leaveEarlierResults(dir: string, root: string) {
  mkdirSync(dir, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  save("unit.vitest.json", vitestReport(root, [{ ...UNIT, status: "failed" }]));
  save("e2e-benchmark-old.playwright.json", playwrightReport([{ file: "bench.spec.ts", title: "mobile benchmark saves", runs: [{ project: "mobile", status: "unexpected" }] }]));
  save("e2e.playwright.shard-1-of-2.json", playwrightReport([{ file: "c.spec.ts", title: "shows the page", runs: everywhere("unexpected") }]));
  save("migration-chain.shard-1-of-4.log", CHAIN_LOG);
  save("integration.vitest-list.json", [{ name: "b > a test since deleted", file: join(root, HTTP.file) }]);
  save("e2e.playwright-list.shard-1-of-2.json", playwrightReport([{ file: "c.spec.ts", title: "a journey since deleted", runs: everywhere("skipped") }]));
  save("artifact.json", { commit: "f".repeat(40), tree: "e".repeat(40), clean: true, digest: "another build", files: 1, cacheFiles: 0, buildEnvironment: {} });
  return dir;
}

/** The folder a finished run wrote to. A dry run, or a check of a manifest, has none. */
function folder(result: { resultsDir?: string }): string {
  if (!result.resultsDir) throw new Error("the run reported no results folder");
  return result.resultsDir;
}

/** Every file under a folder with a digest of its bytes, so "unchanged" means byte for byte. */
function contents(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, contents(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return out;
}

describe("each top-level run keeps its own results", () => {
  let fixture: Fixture;
  let planArgs: string[];
  let candidate: string;
  const inRepo = (path: string) => join(fixture.root, path);

  beforeAll(() => {
    fixture = buildRepository();
    const plan = inRepo("oms-test/plan/plan.json");
    runSelectCli(["--base", fixture.base, "--head", fixture.head, "--mode", "shadow", "--output", plan], fixture.root);
    planArgs = ["--plan", plan, "--tier", "development", "--keep-going"];
    candidate = inRepo("oms-test/candidate.json");
    const described = describeCandidate(fixture.root, fixture.git, testEnvironment(fixture.root));
    writeFileSync(candidate, `${JSON.stringify(prepareManifest(described, { productionBase: fixture.base }))}\n`);
  }, LONG);

  afterAll(() => rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  beforeEach(() => {
    for (const dir of ["oms-test/runs", "oms-test/results", "oms-test/release", "oms-test/kept"]) rmSync(inRepo(dir), { recursive: true, force: true });
  });

  describe("npm run test:plan", () => {
    it(
      "is not refused for a failure, a benchmark pass, shards, listings or a build record that earlier runs left",
      () => {
        // The folder every run used to share, as an earlier run could have left it.
        const shared = leaveEarlierResults(inRepo("oms-test/results"), fixture.root);
        const first = runPlanCli(planArgs, fixture.root, runner(fixture, { unit: "fail" }));
        expect(first.ok).toBe(false);
        expect(first.decision.refusals.join("\n")).toMatch(/unit: 1 failed/);
        const before = { shared: contents(shared), first: contents(folder(first)) };

        const second = runPlanCli(planArgs, fixture.root, runner(fixture));

        expect(second.decision.refusals).toEqual([]);
        expect(second.ok).toBe(true);
        expect(second.resultsDir).not.toBe(first.resultsDir);
        expect(Object.keys(contents(folder(second)))).toEqual([
          "artifact.json",
          "e2e.playwright-list.json",
          "e2e.playwright.json",
          "gate-report.json",
          "integration.vitest-list.json",
          "integration.vitest.json",
          "migration-chain.log",
          "pgtap.log",
          "timing.json",
          "unit.vitest-list.json",
          "unit.vitest.json",
        ]);
        // Earlier evidence is kept, byte for byte.
        expect(contents(shared)).toEqual(before.shared);
        expect(contents(folder(first))).toEqual(before.first);
      },
      LONG,
    );

    it(
      "refuses when runners exit successfully without their reports, however well the last run went",
      () => {
        expect(runPlanCli(planArgs, fixture.root, runner(fixture)).ok).toBe(true);

        const next = runPlanCli(planArgs, fixture.root, runner(fixture, { unit: "silent", integration: "silent", e2e: "silent" }));

        expect(next.decision.refusals).toEqual(
          expect.arrayContaining([
            "unit: no report arrived from job static",
            "integration: no report arrived from job integration",
            "e2e: no report arrived from job e2e",
          ]),
        );
        expect(next.ok).toBe(false);
      },
      LONG,
    );

    it(
      "keeps the benchmark passes of one run in that run's folder, beside its main reports, and the gate reads both",
      () => {
        const result = runPlanCli([...planArgs, "--benchmarks"], fixture.root, runner(fixture));

        expect(result.decision.refusals).toEqual([]);
        expect(result.decision.summary.benchmarks).toMatchObject({
          passed: 2,
          failed: 0,
          passes: ["e2e-benchmark-bench.playwright.json", "integration-benchmark.vitest.json"],
        });
        expect(Object.keys(contents(folder(result)))).toEqual(
          expect.arrayContaining(["e2e.playwright.json", "e2e-benchmark-bench.playwright.json", "integration.vitest.json", "integration-benchmark.vitest.json"]),
        );
      },
      LONG,
    );

    it(
      "refuses a --results folder that already holds files, before any step runs, and leaves it as it was",
      () => {
        const kept = leaveEarlierResults(inRepo("oms-test/kept"), fixture.root);
        const before = contents(kept);

        for (const tier of ["local", "development"]) {
          const stand = runner(fixture);
          expect(() => runPlanCli(["--plan", planArgs[1], "--tier", tier, "--results", kept], fixture.root, stand)).toThrow(
            /already holds 7 entries from an earlier run/,
          );
          expect(stand.calls).toEqual([]);
        }
        expect(contents(kept)).toEqual(before);
      },
      LONG,
    );

    it(
      "uses a --results folder that does not exist yet as given",
      () => {
        const fresh = inRepo("oms-test/kept/new");

        const result = runPlanCli(["--plan", planArgs[1], "--tier", "local", "--results", fresh], fixture.root, runner(fixture));

        expect(result.resultsDir).toBe(fresh);
        expect(result.ok).toBe(true);
        expect(existsSync(join(fresh, "timing.json"))).toBe(true);
      },
      LONG,
    );
  });

  describe("npm run check", () => {
    it(
      "writes each run to its own folder, and changes nothing an earlier run wrote",
      () => {
        const shared = leaveEarlierResults(inRepo("oms-test/results"), fixture.root);
        const sharedBefore = contents(shared);

        const first = runCheckCli([], fixture.root, runner(fixture, { unit: "fail" }));
        expect(first.ok).toBe(false);
        const firstBefore = contents(folder(first));
        expect(Object.keys(firstBefore)).toContain("unit.vitest.json");
        const second = runCheckCli([], fixture.root, runner(fixture));
        expect(second.ok).toBe(true);

        expect(second.resultsDir).not.toBe(first.resultsDir);
        expect(dirname(folder(first))).toBe(inRepo(join("oms-test", "runs")));
        expect(dirname(folder(second))).toBe(inRepo(join("oms-test", "runs")));
        expect(contents(folder(first))).toEqual(firstBefore);
        expect(contents(shared)).toEqual(sharedBefore);
      },
      LONG,
    );
  });

  describe("npm run test:release", () => {
    it(
      "judges each of three runs in a row on its own evidence: a failure, a pass, then a pass that recorded no build",
      () => {
        // `oms-test/release` was the folder every local release run shared.
        const shared = leaveEarlierResults(inRepo("oms-test/release"), fixture.root);
        const args = ["--manifest", candidate, "--keep-going"];
        const first = runReleaseCli(args, fixture.root, runner(fixture, { unit: "fail" }));
        expect(first.ok).toBe(false);
        const before = { shared: contents(shared), first: contents(folder(first)) };

        // Not refused for what the failed run and the shared folder hold.
        const second = runReleaseCli(args, fixture.root, runner(fixture));
        expect(second.decision.refusals).toEqual([]);
        expect(second.ok).toBe(true);
        expect(second.resultsDir).not.toBe(first.resultsDir);
        expect(existsSync(join(folder(second), "candidate-final.json"))).toBe(true);
        expect(existsSync(join(folder(first), "candidate-final.json"))).toBe(false);
        const secondBefore = contents(folder(second));

        // Not passed on the build record the second run left.
        const third = runReleaseCli(args, fixture.root, runner(fixture, { artifact: "silent" }));
        expect(third.decision.refusals).toContain("no build artifact was recorded by the E2E job");
        expect(third.ok).toBe(false);
        expect(existsSync(join(folder(third), "candidate-final.json"))).toBe(false);

        expect(contents(shared)).toEqual(before.shared);
        expect(contents(folder(first))).toEqual(before.first);
        expect(contents(folder(second))).toEqual(secondBefore);
      },
      LONG,
    );

    it(
      "refuses a --results folder that already holds files, before any step runs, and leaves it as it was",
      () => {
        const kept = leaveEarlierResults(inRepo("oms-test/kept"), fixture.root);
        const before = contents(kept);
        const stand = runner(fixture);

        expect(() => runReleaseCli(["--manifest", candidate, "--results", kept], fixture.root, stand)).toThrow(/already holds 7 entries from an earlier run/);

        expect(stand.calls).toEqual([]);
        expect(contents(kept)).toEqual(before);
      },
      LONG,
    );
  });

  describe("the benchmark entry, on its own", () => {
    it("adds its passes to a folder that already holds this run's reports, and changes none of them", () => {
      const dir = inRepo("oms-test/kept");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "e2e.playwright.json"), `${JSON.stringify(E2E_MAIN)}\n`);
      const before = contents(dir);

      const { ok } = runBenchmarksCli(["--suite", "e2e", "--results", dir], fixture.root, runner(fixture), {});

      expect(ok).toBe(true);
      expect(contents(dir)).toEqual({ ...before, "e2e-benchmark-bench.playwright.json": expect.any(String) });
    });
  });
});

describe("a fresh results folder", () => {
  const root = () => mkdtempSync(join(tmpdir(), "oms-fresh-dir-"));

  it("is new for each run, even for two runs of one kind started in the same millisecond", () => {
    const at = root();
    const now = () => Date.UTC(2026, 10, 11, 9, 30, 12, 345);

    const first = freshResultsDir({ root: at, kind: "check", now });
    const second = freshResultsDir({ root: at, kind: "check", now });

    expect(first).toBe(join(at, "oms-test", "runs", "2026-11-11T09-30-12-345Z-check"));
    expect(second).toBe(join(at, "oms-test", "runs", "2026-11-11T09-30-12-345Z-check-2"));
    expect(readdirSync(first)).toEqual([]);
    expect(readdirSync(second)).toEqual([]);
  });

  it("uses a named folder that is empty or does not exist yet", () => {
    const at = root();
    mkdirSync(join(at, "empty"));

    expect(freshResultsDir({ root: at, explicit: "empty", kind: "plan" })).toBe(join(at, "empty"));
    expect(freshResultsDir({ root: at, explicit: "deep/new", kind: "plan" })).toBe(join(at, "deep", "new"));
    expect(readdirSync(join(at, "deep", "new"))).toEqual([]);
  });

  it("refuses a named path that is a file, or a folder holding anything at all", () => {
    const at = root();
    writeFileSync(join(at, "report.json"), "{}\n");
    mkdirSync(join(at, "used", "nested"), { recursive: true });

    expect(() => freshResultsDir({ root: at, explicit: "report.json", kind: "plan" })).toThrow(/is a file, not a folder/);
    expect(() => freshResultsDir({ root: at, explicit: "used", kind: "plan" })).toThrow(/already holds 1 entry from an earlier run/);
    expect(readdirSync(join(at, "used"))).toEqual(["nested"]);
  });
});
