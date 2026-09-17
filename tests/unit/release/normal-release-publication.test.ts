// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REPOSITORY, REPOSITORY_ID, TOKEN } from "./support/build-harness";
import { DATE, OWNER, useReleaseFixture } from "./support/release-harness";
import { runController } from "./support/run-controller";

/**
 * Publishing a normal release tag through `evaluate-release` and `publish-release`, the two commands the
 * normal-release workflow runs, into a real disposable repository behind a simulated GitHub. Evidence
 * records, the deployment, CI and the dispatch are GitHub's answers; the tag is a real Git object.
 */
describe("publish-release: one immutable normal tag", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  it("publishes exactly one annotated v0.0.7 at the preparation's merge, with complete provenance, and a retry writes nothing", async () => {
    const { repo, github } = state;
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const { released, pr32, pr33, pr42 } = history;

    const plan = await release.evaluate(evidence.request, { dispatch });
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.json.decision).toBe("eligible");
    expect(release.unsatisfied(plan.json)).toEqual([]);
    expect(plan.json.gates.map((gate) => [gate.gate, gate.state])).toEqual([
      ["dispatch", "satisfied"],
      ["policy", "satisfied"],
      ["history", "satisfied"],
      ["main", "satisfied"],
      ["version", "satisfied"],
      ["preparation", "satisfied"],
      ["schema-boundary", "satisfied"],
      ["hosted-migration", "not_required"],
      ["ci", "satisfied"],
      ["deployment", "satisfied"],
      ["review", "satisfied"],
      ["production-acceptance", "satisfied"],
      ["owner-approval", "satisfied"],
    ]);
    expect(plan.json.dispatch).toMatchObject({ runId: dispatch.runId, attempt: 1, actor: OWNER, triggeringActor: OWNER });
    expect(plan.json.release).toMatchObject({
      version: "0.0.7",
      policy: "0.x",
      highestChange: "patch",
      base: { tag: "v0.0.6", commit: released.mergeSha },
      preparationPr: 43,
      reviewedHead: prepared.reviewedHead,
      releaseDate: DATE,
    });
    expect(plan.json.release!.merges.map((merge) => [merge.pr, merge.mergeSha])).toEqual([
      [32, pr32.mergeSha],
      [33, pr33.mergeSha],
      [42, pr42.mergeSha],
      [43, prepared.mergeSha],
    ]);
    // The final notes carry every accepted merge once, the preparation's own merge included.
    for (const merge of [pr32, pr33, pr42, prepared]) {
      expect(plan.json.notes!.split(`merge [\`${merge.mergeSha}\`]`).length - 1, merge.mergeSha).toBe(1);
    }
    expect(plan.json.notes).toContain("## 0.0.7");
    expect(plan.json.schemaBoundary).toMatchObject({ state: "unchanged", value: prepared.boundary });
    expect(prepared.boundary).toMatch(/^unchanged [0-9a-f]{40}$/);
    expect(github.writes()).toEqual([]);

    // The metadata the preparation merged agrees with the tag about to be written.
    const metadataAt = (file: string) => JSON.parse(repo.git("show", `${prepared.mergeSha}:${file}`));
    expect(metadataAt("package.json").version).toBe("0.0.7");
    expect(metadataAt("package-lock.json").version).toBe("0.0.7");
    expect(metadataAt("package-lock.json").packages[""].version).toBe("0.0.7");
    expect(repo.git("show", `${prepared.mergeSha}:CHANGELOG.md`)).toContain(`## [0.0.7] — ${DATE}`);

    const refsBefore = repo.refs();
    const requestsBefore = github.requests.length;
    const published = await release.publish(plan.json, dispatch);
    expect(published.code, published.stderr).toBe(0);
    expect(published.json).toMatchObject({
      command: "publish-release",
      decision: "published",
      publication: "created",
      tag: { name: "v0.0.7", provisional: false, commit: prepared.mergeSha },
      reasons: [],
    });

    // Exactly two writes: the tag object, then a reference to it, each read back before success.
    const writes = github.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `POST /repos/${REPOSITORY}/git/tags`,
      `POST /repos/${REPOSITORY}/git/refs`,
    ]);
    expect(writes[0].body).toMatchObject({ tag: "v0.0.7", object: prepared.mergeSha, type: "commit" });
    expect(writes[1].body).toEqual({ ref: "refs/tags/v0.0.7", sha: published.json.tag!.object });
    const sequence = github.requests.slice(requestsBefore).map((r) => `${r.method} ${r.path}`);
    // Main is read again immediately before the object and again before the reference.
    const objectAt = sequence.indexOf(`POST /repos/${REPOSITORY}/git/tags`);
    const referenceAt = sequence.indexOf(`POST /repos/${REPOSITORY}/git/refs`);
    expect(sequence[objectAt - 1]).toBe(`GET /repos/${REPOSITORY}/git/ref/heads/main`);
    expect(sequence.slice(objectAt + 1, referenceAt)).toEqual([`GET /repos/${REPOSITORY}/git/ref/heads/main`]);
    // The read-back reads the reference, the object, and the dispatch run and attempt the annotation cites.
    expect(sequence.slice(referenceAt + 1)).toEqual([
      `GET /repos/${REPOSITORY}/git/ref/tags/v0.0.7`,
      `GET /repos/${REPOSITORY}/git/tags/${published.json.tag!.object}`,
      `GET /repos/${REPOSITORY}/actions/runs/${dispatch.runId}`,
      `GET /repos/${REPOSITORY}/actions/runs/${dispatch.runId}/attempts/1`,
    ]);
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

    // A real annotated tag of the exact merge, carrying the evidence it was published on.
    expect(repo.git("cat-file", "-t", "v0.0.7")).toBe("tag");
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);
    const raw = repo.git("cat-file", "tag", "v0.0.7");
    expect(raw.startsWith(`object ${prepared.mergeSha}\ntype commit\ntag v0.0.7\n`)).toBe(true);
    const lines = raw.split("\n");
    for (const line of [
      `Release v0.0.7 of ${REPOSITORY}`,
      "Release-Controller-Schema: 1",
      "Release-Kind: normal",
      `Repository: ${REPOSITORY}`,
      `Commit: ${prepared.mergeSha}`,
      "Version: 0.0.7",
      "Classification: patch",
      `Release-Base: v0.0.6 ${plan.json.release!.base.tagObject} ${released.mergeSha}`,
      `Notes-Digest: ${plan.json.release!.notesDigest}`,
      "Preparation-PR: 43",
      `Reviewed-Head: ${prepared.reviewedHead}`,
      `Release-Date: ${DATE}`,
      `Schema-Boundary: ${prepared.boundary}`,
      `Deployment: ${evidence.deployment}`,
      `Review-Record: ${evidence.review.reference}`,
      `Production-Acceptance-Record: ${evidence.acceptance.reference}`,
      `Owner-Approval-Record: ${evidence.approval.reference}`,
      "Hosted-Migration-Record: none",
      "Authorized-Actions: publish-normal-tag",
      `Owner: ${OWNER.login} ${OWNER.id}`,
      "CI-Workflow: .github/workflows/ci.yml",
      `CI-Run: ${evidence.ciRun}`,
      "CI-Attempt: 1",
      `Dispatch-Run: ${dispatch.runId} 1`,
      `- run ${evidence.ciRun} attempt 1: success`,
      "Accepted merges (4):",
      `- #32 ${pr32.mergeSha} test patch`,
      `- #33 ${pr33.mergeSha} test patch`,
      `- #42 ${pr42.mergeSha} ci patch`,
      `- #43 ${prepared.mergeSha} chore patch`,
    ]) {
      expect(lines, line).toContain(line);
    }
    expect(raw).not.toContain("walk-in sale");

    // The Markdown the writer appends to its job summary.
    const summary = release.fixture.writePlan("");
    state.checkout.sync();
    const markdown = await runController(
      ["evaluate-release", "--repo", REPOSITORY, "--repo-id", String(REPOSITORY_ID), "--main-ref", "origin/main", "--path", state.checkout.dir,
        "--sha", evidence.request.sha, "--version", "0.0.7", "--preparation-pr", "43", "--deployment", String(evidence.deployment),
        "--review", evidence.review.reference, "--production-acceptance", evidence.acceptance.reference,
        "--owner-approval", evidence.approval.reference, "--summary", summary],
      { env: release.fixture.environment(null) },
    );
    expect(markdown.code, markdown.stderr).toBe(0);
    expect(markdown.stdout).toContain("## Normal release `v0.0.7`: already published");
    expect(markdown.stdout).toContain("| owner-approval | satisfied |");
    expect(markdown.stdout).toContain("### Final release notes");
    expect(markdown.stdout).toContain("### The Owner's approval");
    expect(readFileSync(summary, "utf8")).toBe(markdown.stdout);

    // Nothing else moved: every other ref is as it was.
    const after = repo.refs().split("\n").filter((line) => !line.startsWith("refs/tags/v0.0.7 "));
    expect(after.join("\n")).toBe(refsBefore);

    // The same plan retried by the Owner, and a fresh dispatch, each find this release and write nothing.
    const retry = release.rerun(dispatch, OWNER);
    const again = await release.publish(plan.json, retry);
    expect(again.code, again.stderr).toBe(0);
    expect(again.json).toMatchObject({ decision: "already_published", tag: null, existingTag: { name: "v0.0.7", commit: prepared.mergeSha } });
    const second = release.dispatch(prepared.mergeSha);
    const rerun = await release.workflowRun(evidence.request, second);
    expect(rerun.plan.code, rerun.plan.stderr).toBe(0);
    expect(rerun.plan.json.decision).toBe("already_published");
    expect(release.gate(rerun.plan.json, "main").state).toBe("not_required");
    expect(rerun.publication).toBeNull();
    expect(github.writes()).toHaveLength(2);
    expect(repo.git("tag", "--points-at", prepared.mergeSha)).toBe("v0.0.7");

    // No build tag was published before the release, so the release's own merge is not owed one afterwards.
    const reconciled = await release.fixture.reconcile();
    expect(reconciled.json.commits.find((c) => c.sha === prepared.mergeSha)).toMatchObject({
      decision: "not_applicable",
      releasedAs: ["v0.0.7"],
    });
  });

  it("writes nothing unless RELEASE_NORMAL_PUBLICATION is exactly `enabled`; build activation does not count", async () => {
    const { github, repo } = state;
    const { evidence, dispatch } = await release.validRelease();
    const plan = await release.evaluate(evidence.request, { dispatch });
    expect(plan.json.decision).toBe("eligible");
    const planPath = release.fixture.writePlan(plan.json);
    const refsBefore = repo.refs();

    for (const activation of [null, "", "true", "1", "Enabled", "ENABLED", " enabled", "enabled "]) {
      const run = await release.publish(null, dispatch, { activation, planPath });
      expect(run.code, JSON.stringify(activation)).toBe(6);
      expect(run.json).toMatchObject({ decision: "publication_disabled", publication: "none", tag: { name: "v0.0.7", provisional: true } });
    }
    const buildOnly = await release.publish(null, dispatch, { activation: null, planPath, env: { RELEASE_BUILD_PUBLICATION: "enabled" } });
    expect(buildOnly.code).toBe(6);
    expect(github.writes()).toEqual([]);
    expect(repo.refs()).toBe(refsBefore);

    // And the reverse: normal activation does not let the build writer write.
    const reconciliation = await release.fixture.reconcile();
    expect(reconciliation.json.decision).toBe("eligible");
    const buildPlan = release.fixture.writePlan(reconciliation.json);
    const build = await runController(
      ["publish-reconciled-builds", "--repo", REPOSITORY, "--repo-id", String(REPOSITORY_ID), "--main-ref", "origin/main", "--path", state.checkout.dir, "--plan", buildPlan, "--format", "json"],
      { env: { ...release.fixture.environment(null), RELEASE_NORMAL_PUBLICATION: "enabled" } },
    );
    expect(build.code, build.stderr).toBe(6);
    expect(JSON.parse(build.stdout).decision).toBe("publication_disabled");
    expect(github.writes()).toEqual([]);
  });

  it("refuses plans it cannot trust, a plan from another run and a plan that no longer matches, before any write", async () => {
    const { github } = state;
    const { evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    const codes = (run: { json: { reasons: Array<{ code: string }> } }) => run.json.reasons.map((r) => r.code);

    for (const tampered of [
      "not json",
      { ...plan, command: "evaluate-build" },
      { ...plan, repository: "someone/else" },
      { ...plan, repositoryId: 1 },
      { ...plan, request: { ...plan.request, review: "comment:1@sha256:not-a-digest" } },
      { ...plan, request: { ...plan.request, dispatch: null } },
      { ...plan, request: { ...plan.request, dispatch: { runId: dispatch.runId + 1, attempt: 1 } } },
    ]) {
      const run = await release.publish(tampered, dispatch);
      expect(run.code, JSON.stringify(tampered).slice(0, 80)).toBe(4);
      expect(codes(run)).toEqual(["plan_invalid"]);
    }
    const refused = await release.publish({ ...plan, decision: "refused" }, dispatch);
    expect(refused.code).toBe(4);
    expect(codes(refused)).toEqual(["plan_not_eligible"]);

    const drifted = await release.publish({ ...plan, release: { ...plan.release!, notesDigest: `sha256:${"0".repeat(64)}` } }, dispatch);
    expect(drifted.code).toBe(4);
    expect(drifted.json.decision).toBe("refused");
    expect(codes(drifted)).toEqual(["plan_drift"]);

    const usage = await release.publish(plan, null);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("--dispatch-run-id");
    expect(github.writes()).toEqual([]);
  });

  it("refuses a retry started by anyone but the Owner, and accepts the Owner's", async () => {
    const { github } = state;
    const { evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;

    const intruded = release.rerun(dispatch, { login: "fixture-intruder", id: 9666 });
    const refused = await release.publish(plan, intruded);
    expect(refused.code).toBe(4);
    expect(release.unsatisfied(refused.json)).toEqual(["dispatch:dispatch_triggering_actor_not_owner"]);
    expect(refused.json.dispatch).toMatchObject({ attempt: 2, actor: OWNER, triggeringActor: { login: "fixture-intruder" } });
    // The plan's own attempt is no longer the run's latest.
    const stale = await release.publish(plan, dispatch);
    expect(release.unsatisfied(stale.json)).toEqual(["dispatch:dispatch_run_invalid"]);
    expect(github.writes()).toEqual([]);

    const owned = release.rerun(dispatch, OWNER);
    const published = await release.publish(plan, owned);
    expect(published.code, published.stderr).toBe(0);
    expect(published.json.decision).toBe("published");
    expect(state.repo.git("cat-file", "tag", "v0.0.7")).toContain(`Dispatch-Run: ${dispatch.runId} 3`);
  });

  it("reports no success when a write is interrupted, and a retry converges on exactly one tag", async () => {
    const { github, repo } = state;
    const { release: prepared, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;

    // The object is created and the reference is refused by a server error: nothing is published.
    github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "before", status: 500 });
    const unreferenced = await release.publish(plan, dispatch);
    expect(unreferenced.code).toBe(1);
    expect(unreferenced.stdout).toBe("");
    expect(unreferenced.stderr).toContain("tag_reference_unconfirmed");
    expect(unreferenced.stderr).toContain("is not a published release");
    expect(repo.git("tag", "--list", "v0.0.7")).toBe("");

    // The reference is created but its response is lost: still no success claimed.
    github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "after", status: 502 });
    const lost = await release.publish(plan, dispatch);
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain("tag_reference_unconfirmed");
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);

    // The retry reads it back and writes nothing more.
    const retried = await release.publish(plan, dispatch);
    expect(retried.code, retried.stderr).toBe(0);
    expect(retried.json.decision).toBe("already_published");
    const writes = github.writes().map((w) => w.path.replace(`/repos/${REPOSITORY}`, ""));
    expect(writes).toEqual(["/git/tags", "/git/refs", "/git/tags", "/git/refs"]);
    expect(repo.git("tag", "--points-at", prepared.mergeSha)).toBe("v0.0.7");
  });

  it("does not report success when the new tag cannot be read back, and the retry confirms it", async () => {
    const { github, repo } = state;
    const { release: prepared, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    // The read-back of the new reference fails once. The fault is armed only when the reference is created.
    github.faults.push({ method: "GET", path: /\/git\/ref\/tags\/v0\.0\.7$/, when: "before", status: 503, times: 0 });
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: () => {
        github.faults[0].times = 1;
      },
    });
    const run = await release.publish(plan, dispatch);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("tag_readback_failed");
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);
    const retried = await release.publish(plan, dispatch);
    expect(retried.json.decision).toBe("already_published");
    expect(github.writes()).toHaveLength(2);
  });

  it("does not report success when the reference it created reads back as another object", async () => {
    const { github, repo } = state;
    const { history, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    // Between the reference's creation and its read-back, the name comes to point at another object: the same
    // annotation, provenance and all, on another commit. Only the object and what it tags differ.
    github.faults.push({
      method: "GET",
      path: /\/git\/ref\/tags\/v0\.0\.7$/,
      when: "before",
      effect: () => {
        const raw = repo.git("cat-file", "tag", "v0.0.7");
        const annotation = raw.slice(raw.indexOf("\n\n") + 2);
        repo.git("tag", "-f", "-a", "v0.0.7", "-m", annotation, history.pr42.mergeSha);
      },
    });
    const run = await release.publish(plan, dispatch);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("tag_readback_mismatch");
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(history.pr42.mergeSha);
  });

  it("refuses a tag name GitHub has given to something else, and moves nothing", async () => {
    const { github, repo } = state;
    const { history, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: () => repo.tag("v0.0.7", history.pr42.mergeSha, "v0.0.7\n\nMade by hand."),
    });
    const run = await release.publish(plan, dispatch);
    expect(run.code).toBe(4);
    expect(run.json.decision).toBe("refused");
    expect(run.json.reasons.map((r) => r.code)).toEqual(["normal_tag_name_collision"]);
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(history.pr42.mergeSha);

    // Afterwards the evaluation itself refuses the conflicting tag.
    const again = await release.evaluate(evidence.request, { dispatch });
    expect(again.code).toBe(4);
    expect(release.unsatisfied(again.json)).toContain("version:normal_tag_conflict");
    expect(repo.git("rev-parse", "v0.0.7^{commit}")).toBe(history.pr42.mergeSha);
  });

  it("never tags a newer main: drift before the object refuses, and drift after it leaves the object unreferenced", async () => {
    const { github, repo } = state;
    const { release: prepared, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;

    // Main moves between the object and the reference.
    let later = "";
    github.faults.push({
      method: "POST",
      path: /\/git\/tags$/,
      when: "before",
      effect: () => {
        later = repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" }).mergeSha;
      },
    });
    const run = await release.publish(plan, dispatch);
    expect(run.code).toBe(4);
    expect(run.json.decision).toBe("refused");
    expect(run.json.publication).toBe("none");
    expect(release.gate(run.json, "main")).toMatchObject({ state: "refused", reasons: [expect.objectContaining({ code: "main_moved" })] });
    const reason = run.json.reasons.find((r) => r.code === "main_moved")!;
    expect(reason.detail).toContain(`GitHub's main is ${later}`);
    expect(reason.detail).toContain("is unreferenced and nothing is published");
    expect(github.writes().map((w) => w.path.replace(`/repos/${REPOSITORY}`, ""))).toEqual(["/git/tags"]);
    expect(repo.git("tag", "--list", "v0.0.7")).toBe("");

    // Now main has moved before the writer starts: refused before any write, and the newer main is never tagged.
    const moved = await release.publish(plan, dispatch);
    expect(moved.code).toBe(4);
    expect(release.unsatisfied(moved.json)).toContain("main:main_moved");
    expect(github.writes()).toHaveLength(1);
    expect(repo.git("tag", "--points-at", later)).toBe("");
    expect(repo.git("tag", "--points-at", prepared.mergeSha)).toBe("");
  });

  it("publishes one tag when two writers race past the lock with the same plan", async () => {
    const { github, repo } = state;
    const { release: prepared, evidence, dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    const planPath = release.fixture.writePlan(plan);
    state.checkout.sync();

    const [first, second] = await Promise.all([
      release.publish(null, dispatch, { planPath, sync: false }),
      release.publish(null, dispatch, { planPath, sync: false }),
    ]);
    // One writer publishes. The other either finds that release when it reads the tag back, or finds its
    // checkout's tags out of date and stops; either way it claims nothing and moves nothing.
    const runs = [first, second];
    const winners = runs.filter((run) => run.code === 0 && run.json?.decision === "published");
    const losers = runs.filter((run) => run !== winners[0]);
    expect(winners, runs.map((run) => `${run.code} ${run.stdout.slice(0, 200)} ${run.stderr}`).join(" | ")).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [loser] = losers;
    if (loser.code === 0) expect(loser.json.decision).toBe("already_published");
    else expect([loser.code, loser.stderr]).toEqual([1, expect.stringContaining("tag_state_out_of_date")]);
    expect(github.writes().filter((w) => w.path.endsWith("/git/refs"))).toHaveLength(github.writes().length / 2);
    expect(repo.git("tag", "--points-at", prepared.mergeSha)).toBe("v0.0.7");
    expect(repo.git("for-each-ref", "--format=%(refname)", "refs/tags/v0.0.7*")).toBe("refs/tags/v0.0.7");
  });
});
