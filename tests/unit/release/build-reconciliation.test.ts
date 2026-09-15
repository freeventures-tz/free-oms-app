// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { FixtureRepository } from "./support/fixture-repository";
import {
  DATABASE_GATE,
  E2E_GATE,
  REPOSITORY,
  TOKEN,
  useBuildFixture,
  type AttemptSpec,
  type BuildReport,
  type ReconciliationReport,
} from "./support/build-harness";

/**
 * `reconcile-builds`: which accepted merges after v0.0.6 are owed a build tag, derived on every invocation
 * from main's first-parent history, the tags GitHub holds and each commit's own final-merge CI. It reads
 * only; its JSON is the plan the writing jobs receive.
 */
describe("reconcile-builds: the backlog from durable history", { timeout: 300_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code);
  const decisions = (report: ReconciliationReport) => report.commits.map((commit) => [commit.pr, commit.decision]);

  it("lists every merge after v0.0.6, #32 and #33 included, as eligible, blocked or recorded, and writes nothing", async () => {
    const { repo, github } = state;
    const { released, pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "ci(release): reconcile build tags" });
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [DATABASE_GATE]: "failure" } }] });
    fixture.ci(pr33.mergeSha);
    const run34 = fixture.ci(pr34.mergeSha);
    // #34's own CI completion was published; nothing has tagged #32 or #33.
    expect((await fixture.tagBuild(pr34.mergeSha, run34)).publication.json.decision).toBe("tagged");
    const refsBefore = repo.refs();
    const writes = github.writes().length;

    const { code, json, stderr } = await fixture.reconcile();

    expect(code, stderr).toBe(0);
    expect(json).toMatchObject({
      command: "reconcile-builds",
      schema: 1,
      decision: "eligible",
      publication: "none",
      repository: REPOSITORY,
      main: pr34.mergeSha,
      since: { tag: "v0.0.6", tagObject: repo.git("rev-parse", "v0.0.6"), commit: released.mergeSha },
      trigger: null,
      counts: { recorded: 1, eligible: 1, blocked: 1, notApplicable: 0 },
      reasons: [],
    });
    expect(json.commits.map((commit) => [commit.pr, commit.sha, commit.decision])).toEqual([
      [32, pr32.mergeSha, "failed"],
      [33, pr33.mergeSha, "eligible"],
      [34, pr34.mergeSha, "recorded"],
    ]);

    const [blocked, eligible, recorded] = json.commits;
    expect(blocked).toMatchObject({ tag: null, recordedTag: null, target: { version: "0.0.7", base: { tag: "v0.0.6" } } });
    expect(codes(blocked.reasons)).toEqual(["required_gate_failed"]);
    expect(blocked.reasons[0].detail).toContain(`${DATABASE_GATE} concluded failure in run ${run32} attempt 1`);
    expect(blocked.ci!.runs[0].gates.find((gate) => gate.name === DATABASE_GATE)).toMatchObject({ result: "failed" });
    // The provisional name counts the tag #34 already holds.
    expect(eligible).toMatchObject({
      tag: { name: "v0.0.7-dev.2", ordinal: 2, provisional: true },
      target: { version: "0.0.7", highestChange: "patch" },
      reasons: [],
    });
    expect(recorded).toMatchObject({
      tag: null,
      recordedTag: {
        name: "v0.0.7-dev.1",
        object: repo.git("rev-parse", "v0.0.7-dev.1"),
        ciRun: String(run34),
        ciAttempt: "1",
        verification: "full",
      },
      reasons: [],
    });
    expect(repo.git("cat-file", "-t", "v0.0.7-dev.1")).toBe("tag");

    expect(github.writes()).toHaveLength(writes);
    expect(repo.refs()).toBe(refsBefore);
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

    const markdown = await fixture.reconcileMarkdown();
    expect(markdown.code).toBe(0);
    expect(markdown.stdout.startsWith("## Build-tag reconciliation: 1 eligible, 1 blocked, 1 recorded")).toBe(true);
    for (const text of [
      `\`${pr32.mergeSha}\` · #32 · failed`,
      "`required_gate_failed`",
      `\`${pr33.mergeSha}\` · #33 · \`v0.0.7-dev.2\` · provisional`,
      `\`${pr34.mergeSha}\` · #34 · \`v0.0.7-dev.1\``,
    ]) {
      expect(markdown.stdout).toContain(text);
    }
  });

  it("reconciles the same window whether a CI completion or a recovery dispatch started it", async () => {
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha);
    const run33 = fixture.ci(pr33.mergeSha);

    const dispatched = await fixture.reconcile(null);
    const completed = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });

    expect(completed.code, completed.stderr).toBe(0);
    expect(completed.json.trigger).toEqual({ sha: pr33.mergeSha, runId: run33, inWindow: true });
    expect(dispatched.json.trigger).toBeNull();
    expect(completed.json.commits).toEqual(dispatched.json.commits);
    expect(completed.json.commits.map((commit) => [commit.pr, commit.decision, commit.tag!.name])).toEqual([
      [32, "eligible", "v0.0.7-dev.1"],
      [33, "eligible", "v0.0.7-dev.2"],
    ]);
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a trigger that is not final-merge CI for a commit on main, before scanning", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha);
    const run33 = fixture.ci(pr33.mergeSha);
    const pullRequestRun = fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const offMain = repo.unmergedCommit("feat: never merged");

    const cases: Array<[string, { sha: string; runId: number }, string]> = [
      ["a pull-request run", { sha: pr33.mergeSha, runId: pullRequestRun }, "not_final_merge_ci"],
      ["another commit's run", { sha: pr33.mergeSha, runId: run32 }, "not_final_merge_ci"],
      ["a run GitHub does not have", { sha: pr33.mergeSha, runId: 999_999 }, "not_final_merge_ci"],
      ["a commit off main", { sha: offMain, runId: run33 }, "not_on_main_first_parent"],
      ["an unknown commit", { sha: "0".repeat(40), runId: run33 }, "unknown_commit"],
    ];
    for (const [label, trigger, code] of cases) {
      const refused = await fixture.reconcile(trigger);
      expect(refused.code, label).toBe(4);
      expect(refused.json, label).toMatchObject({ decision: "refused", commits: [], counts: { eligible: 0 } });
      expect(codes(refused.json.reasons), label).toEqual([code]);
    }
    expect(github.requests.some((r) => r.path.includes("/jobs"))).toBe(false);
    expect(github.writes()).toEqual([]);
  });

  it.each<{ label: string; setup: (repo: FixtureRepository) => void; code: string }>([
    {
      label: "is missing",
      setup: (repo) => {
        const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
        repo.tag("v0.0.5", released.mergeSha);
      },
      code: "since_release_missing",
    },
    {
      label: "is a lightweight tag",
      setup: (repo) => repo.lightweightTag("v0.0.6", repo.mergePullRequest({ number: 30, title: "fix: protect" }).mergeSha),
      code: "since_release_not_annotated",
    },
    {
      label: "tags a commit off main's first-parent line",
      setup: (repo) => repo.tag("v0.0.6", repo.mergePullRequest({ number: 30, title: "fix: protect" }).headSha),
      code: "since_release_off_first_parent",
    },
  ])("refuses to choose a window when v0.0.6 $label", async ({ setup, code }) => {
    const { repo, github } = state;
    setup(repo);
    repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });

    const { code: status, json } = await fixture.reconcile();

    expect(status).toBe(4);
    expect(json).toMatchObject({ decision: "refused", since: null, commits: [] });
    expect(codes(json.reasons)).toEqual([code]);
    expect(github.requests.some((r) => r.path.includes("/actions/"))).toBe(false);
    expect(github.writes()).toEqual([]);
  });

  it("keeps earlier merges in the window after a later normal release, and owes the release commit nothing", async () => {
    const { repo } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    fixture.ci(pr33.mergeSha);
    repo.tag("v0.0.7", pr33.mergeSha, "v0.0.7\n\nThe normal release.");
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    fixture.ci(pr34.mergeSha);

    const { code, json } = await fixture.reconcile();

    expect(code).toBe(0);
    expect(json.commits.map((c) => [c.pr, c.decision, c.target?.version ?? null, c.target?.base.tag ?? null])).toEqual([
      [32, "failed", "0.0.7", "v0.0.6"],
      [null, "not_applicable", null, null],
      [34, "eligible", "0.0.8", "v0.0.7"],
    ]);
    expect(json.commits[1]).toMatchObject({ sha: pr33.mergeSha, releasedAs: ["v0.0.7"], tag: null });
    expect(json.counts).toEqual({ recorded: 0, eligible: 1, blocked: 1, notApplicable: 1 });
  });

  it("refuses, rather than records, a commit whose build references cannot be trusted", async () => {
    const { repo } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run33 = fixture.ci(pr33.mergeSha);
    fixture.ci(pr32.mergeSha);
    repo.tag("v0.0.9-dev.1", pr32.mergeSha, "v0.0.9-dev.1\n\nMade by hand.");

    const handMade = await fixture.reconcile();
    expect(decisions(handMade.json)).toEqual([
      [32, "refused"],
      [33, "eligible"],
    ]);
    expect(codes(handMade.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);

    expect((await fixture.tagBuild(pr33.mergeSha, run33)).publication.json.decision).toBe("tagged");
    repo.lightweightTag("v0.0.7-dev.2", pr33.mergeSha);
    const duplicate = await fixture.reconcile();
    expect(duplicate.json.commits[1]).toMatchObject({ sha: pr33.mergeSha, decision: "refused", recordedTag: null });
    expect(codes(duplicate.json.commits[1].reasons)).toEqual(["duplicate_build_tags", "lightweight_build_tag"]);
  });

  /** An annotation Git alone cannot fault: every field it can check is right, and it cites a chosen CI attempt. */
  const handWritten = (plan: BuildReport, tag: string, run: number, attempt: number) =>
    [
      `Build ${tag} of ${REPOSITORY}`,
      "",
      "Written by hand for the test.",
      "",
      "Release-Controller-Schema: 1",
      `Repository: ${REPOSITORY}`,
      `Commit: ${plan.sha}`,
      `Target-Version: ${plan.target!.version}`,
      `Classification: ${plan.target!.highestChange}`,
      `Release-Base: ${plan.target!.base.tag} ${plan.target!.base.tagObject} ${plan.target!.base.commit}`,
      `Notes-Digest: ${plan.target!.notesDigest}`,
      "CI-Workflow: .github/workflows/ci.yml",
      `CI-Run: ${run}`,
      `CI-Attempt: ${attempt}`,
    ].join("\n");

  it("verifies a recorded tag in full until a normal release contains its merge, and refuses one citing an attempt that did not pass", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const run33 = fixture.ci(pr33.mergeSha);
    expect((await fixture.tagBuild(pr33.mergeSha, run33)).publication.json.decision).toBe("tagged");
    const failed = (await fixture.evaluate(pr32.mergeSha, run32)).json;
    expect(failed.decision).toBe("failed");
    repo.tag("v0.0.7-dev.2", pr32.mergeSha, handWritten(failed, "v0.0.7-dev.2", run32, 1));

    const open = await fixture.reconcile();

    expect(open.json.commits.map((c) => [c.pr, c.decision, c.recordedTag?.verification ?? null])).toEqual([
      [32, "refused", null],
      [33, "recorded", "full"],
    ]);
    expect(codes(open.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);
    expect(open.json.commits[0].reasons[0].detail).toContain(`run ${run32} attempt 1 did not pass final-merge CI`);

    // A normal release now contains both merges. A released merge's target is checked from Git; its CI evidence is still read.
    repo.git("tag", "-d", "v0.0.7-dev.2");
    repo.tag("v0.0.7", pr33.mergeSha, "v0.0.7\n\nThe normal release.");
    repo.tag("v0.0.9-dev.1", pr32.mergeSha, "v0.0.9-dev.1\n\nMade by hand.");
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    fixture.ci(pr34.mergeSha);
    const from = github.requests.length;

    const released = await fixture.reconcile();

    expect(released.json.commits.map((c) => [c.pr, c.decision, c.recordedTag?.verification ?? null])).toEqual([
      [32, "refused", null],
      [33, "recorded", "git-and-ci"],
      [34, "eligible", null],
    ]);
    expect(codes(released.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);
    // The release settles #33's target, so no pull request in its range is read. Its CI evidence still is.
    const reads = github.requests.slice(from).map((r) => r.path);
    expect(reads.filter((path) => /\/pulls\/33$/.test(path))).toEqual([]);
    expect(reads.some((path) => path.includes(`head_sha=${pr33.mergeSha}`))).toBe(true);
    expect(reads.some((path) => path.includes(`/actions/runs/${run33}/jobs`))).toBe(true);
    expect(github.writes()).toHaveLength(2);
  });

  it.each<{ label: string; attempts: AttemptSpec[]; cited: "own" | "other"; attempt: number; detail: string }>([
    {
      label: "an attempt that failed",
      attempts: [{ jobs: { [E2E_GATE]: "failure" } }],
      cited: "own",
      attempt: 1,
      detail: `attempt 1 did not pass final-merge CI (concluded failure; ${E2E_GATE} failed)`,
    },
    {
      label: "an attempt that has not finished",
      attempts: [{}, { jobs: { [E2E_GATE]: "in_progress" } }],
      cited: "own",
      attempt: 2,
      detail: `attempt 2 did not pass final-merge CI (is in_progress; ${E2E_GATE} incomplete)`,
    },
    { label: "an attempt the run never had", attempts: [{}], cited: "own", attempt: 3, detail: "CI-Attempt 3 is not an attempt of run" },
    { label: "another commit's run", attempts: [{}], cited: "other", attempt: 1, detail: "is not a final-merge CI run of this commit" },
  ])(
    "keeps refusing a tag that cites $label after a later normal release contains its merge, exactly as evaluate-build does",
    async ({ attempts, cited, attempt, detail }) => {
      const { repo, github } = state;
      const { pr32, pr33 } = fixture.releasedHistory();
      const own = fixture.ci(pr32.mergeSha, { attempts });
      const other = fixture.ci(pr33.mergeSha);
      const evaluation = (await fixture.evaluate(pr32.mergeSha, own)).json;
      expect(evaluation.target).not.toBeNull();
      repo.tag("v0.0.7-dev.1", pr32.mergeSha, handWritten(evaluation, "v0.0.7-dev.1", cited === "own" ? own : other, attempt));

      const before = await fixture.reconcile();
      expect(before.json.commits[0]).toMatchObject({ pr: 32, decision: "refused", recordedTag: null });
      expect(codes(before.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);

      // #33 ships as the normal release v0.0.7, so a release now contains #32.
      repo.tag("v0.0.7", pr33.mergeSha, "v0.0.7\n\nThe normal release.");
      const after = await fixture.reconcile();
      const exact = await fixture.evaluate(pr32.mergeSha, own);

      expect(after.json.commits.map((c) => [c.pr, c.decision])).toEqual([
        [32, "refused"],
        [null, "not_applicable"],
      ]);
      expect(after.json.commits[0]).toMatchObject({ tag: null, recordedTag: null });
      expect(codes(after.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);
      expect(after.json.commits[0].reasons[0].detail).toContain(detail);
      expect(exact.json.decision).toBe("refused");
      expect(after.json.commits[0].reasons).toEqual(exact.json.reasons);
      expect(github.writes()).toEqual([]);
    },
  );

  it("refuses usage it cannot act on", async () => {
    fixture.releasedHistory();
    for (const extra of [
      ["--since", "v0.0.7-dev.1"],
      ["--since", "0.0.6"],
      ["--sha", "a".repeat(40)],
      ["--run-id", "1"],
      ["--sha", "a".repeat(40), "--run-id", "0"],
    ]) {
      const result = await fixture.reconcile(null, { extra });
      expect(result.code, extra.join(" ")).toBe(2);
    }
    expect(state.github.requests).toEqual([]);
  });
});
