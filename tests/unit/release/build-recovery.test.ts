// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DATABASE_GATE, E2E_GATE, REPOSITORY, useBuildFixture, type PublishedCommit } from "./support/build-harness";

/**
 * `publish-reconciled-builds`: the tag writer re-derives what history owes under its lock and publishes
 * every eligible exact merge through the one build-tag writer, oldest first. No event, plan or surviving
 * run is the ledger, so dropped, duplicated, late and replaced events are recovered by whichever
 * reconciliation runs next. Tags are real Git objects in a disposable repository behind a simulated GitHub.
 */
describe("publish-reconciled-builds: recovery from durable history", { timeout: 600_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code);
  const outcomes = (commits: PublishedCommit[]) =>
    commits.map((commit) => [commit.pr, commit.decision, commit.tag?.name ?? commit.existingTag?.name ?? null]);
  const tagWrites = () => state.github.writes().filter((w) => /\/git\/(tags|refs)$/.test(w.path));
  const buildTagNames = () =>
    fixture
      .remoteTags()
      .split("\n")
      .map((line) => line.split(" ")[0])
      .filter((name) => name.includes("-dev."))
      .sort();

  it("recovers three merges whose CI completions arrive out of order, twice, and with one workflow replaced, allocating each ordinal once", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    const normalTags = fixture.remoteTags();

    // CI finishes on #34 first. Its workflow reconciles; its writer waits for the lock.
    const run34 = fixture.ci(pr34.mergeSha);
    const plan34 = await fixture.reconcile({ sha: pr34.mergeSha, runId: run34 });
    expect(plan34.json.commits.map((c) => c.decision)).toEqual(["pending", "pending", "eligible"]);
    expect(codes(plan34.json.commits[0].reasons)).toEqual(["ci_run_missing"]);

    // #32 finishes next. This workflow's writer is replaced while pending and never runs.
    const run32 = fixture.ci(pr32.mergeSha);
    const plan32 = await fixture.reconcile({ sha: pr32.mergeSha, runId: run32 });
    expect(plan32.json.commits.map((c) => c.decision)).toEqual(["eligible", "pending", "eligible"]);

    // #34's writer takes the lock and publishes what history owes now, oldest first: #32 as well.
    const first = await fixture.publishReconciled(plan34.json);
    expect(first.code, first.stderr).toBe(0);
    expect(first.json).toMatchObject({ decision: "published", publication: "created" });
    expect(outcomes(first.json.commits)).toEqual([
      [32, "tagged", "v0.0.7-dev.1"],
      [34, "tagged", "v0.0.7-dev.2"],
    ]);
    expect(first.json.commits.map((c) => c.planned)).toEqual([false, true]);

    // #33 finishes last, and its completion is delivered twice.
    const run33 = fixture.ci(pr33.mergeSha);
    const plan33 = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });
    const duplicate = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });
    expect(duplicate.json.commits).toEqual(plan33.json.commits);
    expect(plan33.json.commits.map((c) => [c.decision, c.tag?.name ?? c.recordedTag?.name])).toEqual([
      ["recorded", "v0.0.7-dev.1"],
      ["eligible", "v0.0.7-dev.3"],
      ["recorded", "v0.0.7-dev.2"],
    ]);

    const second = await fixture.publishReconciled(plan33.json);
    expect(second.code, second.stderr).toBe(0);
    expect(outcomes(second.json.commits)).toEqual([[33, "tagged", "v0.0.7-dev.3"]]);

    // The duplicate's writer and the replaced workflow's stale plan, run late, find nothing to do.
    const writes = tagWrites().length;
    for (const late of [duplicate, plan32]) {
      const again = await fixture.publishReconciled(late.json);
      expect(again.code).toBe(0);
      expect(again.json).toMatchObject({ decision: "nothing_to_publish", publication: "none", commits: [] });
    }
    expect(tagWrites()).toHaveLength(writes);
    expect(tagWrites().map((w) => `${w.method} ${w.path.replace(`/repos/${REPOSITORY}`, "")}`)).toEqual([
      "POST /git/tags",
      "POST /git/refs",
      "POST /git/tags",
      "POST /git/refs",
      "POST /git/tags",
      "POST /git/refs",
    ]);

    // One annotated build tag per merge. Ordinals record allocation order, not Git order.
    for (const [merge, name] of [
      [pr32, "v0.0.7-dev.1"],
      [pr33, "v0.0.7-dev.3"],
      [pr34, "v0.0.7-dev.2"],
    ] as const) {
      expect(fixture.tagsOn(merge.mergeSha)).toEqual([name]);
      expect(repo.git("cat-file", "-t", name)).toBe("tag");
      expect(repo.git("rev-parse", `${name}^{commit}`)).toBe(merge.mergeSha);
    }
    const settled = await fixture.reconcile(null);
    expect(settled.json).toMatchObject({ decision: "nothing_to_publish", counts: { recorded: 3, eligible: 0, blocked: 0 } });
    expect(
      fixture
        .remoteTags()
        .split("\n")
        .filter((line) => !line.includes("-dev."))
        .join("\n"),
    ).toBe(normalTags);
    expect(github.writes().every((w) => /\/git\/(tags|refs)$/.test(w.path))).toBe(true);
  });

  it("keeps a failed earlier merge visibly blocked while later merges pass and a normal release ships, then tags it once from its own release", async () => {
    const { repo, github } = state;
    const { released, pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    const statusesOn32 = () =>
      github.statuses.filter((s) => s.sha === pr32.mergeSha).map((s) => `${s.state}: ${s.description}`);

    const withPr33 = await fixture.workflowRun({ sha: pr33.mergeSha, runId: fixture.ci(pr33.mergeSha) });
    expect(outcomes(withPr33.publication!.json.commits)).toEqual([[33, "tagged", "v0.0.7-dev.1"]]);

    repo.tag("v0.0.7", pr33.mergeSha, "v0.0.7\n\nThe normal release.");
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    const withPr34 = await fixture.workflowRun({ sha: pr34.mergeSha, runId: fixture.ci(pr34.mergeSha) });
    expect(outcomes(withPr34.publication!.json.commits)).toEqual([[34, "tagged", "v0.0.8-dev.1"]]);
    expect(withPr34.plan.json.commits.map((c) => [c.pr, c.decision])).toEqual([
      [32, "failed"],
      [33, "recorded"],
      [34, "eligible"],
    ]);

    // #32 stays in the window, blocked by its own gate and calculated from its own release.
    for (const run of [withPr33, withPr34]) {
      const blocked = run.plan.json.commits.find((c) => c.sha === pr32.mergeSha)!;
      expect(blocked).toMatchObject({
        decision: "failed",
        tag: null,
        recordedTag: null,
        target: { version: "0.0.7", base: { tag: "v0.0.6" } },
      });
      expect(codes(blocked.reasons)).toEqual(["required_gate_failed"]);
      expect(blocked.reasons[0].detail).toContain(`${E2E_GATE} concluded failure`);
    }
    expect(statusesOn32()).toEqual(["failure: No build tag, a required CI gate is unsatisfied: required_gate_failed"]);
    expect(withPr34.statuses.json.commits.find((c) => c.sha === pr32.mergeSha)).toMatchObject({ result: "unchanged" });

    // Its own same-run retry passes. A recovery dispatch finds it without any CI event of its own.
    fixture.retry(run32);
    const recovery = await fixture.workflowRun(null);
    expect(recovery.plan.json.commits.find((c) => c.sha === pr32.mergeSha)).toMatchObject({
      decision: "eligible",
      tag: { name: "v0.0.7-dev.2" },
      target: { version: "0.0.7", base: { tag: "v0.0.6", commit: released.mergeSha } },
    });
    expect(outcomes(recovery.publication!.json.commits)).toEqual([[32, "tagged", "v0.0.7-dev.2"]]);
    const annotation = repo.git("cat-file", "tag", "v0.0.7-dev.2");
    expect(annotation).toContain(`Release-Base: v0.0.6 ${recovery.plan.json.since!.tagObject} ${released.mergeSha}`);
    expect(annotation).toContain(`CI-Run: ${run32}\nCI-Attempt: 2`);
    expect(statusesOn32()).toEqual([
      "failure: No build tag, a required CI gate is unsatisfied: required_gate_failed",
      "success: Build tag v0.0.7-dev.2",
    ]);

    const writes = github.writes().length;
    const again = await fixture.workflowRun(null);
    expect(again.plan.json).toMatchObject({
      decision: "nothing_to_publish",
      counts: { recorded: 3, eligible: 0, blocked: 0, notApplicable: 0 },
    });
    expect(again.publication).toBeNull();
    expect(github.writes()).toHaveLength(writes);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual(["v0.0.7-dev.2"]);
    expect(buildTagNames()).toEqual(["v0.0.7-dev.1", "v0.0.7-dev.2", "v0.0.8-dev.1"]);
  });

  it("keeps patch-target build tags when a feature raises the target, with ordinals rising within each target", async () => {
    const { repo } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [DATABASE_GATE]: "failure" } }] });
    await fixture.workflowRun({ sha: pr33.mergeSha, runId: fixture.ci(pr33.mergeSha) });
    const patchTag = repo.git("rev-parse", "v0.0.7-dev.1");

    const feature = repo.mergePullRequest({ number: 34, title: "feat(reports): print the daily summary" });
    const fix = repo.mergePullRequest({ number: 35, title: "fix(reports): round the totals" });
    fixture.ci(feature.mergeSha);
    const raised = await fixture.workflowRun({ sha: fix.mergeSha, runId: fixture.ci(fix.mergeSha) });
    expect(outcomes(raised.publication!.json.commits)).toEqual([
      [34, "tagged", "v0.1.0-dev.1"],
      [35, "tagged", "v0.1.0-dev.2"],
    ]);

    fixture.retry(run32);
    const late = await fixture.workflowRun(null);
    expect(outcomes(late.publication!.json.commits)).toEqual([[32, "tagged", "v0.0.7-dev.2"]]);
    expect(repo.git("rev-parse", "v0.0.7-dev.1")).toBe(patchTag);
    expect(repo.git("rev-parse", "v0.0.7-dev.1^{commit}")).toBe(pr33.mergeSha);
    expect(buildTagNames()).toEqual(["v0.0.7-dev.1", "v0.0.7-dev.2", "v0.1.0-dev.1", "v0.1.0-dev.2"]);
  });

  it("reports what an interrupted write completed, and the next reconciliation converges on one tag per merge", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    for (const merge of [pr32, pr33, pr34]) fixture.ci(merge.mergeSha);
    const plan = await fixture.reconcile(null);
    // The second reference fails after its tag object was created.
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: () => github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "before", status: 502 }),
    });

    const interrupted = await fixture.publishReconciled(plan.json);

    expect(interrupted.code).toBe(1);
    expect(interrupted.json).toMatchObject({ decision: "interrupted", publication: "created" });
    expect(outcomes(interrupted.json.commits)).toEqual([
      [32, "tagged", "v0.0.7-dev.1"],
      [33, "interrupted", null],
      [34, "not_attempted", null],
    ]);
    expect(codes(interrupted.json.commits[1].reasons)).toEqual(["tag_reference_unconfirmed"]);
    expect(buildTagNames()).toEqual(["v0.0.7-dev.1"]);

    // The unreferenced object is not a publication, so the same name is offered again.
    const next = await fixture.reconcile(null);
    expect(next.json.commits.map((c) => [c.decision, c.tag?.name ?? c.recordedTag?.name])).toEqual([
      ["recorded", "v0.0.7-dev.1"],
      ["eligible", "v0.0.7-dev.2"],
      ["eligible", "v0.0.7-dev.3"],
    ]);

    // Even the stale plan converges: the writer derives its work again.
    const resumed = await fixture.publishReconciled(plan.json);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(outcomes(resumed.json.commits)).toEqual([
      [33, "tagged", "v0.0.7-dev.2"],
      [34, "tagged", "v0.0.7-dev.3"],
    ]);
    for (const [merge, name] of [
      [pr32, "v0.0.7-dev.1"],
      [pr33, "v0.0.7-dev.2"],
      [pr34, "v0.0.7-dev.3"],
    ] as const) {
      expect(fixture.tagsOn(merge.mergeSha)).toEqual([name]);
    }
  });

  it("confirms from GitHub a tag whose reference was created but whose response was lost, then publishes the rest", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    for (const merge of [pr32, pr33]) fixture.ci(merge.mergeSha);
    const plan = await fixture.reconcile(null);
    github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "after", status: 502 });

    const interrupted = await fixture.publishReconciled(plan.json);
    expect(interrupted.code).toBe(1);
    expect(outcomes(interrupted.json.commits)).toEqual([
      [32, "interrupted", null],
      [33, "not_attempted", null],
    ]);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual(["v0.0.7-dev.1"]);
    const writes = tagWrites().length;

    const resumed = await fixture.publishReconciled(plan.json);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(outcomes(resumed.json.commits)).toEqual([[33, "tagged", "v0.0.7-dev.2"]]);
    expect(tagWrites()).toHaveLength(writes + 2);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual(["v0.0.7-dev.1"]);
  });

  it("stops without deciding when a read fails mid-scan, and writes nothing until a reconciliation can read everything", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha);
    const run33 = fixture.ci(pr33.mergeSha);
    const plan = await fixture.reconcile(null);
    github.failures.set(`/repos/${REPOSITORY}/actions/runs/${run33}/jobs`, 502);

    const scan = await fixture.reconcile(null);
    expect(scan.code).toBe(1);
    expect(scan.stdout).toBe("");
    expect(scan.stderr).toContain("github_request_failed");
    const publication = await fixture.publishReconciled(plan.json);
    expect(publication.code).toBe(1);
    expect(publication.stdout).toBe("");
    expect(github.writes()).toEqual([]);

    github.failures.clear();
    const recovered = await fixture.publishReconciled(plan.json);
    expect(outcomes(recovered.json.commits)).toEqual([
      [32, "tagged", "v0.0.7-dev.1"],
      [33, "tagged", "v0.0.7-dev.2"],
    ]);
  });

  it("refuses a commit whose build tag cannot be trusted, publishes the others, and never renames or moves a tag", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    for (const merge of [pr32, pr33]) fixture.ci(merge.mergeSha);
    repo.tag("v0.0.9-dev.1", pr32.mergeSha, "v0.0.9-dev.1\n\nMade by hand.");
    const handMade = repo.git("rev-parse", "v0.0.9-dev.1");

    const { plan, publication } = await fixture.workflowRun(null);

    expect(plan.json.commits.map((c) => [c.pr, c.decision])).toEqual([
      [32, "refused"],
      [33, "eligible"],
    ]);
    expect(codes(plan.json.commits[0].reasons)).toEqual(["conflicting_build_provenance"]);
    expect(outcomes(publication!.json.commits)).toEqual([[33, "tagged", "v0.0.7-dev.1"]]);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual(["v0.0.9-dev.1"]);
    expect(repo.git("rev-parse", "v0.0.9-dev.1")).toBe(handMade);
    expect(github.statuses.filter((s) => s.sha === pr32.mergeSha).map((s) => s.description)).toEqual([
      "No build tag, refused: conflicting_build_provenance",
    ]);
  });

  it("stops at a name another writer took during publication, and a later reconciliation refuses rather than allocates past it", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    for (const merge of [pr32, pr33]) fixture.ci(merge.mergeSha);
    const plan = await fixture.reconcile(null);
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: () => repo.tag("v0.0.7-dev.1", repo.root, "v0.0.7-dev.1\n\nNot a build."),
    });
    const references = () => github.writes().filter((w) => w.path.endsWith("/git/refs"));

    const { code, json } = await fixture.publishReconciled(plan.json);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", publication: "none" });
    expect(outcomes(json.commits)).toEqual([
      [32, "refused", null],
      [33, "not_attempted", null],
    ]);
    expect(codes(json.commits[0].reasons)).toEqual(["build_tag_name_collision"]);
    expect(references()).toHaveLength(1);

    const retried = await fixture.publishReconciled(plan.json);
    expect(retried.code).toBe(0);
    expect(retried.json).toMatchObject({ decision: "nothing_to_publish", commits: [] });
    const scan = await fixture.reconcile(null);
    expect(scan.json.commits.map((c) => [c.decision, codes(c.reasons)])).toEqual([
      ["refused", ["untrusted_build_tag"]],
      ["refused", ["untrusted_build_tag"]],
    ]);
    expect(references()).toHaveLength(1);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual([]);
  });

  it("refuses, for that commit only, a planned target that no longer matches, and publishes the rest", async () => {
    const { pr32, pr33 } = fixture.releasedHistory();
    for (const merge of [pr32, pr33]) fixture.ci(merge.mergeSha);
    const { json: plan } = await fixture.reconcile(null);
    const drifted = {
      ...plan,
      commits: plan.commits.map((commit, index) =>
        index === 0 ? { ...commit, target: { ...commit.target, notesDigest: `sha256:${"0".repeat(64)}` } } : commit,
      ),
    };

    const { code, json } = await fixture.publishReconciled(drifted);

    expect(code).toBe(4);
    expect(json.decision).toBe("refused");
    expect(outcomes(json.commits)).toEqual([
      [32, "refused", null],
      [33, "tagged", "v0.0.7-dev.1"],
    ]);
    expect(codes(json.commits[0].reasons)).toEqual(["plan_drift"]);
    expect(fixture.tagsOn(pr32.mergeSha)).toEqual([]);
  });

  it("writes nothing unless RELEASE_BUILD_PUBLICATION is exactly `enabled`, and refuses a plan it cannot use before any write", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    fixture.ci(pr32.mergeSha);
    const run33 = fixture.ci(pr33.mergeSha);
    const pullRequestRun = fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const { json: plan } = await fixture.reconcile({ sha: pr33.mergeSha, runId: run33 });
    const planPath = fixture.writePlan(plan);
    const tagsBefore = fixture.remoteTags();

    for (const activation of [null, "", "true", "Enabled", " enabled"]) {
      const result = await fixture.publishReconciled(null, { activation, planPath });
      expect(result.code, JSON.stringify(activation)).toBe(6);
      expect(result.json).toMatchObject({ decision: "publication_disabled", publication: "none" });
      expect(outcomes(result.json.commits)).toEqual([
        [32, "eligible", "v0.0.7-dev.1"],
        [33, "eligible", "v0.0.7-dev.2"],
      ]);
      const statuses = await fixture.writeReconciledStatuses(plan, { result: "skipped" }, { activation });
      expect(statuses.code, JSON.stringify(activation)).toBe(6);
    }

    const refused = (await fixture.reconcile({ sha: pr33.mergeSha, runId: pullRequestRun })).json;
    const single = (await fixture.evaluate(pr33.mergeSha, run33)).json;
    const cases: Array<[string, unknown, string]> = [
      ["text that is not JSON", "{ not json", "plan_invalid"],
      ["another repository", { ...plan, repository: "someone/free-oms-app" }, "plan_invalid"],
      ["another repository id", { ...plan, repositoryId: 7 }, "plan_invalid"],
      ["another main ref", { ...plan, mainRef: "origin/release" }, "plan_invalid"],
      ["a window that starts elsewhere", { ...plan, since: { ...plan.since, tag: "v0.0.5" } }, "plan_invalid"],
      ["a decision reconcile-builds never reports", { ...plan, decision: "published" }, "plan_invalid"],
      ["a single-commit plan", single, "plan_invalid"],
      ["a refused reconciliation", refused, "plan_not_reconciled"],
    ];
    for (const [label, tampered, code] of cases) {
      const result = await fixture.publishReconciled(tampered);
      expect(result.code, label).toBe(4);
      expect(codes(result.json.reasons), label).toEqual([code]);
      expect(result.json.publication, label).toBe("none");
    }
    expect(github.writes()).toEqual([]);
    expect(fixture.remoteTags()).toBe(tagsBefore);
  });
});
