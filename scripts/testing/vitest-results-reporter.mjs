/**
 * A Vitest reporter that writes one results file when the run ends, and does nothing while tests
 * run.
 *
 * It listens to nothing until the run is over, then writes the fields reports.mjs reads, in the
 * shape of Vitest's JSON reporter, to `$OMS_TEST_RESULTS_DIR/<project>.vitest.json`. It adds the
 * run's wall time, which the built-in reporter does not record.
 *
 * It was written while chasing failures in timing-sensitive unit tests (`imprest-count-lost-response`,
 * `imprest-retirement`, `order-confirmation-refusal`). Those turned out to fail on the unchanged
 * base commit too, under load, with no reporter at all: they are pre-existing flakes, not caused by
 * any reporter.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATUS = { passed: "passed", failed: "failed", skipped: "skipped", pending: "skipped" };

export default class ResultsReporter {
  /** @param {{ outputFile: string }} options */
  constructor(options) {
    this.outputFile = options.outputFile;
    this.startedAt = Date.now();
  }

  /** @param {ReadonlyArray<any>} testModules @param {ReadonlyArray<unknown>} unhandledErrors */
  onTestRunEnd(testModules, unhandledErrors = []) {
    const testResults = testModules.map((module) => {
      const tests = [...module.children.allTests()];
      const diagnostic = module.diagnostic();
      return {
        name: module.moduleId,
        status: module.state() === "failed" || tests.some((test) => test.result().state === "failed") ? "failed" : "passed",
        durationMs: diagnostic.duration,
        assertionResults: tests.map((test) => {
          const titles = [];
          for (let parent = test.parent; parent && parent.type === "suite"; parent = parent.parent) titles.unshift(parent.name);
          return {
            ancestorTitles: titles,
            title: test.name,
            status: STATUS[test.result().state] ?? "failed",
            duration: test.diagnostic()?.duration ?? 0,
            retryCount: test.diagnostic()?.retryCount ?? 0,
          };
        }),
      };
    });
    const failed = testResults.some((file) => file.status === "failed") || unhandledErrors.length > 0;
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify({ success: !failed, unhandledErrors: unhandledErrors.length, wallMs: Date.now() - this.startedAt, testResults }, null, 2)}\n`);
  }
}
