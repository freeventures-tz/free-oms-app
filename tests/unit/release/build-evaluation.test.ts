// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DATABASE_GATE,
  E2E_GATE,
  INTEGRATION_GATE,
  REPOSITORY,
  REQUIRED_JOBS,
  STATIC_GATE,
  TOKEN,
  useBuildFixture,
  type AttemptSpec,
  type RunSpec,
} from "./support/build-harness";

/**
 * Whether an exact merge earns a build tag, through `evaluate-build` against disposable Git and a
 * simulated GitHub. Only final-merge CI for the exact commit counts, every page is read, and every way
 * a gate goes unsatisfied is named. Evaluation never writes.
 */
describe("evaluate-build: identity and final-merge CI", { timeout: 240_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code);

  it("finds an exact merge eligible once its own final-merge CI passed every required gate, and writes nothing", async () => {
    const { repo, github } = state;
    const { released, pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const refsBefore = repo.refs();

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(0);
    expect(json).toMatchObject({
      command: "evaluate-build",
      schema: 1,
      decision: "eligible",
      publication: "none",
      repository: REPOSITORY,
      sha: pr33.mergeSha,
      runId: run,
      target: { version: "0.0.7", highestChange: "patch", base: { tag: "v0.0.6", commit: released.mergeSha } },
      tag: { name: "v0.0.7-dev.1", ordinal: 1, provisional: true },
      status: { context: "release/build-tag", state: "pending" },
      existingTag: null,
      reasons: [],
    });
    expect(json.target!.notesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(json.target!.merges.map((merge) => merge.pr)).toEqual([32, 33]);
    expect(json.ci!.satisfiedBy).toEqual({
      runId: run,
      attempt: 1,
      url: `https://github.com/${REPOSITORY}/actions/runs/${run}`,
    });
    expect(REQUIRED_JOBS).toHaveLength(4);
    expect(json.ci!.runs[0].gates).toEqual(
      REQUIRED_JOBS.map((name) => ({ name, result: "success", conclusion: "success" })),
    );

    expect(github.writes()).toEqual([]);
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(repo.refs()).toBe(refsBefore);

    const markdown = await fixture.evaluateMarkdown(pr33.mergeSha, run);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout.startsWith("## Build tag: eligible")).toBe(true);
    expect(markdown.stdout).toContain("`v0.0.7-dev.1` · provisional");
  });

  it.each<{ label: string; spec: RunSpec; mismatch: string }>([
    { label: "a pull-request run", spec: { event: "pull_request" }, mismatch: "its event is" },
    { label: "a run on another branch", spec: { branch: "release-candidate" }, mismatch: "its branch is" },
    { label: "a run from a fork", spec: { headRepository: "someone/free-oms-app" }, mismatch: "its head repository is" },
    {
      label: "a run of another workflow",
      spec: { path: ".github/workflows/release-classification.yml", workflowId: 1 },
      mismatch: "its workflow path is",
    },
    { label: "a run of another repository", spec: { repositoryName: "someone/free-oms-app", repositoryId: 7 }, mismatch: "its repository id is" },
  ])("refuses $label as the trigger, before reading any job", async ({ spec, mismatch }) => {
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, spec);

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", tag: null, target: null, status: { state: "failure" } });
    expect(json.reasons).toEqual([
      expect.objectContaining({ kind: "refusal", code: "not_final_merge_ci", commit: pr33.mergeSha }),
    ]);
    expect(json.reasons[0].detail).toContain(mismatch);
    expect(state.github.requests.some((r) => r.path.includes("/jobs"))).toBe(false);
    expect(state.github.writes()).toEqual([]);
  });

  it("does not let a green pull-request run, a synthetic merge run or another commit's run stand in for failed final-merge CI", async () => {
    const { pr32, pr33 } = fixture.releasedHistory();
    const failedPush = fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const greenPullRequestRun = fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const syntheticMergeRun = fixture.ci(pr33.headSha, { event: "pull_request", branch: "pr-33" });
    const otherCommitRun = fixture.ci(pr32.mergeSha);

    const failed = await fixture.evaluate(pr33.mergeSha, failedPush);
    expect(failed.code).toBe(5);
    expect(failed.json).toMatchObject({ decision: "failed", tag: null, status: { state: "failure" } });
    expect(failed.json.reasons).toEqual([
      expect.objectContaining({ kind: "failed", code: "required_gate_failed", commit: pr33.mergeSha }),
    ]);
    expect(failed.json.reasons[0].detail).toContain(`${E2E_GATE} concluded failure in run ${failedPush} attempt 1`);
    expect(failed.json.ci!.ignoredRuns.map((r) => r.runId)).toEqual([greenPullRequestRun]);

    for (const run of [greenPullRequestRun, syntheticMergeRun, otherCommitRun]) {
      const refused = await fixture.evaluate(pr33.mergeSha, run);
      expect(refused.code, `run ${run}`).toBe(4);
      expect(codes(refused.json.reasons)).toEqual(["not_final_merge_ci"]);
    }
    expect(state.github.writes()).toEqual([]);
  });

  it.each<{ label: string; attempt: AttemptSpec; exit: number; decision: string; code: string; state: string }>([
    { label: "failed", attempt: { jobs: { [E2E_GATE]: "failure" } }, exit: 5, decision: "failed", code: "required_gate_failed", state: "failure" },
    { label: "timed out", attempt: { jobs: { [STATIC_GATE]: "timed_out" } }, exit: 5, decision: "failed", code: "required_gate_failed", state: "failure" },
    { label: "was cancelled", attempt: { jobs: { [DATABASE_GATE]: "cancelled" } }, exit: 5, decision: "failed", code: "required_gate_cancelled", state: "failure" },
    { label: "was skipped", attempt: { jobs: { [INTEGRATION_GATE]: "skipped" }, conclusion: "success" }, exit: 5, decision: "failed", code: "required_gate_skipped", state: "failure" },
    { label: "is missing", attempt: { omit: [STATIC_GATE], conclusion: "success" }, exit: 5, decision: "failed", code: "required_gate_missing", state: "failure" },
    {
      label: "ran twice in one attempt",
      attempt: { extraJobs: [{ name: E2E_GATE, status: "completed", conclusion: "success" }] },
      exit: 5,
      decision: "failed",
      code: "required_gate_ambiguous",
      state: "failure",
    },
    { label: "is still running", attempt: { jobs: { [E2E_GATE]: "in_progress" } }, exit: 3, decision: "pending", code: "ci_incomplete", state: "pending" },
    {
      label: "passed in a run that still concluded failure",
      attempt: { extraJobs: [{ name: "An extra job", status: "completed", conclusion: "failure" }] },
      exit: 5,
      decision: "failed",
      code: "ci_run_not_successful",
      state: "failure",
    },
  ])("names a required gate that $label, and allocates no tag", async ({ attempt, exit, decision, code, state: commitState }) => {
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts: [attempt] });

    const { code: status, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(status).toBe(exit);
    expect(json).toMatchObject({ decision, tag: null, existingTag: null, status: { state: commitState } });
    expect(codes(json.reasons)).toEqual([code]);
    expect(json.status!.description).toContain(code);
    expect(json.status!.description.length).toBeLessThanOrEqual(140);
    expect(state.github.writes()).toEqual([]);
  });

  it("is pending while no final-merge CI run exists for the commit", async () => {
    const { pr33 } = fixture.releasedHistory();
    fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });

    const { code, json } = await fixture.evaluate(pr33.mergeSha, null);

    expect(code).toBe(3);
    expect(json).toMatchObject({ decision: "pending", tag: null, status: { state: "pending" } });
    expect(codes(json.reasons)).toEqual(["ci_run_missing"]);
  });

  it("reads every page of runs, jobs and tag references", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.5", repo.root);
    const { pr33 } = fixture.releasedHistory();
    fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const run = fixture.ci(pr33.mergeSha);
    github.setPageSize(1);

    const { code, json } = await fixture.evaluate(pr33.mergeSha, null);

    expect(code).toBe(0);
    expect(json.ci!.satisfiedBy!.runId).toBe(run);
    const paths = github.requests.map((r) => r.path);
    expect(paths.some((p) => p.includes("/actions/workflows/ci.yml/runs") && p.includes("page=2"))).toBe(true);
    expect(paths.some((p) => p.includes(`/actions/runs/${run}/jobs`) && p.includes("page=4"))).toBe(true);
    expect(paths.some((p) => p.includes("/git/matching-refs/tags") && p.includes("page=2"))).toBe(true);
  });

  it("accepts a passing retry of the same run, keeping the failed attempt and the accepted flaky retry on record", async () => {
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [DATABASE_GATE]: "failure" } }] });

    const first = await fixture.evaluate(pr33.mergeSha, run);
    expect(first.code).toBe(5);
    expect(codes(first.json.reasons)).toEqual(["required_gate_failed"]);

    fixture.retry(run);
    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(0);
    expect(json).toMatchObject({ decision: "eligible", tag: { name: "v0.0.7-dev.1" } });
    expect(json.ci!.satisfiedBy).toMatchObject({ runId: run, attempt: 2 });
    expect(json.ci!.runs[0].attempts).toMatchObject([
      {
        attempt: 1,
        status: "completed",
        conclusion: "failure",
        satisfied: false,
        unsuccessfulJobs: [{ name: DATABASE_GATE, conclusion: "failure" }],
      },
      { attempt: 2, status: "completed", conclusion: "success", satisfied: true, unsuccessfulJobs: [] },
    ]);
    expect(json.ci!.runs[0].attempts[0].gates.find((gate) => gate.name === DATABASE_GATE)).toEqual({
      name: DATABASE_GATE,
      result: "failed",
      conclusion: "failure",
    });
    expect(json.ci!.runs[0].acceptedFlakes).toEqual([
      { job: DATABASE_GATE, unsuccessful: [{ attempt: 1, conclusion: "failure" }], passedAttempt: 2 },
    ]);
    expect(state.github.requests.some((r) => r.path.endsWith(`/actions/runs/${run}/attempts/1`))).toBe(true);

    const markdown = await fixture.evaluateMarkdown(pr33.mergeSha, run);
    expect(markdown.stdout).toContain(`run ${run} attempt 1: failure (${DATABASE_GATE} failure)`);
    expect(markdown.stdout).toContain(
      `accepted flaky retry in run ${run}: ${DATABASE_GATE} failure in attempt 1, success in attempt 2`,
    );
  });

  it("does not let a passing job from another commit or another run satisfy a failed gate, and offers no waiver", async () => {
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha);
    const run = fixture.ci(pr33.mergeSha, {
      attempts: [
        {
          jobs: { [E2E_GATE]: "failure" },
          extraJobs: [
            { name: E2E_GATE, status: "completed", conclusion: "success", head_sha: pr32.mergeSha },
            { name: E2E_GATE, status: "completed", conclusion: "success", run_id: 1 },
          ],
        },
      ],
    });

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(5);
    expect(codes(json.reasons)).toEqual(["required_gate_failed"]);
    expect(json.ci!.runs).toHaveLength(1);
    expect(json.ci!.runs[0].ignoredJobs).toHaveLength(2);

    const waiver = await fixture.evaluateMarkdown(pr33.mergeSha, run, ["--accept-known-flake", E2E_GATE]);
    expect(waiver.code).toBe(2);
  });

  it("refuses a commit that is not an exact merge on main's first-parent line before reading any CI", async () => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const offMain = repo.unmergedCommit("feat: never merged");
    const run = fixture.ci(pr33.mergeSha);

    for (const sha of [offMain, pr33.headSha]) {
      const { code, json } = await fixture.evaluate(sha, run);
      expect(code).toBe(4);
      expect(codes(json.reasons)).toEqual(["not_on_main_first_parent"]);
    }
    const unknown = await fixture.evaluate("0".repeat(40), run);
    expect(codes(unknown.json.reasons)).toEqual(["unknown_commit"]);

    expect(github.requests.some((r) => r.path.includes("/actions/"))).toBe(false);
    expect(github.writes()).toEqual([]);
  });

  it("finds a commit that is itself a normal release not applicable, with no tag and no status", async () => {
    const { repo } = state;
    const { pr33 } = fixture.releasedHistory();
    repo.tag("v0.0.7", pr33.mergeSha);
    const run = fixture.ci(pr33.mergeSha);

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(0);
    expect(json).toMatchObject({ decision: "not_applicable", releasedAs: ["v0.0.7"], tag: null, status: null });
  });

  it("stops without deciding when the checkout's tags are not GitHub's", async () => {
    const { repo } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    state.checkout.sync();
    repo.tag("v0.0.7-dev.1", pr33.mergeSha, "v0.0.7-dev.1\n\nPushed by hand after the checkout.");

    const { code, stdout, stderr } = await fixture.evaluate(pr33.mergeSha, run, { sync: false });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("tag_state_out_of_date");
    expect(stderr).toContain("v0.0.7-dev.1");
  });

  it("allocates no tag while accepted history awaits an Owner decision or is refused", async () => {
    const { repo } = state;
    fixture.releasedHistory();
    repo.squashPullRequest({ number: 34, title: "fix: squashed" });
    const afterSquash = repo.mergePullRequest({ number: 35, title: "fix: after the squash" });
    const pending = await fixture.evaluate(afterSquash.mergeSha, fixture.ci(afterSquash.mergeSha));
    expect(pending.code).toBe(3);
    expect(pending.json).toMatchObject({ decision: "pending", tag: null, target: null, status: { state: "pending" } });
    expect(pending.json.reasons).toEqual([expect.objectContaining({ kind: "pending_decision", code: "squash_or_rebase_merge" })]);

    const malformed = repo.mergePullRequest({ number: 36, title: "Update the receipts" });
    const refused = await fixture.evaluate(malformed.mergeSha, fixture.ci(malformed.mergeSha));
    expect(refused.code).toBe(4);
    expect(refused.json.decision).toBe("refused");
    expect(codes(refused.json.reasons)).toEqual(["squash_or_rebase_merge", "malformed_title"]);
  });
});
