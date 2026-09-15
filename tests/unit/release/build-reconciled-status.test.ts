// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE, REPOSITORY, useBuildFixture, type ReconciledStatus } from "./support/build-harness";

/**
 * `write-reconciled-statuses`: the status job of a reconciliation. Under the tag writer's lock it evaluates
 * again the commit whose CI completion started the run and every commit the plan did not find recorded,
 * and writes the `release/build-tag` status each calls for — only when that differs from the status GitHub
 * already shows, so an unresolved merge stays visible without a new status on every run.
 */
describe("write-reconciled-statuses", { timeout: 300_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/42`;
  const results = (json: ReconciledStatus) =>
    json.commits.map((commit) => [commit.sha, commit.trigger, commit.result, commit.status?.state ?? null]);
  const statusLines = (from = 0) => state.github.statuses.slice(from).map((s) => `${String(s.sha).slice(0, 7)} ${s.state}: ${s.description}`);

  it("reports the trigger and every commit not yet recorded from what exists, and skips a status that has not changed", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "in_progress" } }] });
    const run34 = fixture.ci(pr34.mergeSha);
    const { json: plan } = await fixture.reconcile({ sha: pr34.mergeSha, runId: run34 });
    const short = (sha: string) => sha.slice(0, 7);

    const first = await fixture.writeReconciledStatuses(plan, { result: "failure", decision: "interrupted" }, { extra: ["--target-url", RUN_URL] });
    expect(first.code, first.stderr).toBe(0);
    expect(first.json.decision).toBe("reported");
    expect(results(first.json)).toEqual([
      [pr32.mergeSha, false, "written", "failure"],
      [pr33.mergeSha, false, "written", "pending"],
      [pr34.mergeSha, true, "written", "failure"],
    ]);
    expect(statusLines()).toEqual([
      `${short(pr32.mergeSha)} failure: No build tag, a required CI gate is unsatisfied: required_gate_failed`,
      `${short(pr33.mergeSha)} pending: No build tag yet: ci_incomplete`,
      `${short(pr34.mergeSha)} failure: No build tag: the tag writer did not confirm one (failure, interrupted)`,
    ]);
    expect(github.statuses.every((s) => s.context === "release/build-tag" && s.target_url === RUN_URL)).toBe(true);

    const writes = github.writes().length;
    const again = await fixture.writeReconciledStatuses(plan, { result: "failure", decision: "interrupted" });
    expect(results(again.json).map((row) => row[2])).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(github.writes()).toHaveLength(writes);

    // The writer publishes #34; the next status job replaces its failure with success and leaves the rest.
    expect((await fixture.publishReconciled(plan)).json.decision).toBe("published");
    const from = github.statuses.length;
    const after = await fixture.writeReconciledStatuses(plan, { result: "success", decision: "published" });
    expect(results(after.json)).toEqual([
      [pr32.mergeSha, false, "unchanged", "failure"],
      [pr33.mergeSha, false, "unchanged", "pending"],
      [pr34.mergeSha, true, "written", "success"],
    ]);
    expect(after.json.commits[2].evaluation).toMatchObject({ decision: "already_tagged", tag: "v0.0.7-dev.1" });
    expect(statusLines(from)).toEqual([`${short(pr34.mergeSha)} success: Build tag v0.0.7-dev.1`]);
    expect(github.writes().every((w) => /\/statuses\/[0-9a-f]{40}$/.test(w.path) || /\/git\/(tags|refs)$/.test(w.path))).toBe(true);
  });

  it("reports a commit merged after the plan was made, which the writer found and published", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha);
    const run33 = fixture.ci(pr33.mergeSha);
    const { json: plan } = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });
    // #34 merges and passes CI before this run's writer takes the lock.
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    fixture.ci(pr34.mergeSha);

    const publication = await fixture.publishReconciled(plan);
    expect(publication.json.commits.map((c) => [c.pr, c.planned, c.decision])).toEqual([
      [32, true, "tagged"],
      [33, true, "tagged"],
      [34, false, "tagged"],
    ]);

    const statuses = await fixture.writeReconciledStatuses(plan, { result: "success", decision: "published" });
    expect(statuses.code, statuses.stderr).toBe(0);
    expect(results(statuses.json)).toEqual([
      [pr32.mergeSha, false, "written", "success"],
      [pr33.mergeSha, true, "written", "success"],
      [pr34.mergeSha, false, "written", "success"],
    ]);
    expect(github.statuses.map((s) => s.description)).toEqual([
      "Build tag v0.0.7-dev.1",
      "Build tag v0.0.7-dev.2",
      "Build tag v0.0.7-dev.3",
    ]);
  });

  it("writes a recorded tag's success over the failure its lost status job left, on the next recovery run", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const shownOn32 = () => github.statuses.filter((s) => s.sha === pr32.mergeSha).map((s) => `${s.state}: ${s.description}`);
    const failure = "failure: No build tag, a required CI gate is unsatisfied: required_gate_failed";

    await fixture.workflowRun({ sha: pr32.mergeSha, runId: run32 });
    expect(shownOn32()).toEqual([failure]);

    // The same run is retried and passes. Its writer tags #32, but its status job never runs.
    fixture.retry(run32);
    const plan = await fixture.reconcile({ sha: pr32.mergeSha, runId: run32 });
    const publication = await fixture.publishReconciled(plan.json);
    expect(publication.json.commits.map((c) => [c.pr, c.decision, c.tag?.name])).toEqual([[32, "tagged", "v0.0.7-dev.1"]]);
    expect(shownOn32()).toEqual([failure]);

    // A recovery run finds #32 recorded beside a status that does not name its tag, evaluates it again and corrects it.
    const recovery = await fixture.workflowRun(null);
    expect(recovery.plan.json.commits.map((c) => [c.pr, c.decision])).toEqual([
      [32, "recorded"],
      [33, "pending"],
    ]);
    expect(recovery.publication).toBeNull();
    expect(results(recovery.statuses.json)).toEqual([
      [pr32.mergeSha, false, "written", "success"],
      [pr33.mergeSha, false, "unchanged", "pending"],
    ]);
    expect(recovery.statuses.json.commits[0].evaluation).toMatchObject({ decision: "already_tagged", tag: "v0.0.7-dev.1" });
    expect(shownOn32()).toEqual([failure, "success: Build tag v0.0.7-dev.1"]);

    // Once its status names the tag, later runs neither evaluate nor write it again.
    const writes = github.writes().length;
    const settled = await fixture.workflowRun(null);
    expect(results(settled.statuses.json)).toEqual([[pr33.mergeSha, false, "unchanged", "pending"]]);
    expect(github.writes()).toHaveLength(writes);
  });

  it("keeps confirmed success when an older plan's status job runs late, and leaves commits recorded at planning alone", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const run33 = fixture.ci(pr33.mergeSha);
    const tagged = await fixture.workflowRun({ sha: pr33.mergeSha, runId: run33 });
    expect(tagged.publication!.json.commits.map((c) => c.decision)).toEqual(["tagged"]);
    const olderPlan = (await fixture.reconcile({ sha: pr32.mergeSha, runId: run32 })).json;
    expect(olderPlan.commits.map((c) => c.decision)).toEqual(["failed", "recorded"]);

    fixture.retry(run32);
    await fixture.workflowRun({ sha: pr32.mergeSha, runId: run32 });
    const from = github.statuses.length;

    const late = await fixture.writeReconciledStatuses(olderPlan, { result: "skipped" });
    expect(late.code).toBe(0);
    expect(results(late.json)).toEqual([[pr32.mergeSha, true, "unchanged", "success"]]);
    expect(late.json.commits[0].evaluation).toMatchObject({ decision: "already_tagged", tag: "v0.0.7-dev.2" });
    expect(github.statuses.slice(from)).toEqual([]);
    expect(github.statuses.filter((s) => s.sha === pr32.mergeSha).map((s) => s.state)).toEqual(["failure", "success"]);
  });

  it("reports a refused trigger on its own commit, and writes nothing for a trigger outside the window", async () => {
    const { github } = state;
    const { released, pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr33.mergeSha);
    const pullRequestRun = fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const releaseRun = fixture.ci(released.mergeSha);

    const refusedPlan = (await fixture.reconcile({ sha: pr33.mergeSha, runId: pullRequestRun })).json;
    expect(refusedPlan.decision).toBe("refused");
    const refused = await fixture.writeReconciledStatuses(refusedPlan, { result: "skipped" });
    expect(refused.code, refused.stderr).toBe(0);
    expect(results(refused.json)).toEqual([[pr33.mergeSha, true, "written", "failure"]]);
    expect(github.statuses.at(-1)).toMatchObject({ sha: pr33.mergeSha, description: "No build tag, refused: not_final_merge_ci" });

    const outsidePlan = (await fixture.reconcile({ sha: released.mergeSha, runId: releaseRun })).json;
    expect(outsidePlan.trigger).toEqual({ sha: released.mergeSha, runId: releaseRun, inWindow: false });
    // The release commit is the window's start: no status. #32 has no CI yet; #33's plan was eligible and no
    // writer confirmed a tag.
    const outside = await fixture.writeReconciledStatuses(outsidePlan, { result: "skipped" });
    expect(results(outside.json)).toEqual([
      [released.mergeSha, true, "outside_window", null],
      [pr32.mergeSha, false, "written", "pending"],
      [pr33.mergeSha, false, "written", "failure"],
    ]);
    expect(github.statuses.filter((s) => s.sha === released.mergeSha)).toEqual([]);
  });

  it("refuses writer inputs, a target URL and a plan other than the ones the workflow passes", async () => {
    const { pr33 } = fixture.releasedHistory();
    const run33 = fixture.ci(pr33.mergeSha);
    const { json: plan } = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });

    const usage: Array<[{ result?: string; decision?: string }, string[]]> = [
      [{ result: "succeeded" }, []],
      [{ result: "success", decision: "tagged" }, []],
      [{ result: "success", decision: "published" }, ["--target-url", "https://example.com/actions/runs/1"]],
      [{ result: "success", decision: "published" }, ["--since", "v0.0.5"]],
    ];
    for (const [writer, extra] of usage) {
      const result = await fixture.writeReconciledStatuses(plan, writer, { extra });
      expect(result.code, JSON.stringify([writer, extra])).toBe(2);
    }

    for (const tampered of [{ ...plan, repository: "someone/free-oms-app" }, (await fixture.evaluate(pr33.mergeSha, run33)).json]) {
      const result = await fixture.writeReconciledStatuses(tampered, { result: "skipped" });
      expect(result.code).toBe(4);
      expect(result.json.reasons.map((r) => r.code)).toEqual(["plan_invalid"]);
    }
    expect(state.github.writes()).toEqual([]);
  });
});
