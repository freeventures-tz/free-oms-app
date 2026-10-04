import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normaliseVitest } from "@/scripts/testing/reports.mjs";
import ResultsReporter from "@/scripts/testing/vitest-results-reporter.mjs";

/**
 * The results reporter, fed stand-ins for Vitest's test-module objects, and read back through the
 * same normaliser the gate uses. A failed test, a skipped one and a file that failed to load must
 * all survive the round trip, or the gate would count them as passing or not at all.
 */

function testCase(name: string, state: string, suite?: string) {
  const parent = suite ? { type: "suite", name: suite, parent: { type: "module" } } : { type: "module" };
  return { name, parent, result: () => ({ state }), diagnostic: () => ({ duration: 4, retryCount: 0 }) };
}

function testModule(moduleId: string, state: string, tests: ReturnType<typeof testCase>[]) {
  return { moduleId, state: () => state, diagnostic: () => ({ duration: 10 }), children: { allTests: () => tests } };
}

describe("results reporter", () => {
  it("writes every test with its suite titles and state, and the run's verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-reporter-"));
    const outputFile = join(dir, "unit.vitest.json");
    const reporter = new ResultsReporter({ outputFile });
    reporter.onTestRunEnd([
      testModule("/repo/tests/unit/a.test.ts", "passed", [testCase("adds", "passed", "money"), testCase("later", "skipped")]),
      testModule("/repo/tests/unit/b.test.ts", "failed", [testCase("pages", "failed", "report")]),
      testModule("/repo/tests/unit/c.test.ts", "failed", []),
    ]);

    const json = JSON.parse(readFileSync(outputFile, "utf8"));
    expect(json.success).toBe(false);
    const report = normaliseVitest("unit", json, "/repo");
    expect(report.runnerSuccess).toBe(false);
    expect(report.tests.map((test: { id: string; status: string }) => [test.id, test.status])).toEqual([
      ["unit:tests/unit/a.test.ts:money > adds", "passed"],
      ["unit:tests/unit/a.test.ts:later", "skipped"],
      ["unit:tests/unit/b.test.ts:report > pages", "failed"],
      ["unit:tests/unit/c.test.ts:(file failed to run)", "failed"],
    ]);
  });

  it("counts an unhandled error as a failed run even when every test passed", () => {
    const outputFile = join(mkdtempSync(join(tmpdir(), "oms-reporter-")), "unit.vitest.json");
    new ResultsReporter({ outputFile }).onTestRunEnd([testModule("/repo/tests/unit/a.test.ts", "passed", [testCase("adds", "passed")])], [new Error("boom")]);
    expect(JSON.parse(readFileSync(outputFile, "utf8")).success).toBe(false);
  });
});
