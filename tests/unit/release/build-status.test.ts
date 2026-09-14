// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE, REPOSITORY, useBuildFixture, type BuildReport } from "./support/build-harness";

/**
 * `write-build-status`: the only command that writes a commit status. It reports what the evaluation
 * and the tag writer established, in one context, and writes nothing unless publication is activated.
 */
describe("write-build-status", { timeout: 240_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/42`;

  it("writes nothing unless publication is activated, and nothing for a plan it cannot use", async () => {
    const { pr33 } = fixture.releasedHistory();
    const { json: plan } = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));
    const confirmed = { result: "success", decision: "tagged", tag: "v0.0.7-dev.1" };

    for (const activation of [null, "", "true", "Enabled"]) {
      const result = await fixture.writeStatus(plan, confirmed, { activation });
      expect(result.code, JSON.stringify(activation)).toBe(6);
      expect(result.json).toMatchObject({ decision: "publication_disabled", written: false, status: null });
    }

    const invalid = await fixture.writeStatus({ ...plan, command: "publish-build" }, confirmed);
    expect(invalid.code).toBe(4);
    expect(invalid.json.reasons.map((r) => r.code)).toEqual(["plan_invalid"]);

    expect(state.github.writes()).toEqual([]);
  });

  it("reports on the commit exactly what the evaluation and the tag writer established", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const eligible = (await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha))).json;
    const failed = (
      await fixture.evaluate(pr32.mergeSha, fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] }))
    ).json;
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    const pending = (
      await fixture.evaluate(pr34.mergeSha, fixture.ci(pr34.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "in_progress" } }] }))
    ).json;
    const refused = (await fixture.evaluate(pr34.mergeSha, fixture.ci(pr34.mergeSha, { event: "pull_request" }))).json;

    const cases: Array<{
      label: string;
      plan: BuildReport;
      writer: { result?: string; decision?: string; tag?: string };
      state: string;
      description: string;
    }> = [
      {
        label: "a created build tag",
        plan: eligible,
        writer: { result: "success", decision: "tagged", tag: "v0.0.7-dev.1" },
        state: "success",
        description: "Build tag v0.0.7-dev.1",
      },
      {
        label: "a build tag an identical writer created first",
        plan: eligible,
        writer: { result: "success", decision: "already_tagged", tag: "v0.0.7-dev.1" },
        state: "success",
        description: "Build tag v0.0.7-dev.1",
      },
      {
        label: "a writer that failed",
        plan: eligible,
        writer: { result: "failure", decision: "", tag: "" },
        state: "failure",
        description: "No build tag: the tag writer did not confirm one (failure)",
      },
      {
        label: "a writer that refused a collision",
        plan: eligible,
        writer: { result: "failure", decision: "refused", tag: "" },
        state: "failure",
        description: "No build tag: the tag writer did not confirm one (failure, refused)",
      },
      {
        label: "a writer that succeeded without confirming a tag",
        plan: eligible,
        writer: { result: "success", decision: "publication_disabled", tag: "" },
        state: "failure",
        description: "No build tag: the tag writer did not confirm one (success, publication_disabled)",
      },
      {
        label: "a writer whose decision is not a confirmed tag, whatever tag it names",
        plan: eligible,
        writer: { result: "success", decision: "refused", tag: "v0.0.7-dev.1" },
        state: "failure",
        description: "No build tag: the tag writer did not confirm one (success, refused)",
      },
      {
        label: "a failed gate",
        plan: failed,
        writer: { result: "skipped" },
        state: "failure",
        description: "No build tag, a required CI gate is unsatisfied: required_gate_failed",
      },
      {
        label: "CI that has not finished",
        plan: pending,
        writer: { result: "skipped" },
        state: "pending",
        description: "No build tag yet: ci_incomplete",
      },
      {
        label: "a trigger that is not final-merge CI",
        plan: refused,
        writer: { result: "skipped" },
        state: "failure",
        description: "No build tag, refused: not_final_merge_ci",
      },
    ];

    for (const c of cases) {
      const before = github.statuses.length;
      const result = await fixture.writeStatus(c.plan, c.writer, { extra: ["--target-url", RUN_URL] });
      expect(result.code, c.label).toBe(0);
      expect(result.json, c.label).toMatchObject({ decision: "written", written: true, sha: c.plan.sha });
      expect(github.statuses.slice(before), c.label).toEqual([
        { sha: c.plan.sha, state: c.state, context: "release/build-tag", description: c.description, target_url: RUN_URL },
      ]);
    }
    expect(github.writes().every((w) => w.method === "POST" && /\/statuses\/[0-9a-f]{40}$/.test(w.path))).toBe(true);

    // A normal release commit calls for no status at all.
    repo.tag("v0.0.7", pr33.mergeSha);
    const released = (await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha))).json;
    expect(released.decision).toBe("not_applicable");
    const writes = github.writes().length;
    const none = await fixture.writeStatus(released, { result: "skipped" });
    expect(none.code).toBe(0);
    expect(none.json).toMatchObject({ decision: "no_status", written: false });
    expect(github.writes()).toHaveLength(writes);
  });

  it("refuses writer inputs and a target URL other than the ones the workflow passes", async () => {
    const { pr33 } = fixture.releasedHistory();
    const { json: plan } = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));

    const cases: Array<[{ result?: string; decision?: string; tag?: string }, string[]]> = [
      [{ result: "succeeded" }, []],
      [{ result: "success", decision: "published" }, []],
      [{ result: "success", decision: "tagged", tag: "v0.0.7" }, []],
      [{ result: "success", decision: "tagged", tag: "v0.0.7-dev.1" }, ["--target-url", "https://example.com/actions/runs/1"]],
      [
        { result: "success", decision: "tagged", tag: "v0.0.7-dev.1" },
        ["--target-url", `https://github.com/${REPOSITORY}/actions/runs/1/../../settings`],
      ],
    ];
    for (const [writer, extra] of cases) {
      const result = await fixture.writeStatus(plan, writer, { extra });
      expect(result.code, JSON.stringify([writer, extra])).toBe(2);
    }
    expect(state.github.writes()).toEqual([]);
  });
});
