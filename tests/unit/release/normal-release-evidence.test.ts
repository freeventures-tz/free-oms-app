// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE, STATIC_GATE } from "./support/build-harness";
import {
  digestOf,
  INTRUDER,
  MAIN_POLICY,
  OWNER,
  policyText,
  PRODUCTION_URL,
  recordBody,
  REVIEWER,
  TIMES,
  useReleaseFixture,
  VERCEL,
  VERIFIER,
  type PreparedRelease,
  type ReleaseRequest,
} from "./support/release-harness";
import { runController } from "./support/run-controller";

/**
 * `evaluate-release` refusing what it cannot verify. Every case starts from complete, valid evidence and
 * changes one thing, so each refusal names the one gate that changed. A record that is merely well formed,
 * or written by the wrong account, at the wrong place or time, or for another head, version or deployment,
 * satisfies nothing. No evaluation writes to GitHub.
 */
describe("evaluate-release: every gate names what is missing", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  /** A request whose approval names `refs`, posted by the Owner after the acceptance. */
  const approved = (prepared: PreparedRelease, base: ReleaseRequest, refs: Partial<ReleaseRequest>) => {
    const request = { ...base, ...refs };
    const approval = release.comment(
      prepared.pr,
      OWNER,
      release.approvalBody(prepared, {
        deployment: request.deployment,
        review: request.review,
        productionAcceptance: request.productionAcceptance,
        hostedMigration: request.hostedMigration,
      }),
      TIMES.approved,
    );
    return { ...request, ownerApproval: approval.reference };
  };

  it("under main's own policy, a complete request is refused at the two gates that have no issuer, and nothing is written", async () => {
    const { evidence, dispatch } = await release.validRelease({ history: { policy: MAIN_POLICY } });
    const run = await release.evaluate(evidence.request, { dispatch });
    expect(run.code).toBe(4);
    expect(run.json.decision).toBe("refused");
    expect(release.unsatisfied(run.json)).toEqual([
      "review:evidence_issuer_unconfigured",
      "production-acceptance:evidence_issuer_unconfigured",
    ]);
    expect(run.json.owner).toEqual(OWNER);
    // The records are still read and reported, so the Owner can see what was supplied.
    expect(run.json.records.review).toMatchObject({ author: REVIEWER, digest: evidence.review.reference.split("@")[1], satisfied: false });
    expect(run.json.approvalTemplate).toBeNull();
    expect(state.github.writes()).toEqual([]);
  });

  it("counts a READY only from the independent issuer, unedited, on the preparation, for its reviewed head and version, before the merge", async () => {
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const at = (user = REVIEWER, body = release.reviewBody(prepared), options: { pr?: number; time?: string } = {}) =>
      release.comment(options.pr ?? prepared.pr, user, body, options.time ?? TIMES.review);

    // Edited after its reference was taken; edited before, so the reference has the new digest; and a
    // reference whose digest was never this body's.
    const editedAfter = at();
    const changed = release.reviewBody(prepared).replace("Release evidence", "Edited evidence");
    release.editComment(editedAfter.id, changed);
    const editedBefore = at();
    release.editComment(editedBefore.id, changed);
    const unedited = at();
    const wrongDigest = unedited.reference.replace(/[0-9a-f]{64}$/, "f".repeat(64));
    const hidden = `Looks fine to me.\r\n<!--\r\n${release.reviewBody(prepared)}-->\r\n`;
    const cases: Array<[string | string[], string]> = [
      ["evidence_wrong_issuer", at(OWNER).reference],
      [["evidence_digest_mismatch", "evidence_record_edited"], editedAfter.reference],
      ["evidence_record_edited", `comment:${editedBefore.id}@${digestOf(changed)}`],
      ["evidence_digest_mismatch", wrongDigest],
      ["evidence_block_invalid", at(REVIEWER, hidden).reference],
      ["evidence_wrong_location", at(REVIEWER, release.reviewBody(prepared), { pr: 42 }).reference],
      ["evidence_field_mismatch", at(REVIEWER, release.reviewBody(prepared, { "reviewed-head": history.pr42.headSha })).reference],
      ["evidence_field_mismatch", at(REVIEWER, release.reviewBody(prepared, { "pull-request": 40 })).reference],
      ["evidence_field_mismatch", at(REVIEWER, release.reviewBody(prepared, { version: "0.0.8" })).reference],
      ["evidence_verdict_not_accepted", at(REVIEWER, release.reviewBody(prepared, { verdict: "HOLD" })).reference],
      ["evidence_out_of_order", at(REVIEWER, release.reviewBody(prepared), { time: "2026-09-13T09:30:00Z" }).reference],
      ["evidence_block_invalid", at(REVIEWER, release.reviewBody(prepared, { scores: "9 9 9" })).reference],
      ["evidence_block_invalid", at(REVIEWER, `${release.reviewBody(prepared)}${release.reviewBody(prepared)}`).reference],
      ["evidence_block_invalid", at(REVIEWER, recordBody("production-acceptance", { version: "0.0.7" })).reference],
      ["evidence_block_invalid", at(REVIEWER, "READY for #43, no block").reference],
      ["evidence_record_missing", `comment:5799999999@sha256:${"a".repeat(64)}`],
    ];
    for (const [codes, review] of cases) {
      const expected = (Array.isArray(codes) ? codes : [codes]).map((code) => `review:${code}`);
      const run = await release.evaluate(approved(prepared, evidence.request, { review }), { dispatch });
      expect(run.code, `${expected} ${run.stderr}`).toBe(4);
      expect(release.unsatisfied(run.json), expected.join()).toEqual(expected);
    }
    // An id beyond JavaScript's safe integers would be read as another comment; it is a usage error.
    const unsafe = await release.evaluate({ ...evidence.request, review: `comment:12345678901234567@sha256:${"a".repeat(64)}` }, { dispatch });
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain("--review must be a record reference");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a policy that names the Owner's account as an independent issuer", async () => {
    const { release: prepared, evidence, dispatch } = await release.validRelease({
      history: { policy: policyText({ issuers: { "independent-review": OWNER, "production-acceptance": { login: "FREEVENTURES-TZ", id: 5 } } }) },
    });
    const review = release.comment(prepared.pr, OWNER, release.reviewBody(prepared), TIMES.review);
    const run = await release.evaluate(approved(prepared, evidence.request, { review: review.reference }), { dispatch });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual([
      "review:evidence_issuer_not_independent",
      "production-acceptance:evidence_issuer_not_independent",
      "production-acceptance:evidence_wrong_issuer",
    ]);
  });

  it("counts production acceptance only from its issuer, for this commit and deployment, after the deployment succeeded", async () => {
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const accept = (user = VERIFIER, overrides: Record<string, string | number> = {}, time = TIMES.accepted) =>
      release.comment(prepared.pr, user, release.acceptanceBody(prepared, evidence.deployment, overrides), time).reference;

    const cases: Array<[string, string]> = [
      ["evidence_wrong_issuer", accept(INTRUDER)],
      ["evidence_wrong_issuer", accept(OWNER)],
      ["evidence_field_mismatch", accept(VERIFIER, { commit: history.pr42.mergeSha })],
      ["evidence_field_mismatch", accept(VERIFIER, { deployment: evidence.deployment + 1 })],
      ["evidence_verdict_not_accepted", accept(VERIFIER, { verdict: "REJECTED" })],
      ["evidence_out_of_order", accept(VERIFIER, {}, "2026-09-13T09:05:30Z")],
      ["evidence_record_missing", `comment:5799999998@sha256:${"b".repeat(64)}`],
    ];
    for (const [code, productionAcceptance] of cases) {
      const run = await release.evaluate(approved(prepared, evidence.request, { productionAcceptance }), { dispatch });
      expect(run.code, code).toBe(4);
      expect(release.unsatisfied(run.json), code).toEqual([`production-acceptance:${code}`]);
    }

    // Leaving the acceptance out is a usage error, not a pass.
    const args = await release.evaluate({ ...evidence.request, productionAcceptance: "" }, { dispatch });
    expect(args.code).toBe(2);
    expect(args.stderr).toContain("--production-acceptance must be a record reference");
    expect(state.github.writes()).toEqual([]);
  });

  it("counts an approval only when the Owner wrote it after the acceptance and it binds every value of this release", async () => {
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const refs = {
      deployment: evidence.deployment,
      review: evidence.review.reference,
      productionAcceptance: evidence.acceptance.reference,
    };
    const approve = (user = OWNER, overrides: Record<string, string | number> = {}, time = TIMES.approved) =>
      release.comment(prepared.pr, user, release.approvalBody(prepared, refs, overrides), time).reference;

    // An older, valid READY for the same head, replayed in place of the one the request names.
    const otherReview = release.comment(prepared.pr, REVIEWER, release.reviewBody(prepared), "2026-09-13T08:10:00Z").reference;
    const cases: Array<[string, string]> = [
      ["evidence_wrong_issuer", approve(INTRUDER)],
      ["evidence_wrong_issuer", approve({ login: "freeventures-tz", id: 1 })],
      ["evidence_field_mismatch", approve(OWNER, { version: "0.0.8" })],
      ["evidence_field_mismatch", approve(OWNER, { tag: "v0.0.8" })],
      ["evidence_field_mismatch", approve(OWNER, { commit: history.pr42.mergeSha })],
      ["evidence_field_mismatch", approve(OWNER, { "reviewed-head": prepared.mergeSha })],
      ["evidence_field_mismatch", approve(OWNER, { "authorized-actions": "publish-normal-tag, deploy" })],
      ["evidence_field_mismatch", approve(OWNER, { review: otherReview })],
      ["evidence_field_mismatch", approve(OWNER, { "schema-boundary": `unchanged ${"0".repeat(40)}` })],
      ["evidence_field_mismatch", approve(OWNER, { "release-date": "2026-09-21" })],
      ["evidence_field_mismatch", approve(OWNER, { "hosted-migration": otherReview })],
      ["evidence_out_of_order", approve(OWNER, {}, "2026-09-13T09:59:00Z")],
    ];
    for (const [code, ownerApproval] of cases) {
      const run = await release.evaluate({ ...evidence.request, ownerApproval }, { dispatch });
      expect(run.code, code).toBe(4);
      expect(release.unsatisfied(run.json), code).toEqual([`owner-approval:${code}`]);
    }

    // With every other gate satisfied, the report prints the approval the evidence calls for. Posted by the
    // Owner, that block is what satisfies the gate.
    const wrong = await release.evaluate({ ...evidence.request, ownerApproval: approve(OWNER, { version: "0.0.8" }) }, { dispatch });
    const template = wrong.json.approvalTemplate!;
    expect(template).toBe(
      [
        "```release-evidence",
        "schema: 1",
        "kind: owner-release-approval",
        "repository: freeventures-tz/free-oms-app",
        "version: 0.0.7",
        "tag: v0.0.7",
        `commit: ${prepared.mergeSha}`,
        "pull-request: 43",
        `reviewed-head: ${prepared.reviewedHead}`,
        "release-date: 2026-09-20",
        `schema-boundary: ${prepared.boundary}`,
        `deployment: ${evidence.deployment}`,
        `review: ${evidence.review.reference}`,
        `production-acceptance: ${evidence.acceptance.reference}`,
        "hosted-migration: none",
        "authorized-actions: publish-normal-tag",
        "```",
        "",
      ].join("\n"),
    );
    const posted = release.comment(prepared.pr, OWNER, `I approve this release.\n\n${template}`, TIMES.approved, { via: "chatgpt-connector" });
    const run = await release.evaluate({ ...evidence.request, ownerApproval: posted.reference }, { dispatch });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json.decision).toBe("eligible");
    // A record posted through an integration is reported, and proves nothing either way about who wrote it.
    expect(run.json.records.ownerApproval).toMatchObject({ via: "chatgpt-connector", author: OWNER, satisfied: true });
    expect(state.github.writes()).toEqual([]);
  });

  it("checks the dispatch from GitHub's record of the run: the Owner started it and its current attempt", async () => {
    const { history, release: prepared, evidence } = await release.validRelease();
    const sha = prepared.mergeSha;
    const intruded = await release.evaluate(evidence.request, { dispatch: release.dispatch(sha, { actor: INTRUDER }) });
    expect(intruded.code).toBe(4);
    expect(release.unsatisfied(intruded.json)).toEqual([
      "dispatch:dispatch_actor_not_owner",
      "dispatch:dispatch_triggering_actor_not_owner",
    ]);
    expect(intruded.json.dispatch).toMatchObject({ actor: INTRUDER, triggeringActor: INTRUDER });

    // A dispatch whose run has finished authorises nothing more.
    const finished = release.dispatch(sha);
    Object.assign(state.github.runs.get(finished.runId)!.attempts[0], { status: "completed", conclusion: "success" });
    const cases: Array<[string, ReturnType<typeof release.dispatch>]> = [
      ["dispatch_run_invalid", release.dispatch(sha, { event: "push" })],
      ["dispatch_run_invalid", release.dispatch(sha, { branch: "release/v0.0.7" })],
      ["dispatch_run_invalid", release.dispatch(sha, { headSha: history.pr42.mergeSha })],
      ["dispatch_run_invalid", release.dispatch(sha, { path: ".github/workflows/release-build-tag.yml" })],
      ["dispatch_run_invalid", release.dispatch(sha, { workflowId: 1 })],
      ["dispatch_run_invalid", { runId: 99999, attempt: 1 }],
      ["dispatch_run_invalid", finished],
    ];
    for (const [code, dispatch] of cases) {
      const run = await release.evaluate(evidence.request, { dispatch });
      expect(run.code, code).toBe(4);
      expect(release.unsatisfied(run.json), `${code} ${dispatch.runId}`).toEqual([`dispatch:${code}`]);
    }

    const owners = release.dispatch(sha);
    const byIntruder = release.rerun(owners, INTRUDER);
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch: byIntruder })).json)).toEqual([
      "dispatch:dispatch_triggering_actor_not_owner",
    ]);
    const byOwner = release.rerun(owners, OWNER);
    expect((await release.evaluate(evidence.request, { dispatch: byOwner })).json.decision).toBe("eligible");
    // An earlier attempt is not the run as it stands.
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch: byIntruder })).json)).toEqual([
      "dispatch:dispatch_run_invalid",
      "dispatch:dispatch_triggering_actor_not_owner",
    ]);
    // Without a dispatch, a local evaluation reports the gate unchecked; the writer always checks it.
    const local = await release.evaluate(evidence.request);
    expect(local.json.decision).toBe("eligible");
    expect(release.gate(local.json, "dispatch").state).toBe("not_checked");
  });

  it("accepts only Vercel's newest successful production deployment of the exact commit", async () => {
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const sha = prepared.mergeSha;
    /** A request naming `deployment`, with an acceptance and approval that name it too. */
    const naming = (deployment: number) => {
      const productionAcceptance = release.comment(prepared.pr, VERIFIER, release.acceptanceBody(prepared, deployment), TIMES.accepted).reference;
      return approved(prepared, evidence.request, { deployment, productionAcceptance });
    };

    // Each case is the newest deployment, unless it is not Vercel's production deployment: then the valid one
    // is still Vercel's newest there, and the case is superseded as well.
    const cases: Array<[string[], () => number]> = [
      [["deployment_wrong_creator", "deployment_wrong_creator", "deployment_superseded"], () => release.deploy(sha, { creator: INTRUDER })],
      [["deployment_wrong_creator"], () => release.deploy(sha, { statusCreator: INTRUDER })],
      [["deployment_wrong_environment", "deployment_superseded"], () => release.deploy(sha, { environment: "Preview" })],
      [["deployment_not_successful"], () => release.deploy(sha, { state: "failure" })],
      [["deployment_not_successful"], () => release.deploy(sha, { state: "inactive" })],
      [["deployment_wrong_project"], () => release.deploy(sha, { url: "https://free-oms-k3x9q2w7r-someone-else.vercel.app" })],
      [["deployment_wrong_project"], () => release.deploy(sha, { url: "https://other-app-k3x9q2w7r-freeventures-tz.vercel.app" })],
      [["deployment_wrong_project"], () => release.deploy(sha, { url: PRODUCTION_URL.replace("https:", "http:") })],
    ];
    for (const [codes, make] of cases) {
      const id = make();
      const run = await release.evaluate(naming(id), { dispatch });
      expect(run.code, codes.join()).toBe(4);
      expect(release.unsatisfied(run.json), codes.join()).toEqual(codes.map((code) => `deployment:${code}`));
      state.github.deployments.delete(id);
    }

    const wrongCommit = release.deploy(history.pr42.mergeSha);
    expect(release.unsatisfied((await release.evaluate(naming(wrongCommit), { dispatch })).json)).toEqual([
      "deployment:deployment_wrong_commit",
    ]);
    state.github.deployments.delete(wrongCommit);

    const missing = await release.evaluate(naming(6599999999), { dispatch });
    expect(release.unsatisfied(missing.json)).toEqual(["deployment:deployment_missing"]);

    // A newer production deployment supersedes the one the request names.
    const newer = release.deploy(sha, { createdAt: "2026-09-13T09:30:00Z" });
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch })).json)).toEqual([
      "deployment:deployment_superseded",
    ]);
    state.github.deployments.delete(newer);

    const building = release.deploy(sha, { state: "in_progress" });
    const pending = await release.evaluate(naming(building), { dispatch });
    expect(pending.code).toBe(3);
    expect(pending.json.decision).toBe("pending");
    expect(release.unsatisfied(pending.json)).toEqual(["deployment:deployment_in_progress"]);
    expect(pending.json.deployment).toMatchObject({ id: building, state: "in_progress", environmentUrl: PRODUCTION_URL });
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses the wrong version, the wrong preparation, stable 1.0.0, and a tag name that is not free", async () => {
    const { history, release: prepared, evidence, dispatch } = await release.validRelease();
    const { repo } = state;

    const wrongVersion = await release.evaluate({ ...evidence.request, version: "0.0.8" }, { dispatch });
    expect(wrongVersion.code).toBe(4);
    // The records name 0.0.7, so each of them disagrees too; the approval twice, in its version and its tag.
    expect(release.unsatisfied(wrongVersion.json)).toEqual([
      "version:version_mismatch",
      "review:evidence_field_mismatch",
      "production-acceptance:evidence_field_mismatch",
      "owner-approval:evidence_field_mismatch",
      "owner-approval:evidence_field_mismatch",
    ]);
    const stable = await release.evaluate({ ...evidence.request, version: "1.0.0" }, { dispatch });
    expect(release.unsatisfied(stable.json)).toContain("version:stable_contract_acceptance_undecided");
    expect(release.unsatisfied(stable.json)).not.toContain("version:version_mismatch");

    const otherPr = await release.evaluate({ ...evidence.request, preparationPr: 99 }, { dispatch });
    // Without the named preparation there is no reviewed head, so the review and the approval cannot be checked.
    expect(release.unsatisfied(otherPr.json)).toEqual([
      "preparation:preparation_pr_mismatch",
      "review:not_checked",
      "production-acceptance:evidence_wrong_location",
      "owner-approval:not_checked",
    ]);

    const notPreparation = await release.evaluate({ ...evidence.request, sha: history.pr42.mergeSha }, { dispatch });
    expect(notPreparation.code).toBe(4);
    expect(release.unsatisfied(notPreparation.json)).toEqual(
      expect.arrayContaining([
        "dispatch:dispatch_run_invalid",
        "main:main_moved",
        "preparation:preparation_pr_mismatch",
        "deployment:deployment_wrong_commit",
        "production-acceptance:evidence_field_mismatch",
      ]),
    );

    // A higher normal release anywhere, and another normal tag on the commit.
    const aside = repo.unmergedCommit("docs: a release elsewhere");
    repo.tag("v0.0.9", aside);
    const newer = await release.evaluate(evidence.request, { dispatch });
    expect(release.unsatisfied(newer.json)).toEqual(["version:normal_version_not_newest"]);
    repo.git("tag", "-d", "v0.0.9");
    repo.tag("v0.1.0", prepared.mergeSha);
    const twice = await release.evaluate(evidence.request, { dispatch });
    expect(release.unsatisfied(twice.json)).toEqual(["version:target_already_released", "version:normal_version_not_newest"]);
    repo.git("tag", "-d", "v0.1.0");

    // The requested name already taken at the commit, by a lightweight tag or by an annotation that is not this release.
    repo.lightweightTag("v0.0.7", prepared.mergeSha);
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch })).json)).toEqual(["version:normal_tag_conflict"]);
    repo.git("tag", "-d", "v0.0.7");
    repo.tag("v0.0.7", prepared.mergeSha, "Release v0.0.7 of freeventures-tz/free-oms-app\n\nMade by hand.");
    const handMade = await release.evaluate(evidence.request, { dispatch });
    expect(release.unsatisfied(handMade.json)).toEqual(["version:normal_tag_conflict"]);
    expect(handMade.json.reasons[0].detail).toContain("carries no complete release provenance");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a preparation made stale by a merge during its review", async () => {
    const { repo } = state;
    release.history();
    release.prep.startBranch();
    release.prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    const prepared = await release.prep.prepare(["--sha", repo.git("rev-parse", "main"), "--pr", "43", "--date", "2026-09-20"]);
    expect(prepared.json.status).toBe("prepared");
    release.prep.commitPreparation("chore(release): prepare 0.0.7");
    release.prep.pushBranch();
    // #44 merges while the preparation is in review, and the preparation merges without being updated.
    repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" });
    const merge = release.prep.mergePreparation(43, "chore(release): prepare 0.0.7");
    const stale: PreparedRelease = {
      pr: 43,
      version: "0.0.7",
      mergeSha: merge.mergeSha,
      reviewedHead: merge.headSha,
      boundary: release.boundary(merge.mergeSha),
    };
    const evidence = release.evidence(stale);
    const run = await release.evaluate(evidence.request, { dispatch: release.dispatch(stale.mergeSha) });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual(["preparation:prepared_changelog_stale"]);
    expect(run.json.reasons[0].detail).toContain("it leaves out #44");
  });

  it("refuses a release when main has moved past the approved commit", async () => {
    const { evidence, dispatch } = await release.validRelease();
    state.repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" });
    const run = await release.evaluate(evidence.request, { dispatch });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual(["main:main_moved"]);
    expect(state.github.writes()).toEqual([]);

    // The Markdown report names the gate and its code, and prints no approval block while a gate is refused.
    const markdown = await runController(
      [
        "evaluate-release",
        "--repo",
        "freeventures-tz/free-oms-app",
        "--repo-id",
        "1329892477",
        "--main-ref",
        "origin/main",
        "--path",
        state.checkout.dir,
        "--sha",
        evidence.request.sha,
        "--version",
        evidence.request.version,
        "--preparation-pr",
        String(evidence.request.preparationPr),
        "--deployment",
        String(evidence.request.deployment),
        "--review",
        evidence.request.review,
        "--production-acceptance",
        evidence.request.productionAcceptance,
        "--owner-approval",
        evidence.request.ownerApproval,
      ],
      { env: release.fixture.environment(null) },
    );
    expect(markdown.code).toBe(4);
    expect(markdown.stdout).toContain("## Normal release `v0.0.7`: refused");
    expect(markdown.stdout).toContain("| main | refused |");
    expect(markdown.stdout).toContain("| dispatch | not checked |");
    expect(markdown.stdout).toContain("- main · `main_moved` (refusal): ");
    expect(markdown.stdout).not.toContain("### The Owner's approval");
    expect(markdown.stdout).not.toContain("### Final release notes");
  });

  it("requires every final-merge CI gate of the exact commit: failed, skipped, unfinished and missing runs hold the release", async () => {
    const { release: prepared, evidence, dispatch } = await release.validRelease();
    const run = state.github.runs.get(evidence.ciRun)!;
    const passing = run.attempts;

    const evaluateWith = async (attempts: typeof passing) => {
      run.attempts = attempts;
      return release.evaluate(evidence.request, { dispatch });
    };
    const job = (name: string, conclusion: string | null, status = "completed") => ({ name, status, conclusion });
    const withJob = (replacement: ReturnType<typeof job>, runStatus = "completed", runConclusion: string | null = "failure") => [
      {
        status: runStatus,
        conclusion: runConclusion,
        jobs: passing[0].jobs.map((existing) => (existing.name === replacement.name ? replacement : existing)),
      },
    ];

    const failed = await evaluateWith(withJob(job(E2E_GATE, "failure")));
    expect(failed.code).toBe(5);
    expect(failed.json.decision).toBe("failed");
    expect(release.unsatisfied(failed.json)).toEqual(["ci:required_gate_failed"]);

    const skipped = await evaluateWith(withJob(job(STATIC_GATE, "skipped")));
    expect(skipped.code).toBe(5);
    expect(release.unsatisfied(skipped.json)).toEqual(["ci:required_gate_skipped"]);

    const unfinished = await evaluateWith(withJob(job(E2E_GATE, null, "in_progress"), "in_progress", null));
    expect(unfinished.code).toBe(3);
    expect(unfinished.json.decision).toBe("pending");
    expect(release.unsatisfied(unfinished.json)).toEqual(["ci:ci_incomplete"]);

    // A pull-request run of the same commit is not final-merge CI.
    run.attempts = passing;
    run.event = "pull_request";
    const missing = await release.evaluate(evidence.request, { dispatch });
    expect(missing.code).toBe(3);
    expect(release.unsatisfied(missing.json)).toEqual(["ci:ci_run_missing"]);
    run.event = "push";

    // A failed attempt retried on the same run satisfies the gate, and the failure stays on record.
    const retried = await evaluateWith([...withJob(job(E2E_GATE, "failure")), passing[0]]);
    expect(retried.code, retried.stderr).toBe(0);
    expect(retried.json.ci!.satisfiedBy).toMatchObject({ runId: evidence.ciRun, attempt: 2 });
    const published = await release.publish(retried.json, dispatch);
    expect(published.json.decision).toBe("published");
    const annotation = state.repo.git("cat-file", "tag", "v0.0.7");
    expect(annotation).toContain(`- run ${evidence.ciRun} attempt 1: failure (${E2E_GATE} failure)`);
    expect(annotation).toContain(`- accepted flaky retry in run ${evidence.ciRun}: ${E2E_GATE} failure in attempt 1, success in attempt 2`);
    expect(annotation).toContain("CI-Attempt: 2");
    expect(state.repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);
  });

  it("refuses a release whose commit carries no usable release-evidence policy", async () => {
    const { evidence, dispatch } = await release.validRelease({ history: { policy: null } });
    const missing = await release.evaluate(evidence.request, { dispatch });
    expect(missing.code).toBe(4);
    expect(release.gate(missing.json, "policy").reasons.map((r) => r.code)).toEqual(["release_policy_missing"]);
    for (const gate of ["dispatch", "deployment", "review", "production-acceptance", "owner-approval"]) {
      expect(release.gate(missing.json, gate).state, gate).toBe("not_checked");
    }

    // A policy that is present but unusable. Each is committed directly on main, which history also holds
    // for a decision; the policy is refused all the same.
    for (const text of [
      "not json",
      policyText({ extra: { schema: 2 } }),
      policyText({ extra: { repository: "someone/else" } }),
      policyText({ extra: { owner: { login: "freeventures-tz" } } }),
      policyText({ extra: { issuers: { "independent-review": REVIEWER, "production-acceptance": VERIFIER } } }),
      policyText({ extra: { issuers: { "independent-review": REVIEWER, "production-acceptance": VERIFIER, "hosted-migration": null, deploy: null } } }),
      policyText({ extra: { vercel: { creator: VERCEL, environment: "Production", project: "Free OMS", team: "freeventures-tz" } } }),
    ]) {
      state.repo.commitFile("scripts/release/release-evidence-policy.json", text, "chore: change the policy");
      const commit = state.repo.head();
      const run = await release.evaluate({ ...evidence.request, sha: commit }, { dispatch });
      expect(release.gate(run.json, "policy").reasons.map((r) => r.code), text.slice(0, 60)).toEqual(["release_policy_invalid"]);
    }
    expect(state.github.writes()).toEqual([]);
  });
});
