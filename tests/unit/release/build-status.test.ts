// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE, REPOSITORY, useBuildFixture, type BuildReport } from "./support/build-harness";

type StatusReport = {
  command: string;
  decision: string;
  sha: string | null;
  written: boolean;
  evaluation: { decision: string; tag: string | null; reasons: string[] } | null;
  status: { context: string; state: string; description: string } | null;
  reasons: Array<{ code: string }>;
};

/**
 * `write-build-status`: the only command that writes a commit status. It evaluates the commit again
 * when it runs and reports what exists then, in one context, so an older evaluation cannot report "no
 * build tag" over a tag that has since been published. It writes nothing unless publication is
 * activated.
 */
describe("write-build-status", { timeout: 300_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/42`;
  const report = (json: BuildReport) => json as unknown as StatusReport;
  const statusLines = (from: number) => state.github.statuses.slice(from).map((s) => `${s.state}: ${s.description}`);

  it("writes nothing unless publication is activated, and nothing for a plan it cannot use", async () => {
    const { pr33 } = fixture.releasedHistory();
    const { json: plan } = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));
    const confirmed = { result: "success", decision: "tagged" };

    for (const activation of [null, "", "true", "Enabled"]) {
      const result = await fixture.writeStatus(plan, confirmed, { activation });
      expect(result.code, JSON.stringify(activation)).toBe(6);
      expect(report(result.json)).toMatchObject({ decision: "publication_disabled", written: false, status: null });
    }

    const invalid = await fixture.writeStatus({ ...plan, command: "publish-build" }, confirmed);
    expect(invalid.code).toBe(4);
    expect(report(invalid.json).reasons.map((r) => r.code)).toEqual(["plan_invalid"]);

    expect(state.github.writes()).toEqual([]);
  });

  it("reports what exists when it runs, using the plan and the writer only to explain an eligible commit with no tag", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    const eligible = (await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha))).json;
    const failed = (
      await fixture.evaluate(pr32.mergeSha, fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] }))
    ).json;
    const pending = (
      await fixture.evaluate(pr34.mergeSha, fixture.ci(pr34.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "in_progress" } }] }))
    ).json;
    const refused = (await fixture.evaluate(pr34.mergeSha, fixture.ci(pr34.mergeSha, { event: "pull_request" }))).json;
    expect([eligible, failed, pending, refused].map((plan) => plan.decision)).toEqual(["eligible", "failed", "pending", "refused"]);

    const write = async (label: string, plan: BuildReport, writer: { result?: string; decision?: string }) => {
      const before = github.statuses.length;
      const result = await fixture.writeStatus(plan, writer, { extra: ["--target-url", RUN_URL] });
      expect(result.code, `${label}: ${result.stderr}`).toBe(0);
      return { json: report(result.json), written: github.statuses.slice(before) };
    };
    const one = (sha: string, state: string, description: string) => [
      { sha, state, context: "release/build-tag", description, target_url: RUN_URL },
    ];

    const untagged = await write("an eligible commit the writer did not tag", eligible, { result: "failure", decision: "" });
    expect(untagged.json).toMatchObject({ decision: "written", written: true, evaluation: { decision: "eligible", tag: null } });
    expect(untagged.written).toEqual(one(pr33.mergeSha, "failure", "No build tag: the tag writer did not confirm one (failure)"));

    const claimed = await write("a writer claiming a tag GitHub does not have", eligible, { result: "success", decision: "tagged" });
    expect(claimed.written).toEqual(
      one(pr33.mergeSha, "failure", "No build tag: the tag writer did not confirm one (success, tagged)"),
    );

    const unchanged: Array<[string, BuildReport, string, string]> = [
      ["a failed gate", failed, "failure", "No build tag, a required CI gate is unsatisfied: required_gate_failed"],
      ["CI that has not finished", pending, "pending", "No build tag yet: ci_incomplete"],
      ["a trigger that is not final-merge CI", refused, "failure", "No build tag, refused: not_final_merge_ci"],
    ];
    for (const [label, plan, expected, description] of unchanged) {
      const result = await write(label, plan, { result: "skipped" });
      expect(result.written, label).toEqual(one(plan.sha, expected, description));
    }

    // Once the tag exists, neither the writer's report nor the plan decides the status.
    expect((await fixture.publish(eligible)).json.decision).toBe("tagged");
    const created = await write("a created build tag", eligible, { result: "success", decision: "tagged" });
    expect(created.json.evaluation).toMatchObject({ decision: "already_tagged", tag: "v0.0.7-dev.1" });
    expect(created.written).toEqual(one(pr33.mergeSha, "success", "Build tag v0.0.7-dev.1"));
    const writerFailedAfterTagging = await write("a writer that failed after the tag was created", eligible, {
      result: "failure",
      decision: "",
    });
    expect(writerFailedAfterTagging.written).toEqual(one(pr33.mergeSha, "success", "Build tag v0.0.7-dev.1"));

    // A plan's decision does not force a status either: a commit released since calls for none.
    repo.tag("v0.0.7", pr34.mergeSha, "v0.0.7\n\nThe normal release.");
    const writes = github.writes().length;
    const released = await fixture.writeStatus(pending, { result: "skipped" });
    expect(released.code).toBe(0);
    expect(report(released.json)).toMatchObject({
      decision: "no_status",
      written: false,
      evaluation: { decision: "not_applicable" },
    });
    expect(github.writes()).toHaveLength(writes);

    expect(
      github.writes().every((w) => /\/statuses\/[0-9a-f]{40}$/.test(w.path) || /\/git\/(tags|refs)$/.test(w.path)),
    ).toBe(true);
  });

  it("keeps a confirmed build tag's success when a failed or pending evaluation of the same commit reports late", async () => {
    const { github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const failedPlan = (await fixture.evaluate(pr33.mergeSha, run)).json;
    expect(failedPlan.decision).toBe("failed");
    fixture.retry(run, { jobs: { [E2E_GATE]: "in_progress" } });
    const pendingPlan = (await fixture.evaluate(pr33.mergeSha, run)).json;
    expect(pendingPlan.decision).toBe("pending");

    // The retry finishes and passes; its evaluation is published and reported.
    github.runs.get(run)!.attempts.pop();
    fixture.retry(run);
    const { evaluation, publication } = await fixture.tagBuild(pr33.mergeSha, run);
    expect(publication.json.decision).toBe("tagged");
    const from = github.statuses.length;
    expect((await fixture.writeStatus(evaluation.json, { result: "success", decision: "tagged" })).code).toBe(0);

    // The status jobs of the two older evaluations run late.
    for (const plan of [failedPlan, pendingPlan]) {
      const late = await fixture.writeStatus(plan, { result: "skipped" });
      expect(late.code).toBe(0);
      expect(report(late.json)).toMatchObject({
        decision: "written",
        evaluation: { decision: "already_tagged", tag: "v0.0.7-dev.1" },
      });
    }

    expect(statusLines(from)).toEqual([
      "success: Build tag v0.0.7-dev.1",
      "success: Build tag v0.0.7-dev.1",
      "success: Build tag v0.0.7-dev.1",
    ]);
  });

  it("lets confirmed publication replace a failure reported first", async () => {
    const { github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const failedPlan = (await fixture.evaluate(pr33.mergeSha, run)).json;
    const from = github.statuses.length;
    expect((await fixture.writeStatus(failedPlan, { result: "skipped" })).code).toBe(0);

    fixture.retry(run);
    const { evaluation, publication } = await fixture.tagBuild(pr33.mergeSha, run);
    expect(publication.json.decision).toBe("tagged");
    expect((await fixture.writeStatus(evaluation.json, { result: "success", decision: "tagged" })).code).toBe(0);

    expect(statusLines(from)).toEqual([
      "failure: No build tag, a required CI gate is unsatisfied: required_gate_failed",
      "success: Build tag v0.0.7-dev.1",
    ]);
  });

  it("refuses writer inputs and a target URL other than the ones the workflow passes", async () => {
    const { pr33 } = fixture.releasedHistory();
    const { json: plan } = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));

    const cases: Array<[{ result?: string; decision?: string }, string[]]> = [
      [{ result: "succeeded" }, []],
      [{ result: "success", decision: "published" }, []],
      // The tag a status names comes from GitHub, never from the writer's say-so.
      [{ result: "success", decision: "tagged" }, ["--writer-tag", "v0.0.7-dev.1"]],
      [{ result: "success", decision: "tagged" }, ["--target-url", "https://example.com/actions/runs/1"]],
      [{ result: "success", decision: "tagged" }, ["--target-url", `https://github.com/${REPOSITORY}/actions/runs/1/../../settings`]],
    ];
    for (const [writer, extra] of cases) {
      const result = await fixture.writeStatus(plan, writer, { extra });
      expect(result.code, JSON.stringify([writer, extra])).toBe(2);
    }
    expect(state.github.writes()).toEqual([]);
  });
});
