// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE, STATIC_GATE } from "./support/build-harness";
import {
  AUTOMATIC_WORKFLOW_PATH,
  CHATGPT,
  digestOf,
  INTRUDER,
  MAIN_POLICY,
  OWNER,
  policyText,
  PRODUCTION_URL,
  recordBody,
  REVIEWER,
  TICKET,
  TIMES,
  useReleaseFixture,
  VERCEL,
  VERIFIER,
  type PreparedRelease,
} from "./support/release-harness";
import { runController } from "./support/run-controller";

/**
 * Every gate naming what is missing. Each case starts from complete, valid evidence for a release below the
 * policy's stable version and changes one thing, so each refusal names the one gate that changed.
 *
 * A record that is merely well formed satisfies nothing. Under this policy the Owner's account is the only
 * identity GitHub authenticates, so every record is a comment the Owner wrote, attesting whose work it is.
 * That authorship is what the controller can check; the `agent` field is not proof of who wrote the text,
 * and a record written by anyone else is refused whatever it attests. No evaluation writes to GitHub.
 */
describe("evaluate-release: every gate names what is missing", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  it("publishes a 0.x release under main's own committed policy, with no further Owner decision", async () => {
    const { evidence, run } = await release.validRelease({ history: { policy: MAIN_POLICY } });
    const plan = await release.evaluate(evidence.request, { dispatch: run });
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.json.decision).toBe("eligible");
    expect(plan.json.mode).toBe("standing");
    expect(plan.json.owner).toEqual(OWNER);
    // Every record is the Owner's, attesting ChatGPT's work on this release's ticket.
    for (const kind of ["review", "productionAcceptance"] as const) {
      expect(plan.json.records[kind], kind).toMatchObject({ author: OWNER, agent: CHATGPT, ticket: TICKET, satisfied: true });
    }
    expect(plan.json.records.ownerApproval).toBeNull();
    expect(state.github.writes()).toEqual([]);
  });

  it("counts a READY only from the Owner, unedited, on the preparation, for its reviewed head and version, before the merge", async () => {
    const { history, release: prepared, evidence, run } = await release.validRelease();
    const at = (user = OWNER, body = release.reviewBody(prepared), options: { pr?: number; time?: string } = {}) =>
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
      ["evidence_wrong_issuer", at(REVIEWER).reference],
      ["evidence_wrong_issuer", at(INTRUDER).reference],
      [["evidence_digest_mismatch", "evidence_record_edited"], editedAfter.reference],
      ["evidence_record_edited", `comment:${editedBefore.id}@${digestOf(changed)}`],
      ["evidence_digest_mismatch", wrongDigest],
      ["evidence_block_invalid", at(OWNER, hidden).reference],
      ["evidence_wrong_location", at(OWNER, release.reviewBody(prepared), { pr: 42 }).reference],
      ["evidence_agent_mismatch", at(OWNER, release.reviewBody(prepared, { agent: "Claude Code" })).reference],
      ["evidence_role_mismatch", at(OWNER, release.reviewBody(prepared, { role: "production-acceptance" })).reference],
      ["evidence_ticket_mismatch", at(OWNER, release.reviewBody(prepared, { ticket: "#40" })).reference],
      ["evidence_ticket_invalid", at(OWNER, release.reviewBody(prepared, { ticket: "PR 43" })).reference],
      ["evidence_field_mismatch", at(OWNER, release.reviewBody(prepared, { "reviewed-head": history.pr42.headSha })).reference],
      ["evidence_field_mismatch", at(OWNER, release.reviewBody(prepared, { "pull-request": 40 })).reference],
      ["evidence_field_mismatch", at(OWNER, release.reviewBody(prepared, { version: "0.0.8" })).reference],
      ["evidence_verdict_not_accepted", at(OWNER, release.reviewBody(prepared, { verdict: "HOLD" })).reference],
      ["evidence_out_of_order", at(OWNER, release.reviewBody(prepared), { time: "2026-09-13T09:30:00Z" }).reference],
      ["evidence_block_invalid", at(OWNER, release.reviewBody(prepared, { scores: "9 9 9" })).reference],
      ["evidence_block_invalid", at(OWNER, `${release.reviewBody(prepared)}${release.reviewBody(prepared)}`).reference],
      ["evidence_block_invalid", at(OWNER, recordBody("production-acceptance", { version: "0.0.7" })).reference],
      ["evidence_block_invalid", at(OWNER, "READY for #43, no block").reference],
      ["evidence_record_missing", `comment:5799999999@sha256:${"a".repeat(64)}`],
    ];
    for (const [codes, review] of cases) {
      const expected = (Array.isArray(codes) ? codes : [codes]).map((code) => `review:${code}`);
      // The acceptance names the review it rests on, so replacing one means posting the other again.
      const acceptance = release.comment(
        prepared.pr,
        OWNER,
        release.acceptanceBody(prepared, { deployment: evidence.deployment, review }),
        TIMES.accepted,
      );
      const attempt = await release.evaluate({ ...evidence.request, review, productionAcceptance: acceptance.reference }, { dispatch: run });
      expect(attempt.code, `${expected} ${attempt.stderr}`).toBe(4);
      expect(release.unsatisfied(attempt.json), expected.join()).toEqual(expected);
    }
    // An id beyond JavaScript's safe integers would be read as another comment; it is a usage error.
    const unsafe = await release.evaluate({ ...evidence.request, review: `comment:12345678901234567@sha256:${"a".repeat(64)}` }, { dispatch: run });
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain("--review must be a record reference");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a policy that names an evidence author this repository cannot authenticate", async () => {
    // Only the Owner's account is authenticated here. A policy naming anyone else as the author would accept
    // a record nobody can vouch for, so it is not a policy this controller will act on at all.
    const { evidence, run } = await release.validRelease({ history: { policy: policyText({ author: "reviewer" }) } });
    const unusable = await release.evaluate(evidence.request, { dispatch: run });
    expect(unusable.code).toBe(4);
    expect(release.gate(unusable.json, "policy").reasons.map((r) => r.code)).toEqual(["release_policy_invalid"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses the gate of a kind the policy leaves unattested, rather than accepting anything for it", async () => {
    const { evidence, run } = await release.validRelease({
      history: { policy: policyText({ attestations: { "independent-review": null } }) },
    });
    const unattested = await release.evaluate(evidence.request, { dispatch: run });
    expect(unattested.code).toBe(4);
    expect(release.unsatisfied(unattested.json)).toContain("review:evidence_attestation_unconfigured");
    expect(state.github.writes()).toEqual([]);
  });

  it("counts production acceptance only from the Owner, for this commit and deployment, after the deployment succeeded", async () => {
    const { history, release: prepared, evidence, run } = await release.validRelease();
    const refs = { deployment: evidence.deployment, review: evidence.review.reference };
    const accept = (user = OWNER, overrides: Record<string, string | number> = {}, time = TIMES.accepted) =>
      release.comment(prepared.pr, user, release.acceptanceBody(prepared, refs, overrides), time).reference;

    const cases: Array<[string, string]> = [
      ["evidence_wrong_issuer", accept(INTRUDER)],
      ["evidence_wrong_issuer", accept(VERIFIER)],
      ["evidence_field_mismatch", accept(OWNER, { commit: history.pr42.mergeSha })],
      ["evidence_field_mismatch", accept(OWNER, { deployment: evidence.deployment + 1 })],
      ["evidence_agent_mismatch", accept(OWNER, { agent: "Claude Code" })],
      ["evidence_role_mismatch", accept(OWNER, { role: "hosted-migration" })],
      ["evidence_ticket_mismatch", accept(OWNER, { ticket: "#40" })],
      ["evidence_verdict_not_accepted", accept(OWNER, { verdict: "REJECTED" })],
      ["evidence_out_of_order", accept(OWNER, {}, "2026-09-13T09:05:30Z")],
      ["evidence_record_missing", `comment:5799999998@sha256:${"b".repeat(64)}`],
    ];
    for (const [code, productionAcceptance] of cases) {
      const attempt = await release.evaluate({ ...evidence.request, productionAcceptance }, { dispatch: run });
      expect(attempt.code, code).toBe(4);
      expect(release.unsatisfied(attempt.json), code).toEqual([`production-acceptance:${code}`]);
    }

    // Leaving the acceptance out is a usage error, not a pass.
    const args = await release.evaluate({ ...evidence.request, productionAcceptance: "" }, { dispatch: run });
    expect(args.code).toBe(2);
    expect(args.stderr).toContain("--production-acceptance must be a record reference");

    // So is leaving the ticket out: nothing binds the records to one another without it.
    const noTicket = await release.evaluate({ ...evidence.request, ticket: "" }, { dispatch: run });
    expect(noTicket.code).toBe(2);
    expect(noTicket.stderr).toContain("--ticket must be the release-control work item");
    expect(state.github.writes()).toEqual([]);
  });

  it("checks the dispatch from GitHub's record of the run: the Owner started it, and the route matches the version", async () => {
    const { history, release: prepared, evidence } = await release.validRelease();
    const sha = prepared.mergeSha;
    const intruded = await release.evaluate(evidence.request, { dispatch: release.automaticRun(sha, { actor: INTRUDER }) });
    expect(intruded.code).toBe(4);
    expect(release.unsatisfied(intruded.json)).toEqual([
      "dispatch:dispatch_actor_not_owner",
      "dispatch:dispatch_triggering_actor_not_owner",
    ]);
    expect(intruded.json.dispatch).toMatchObject({ mode: "standing", workflow: AUTOMATIC_WORKFLOW_PATH, actor: INTRUDER });

    // A run whose attempt has finished authorises nothing more.
    const finished = release.automaticRun(sha);
    Object.assign(state.github.runs.get(finished.runId)!.attempts[0], { status: "completed", conclusion: "success" });
    const cases: Array<[string, ReturnType<typeof release.automaticRun>]> = [
      ["dispatch_run_invalid", release.automaticRun(sha, { event: "push" })],
      ["dispatch_run_invalid", release.automaticRun(sha, { branch: "release/v0.0.7" })],
      ["dispatch_run_invalid", release.automaticRun(sha, { headSha: history.pr42.mergeSha })],
      ["dispatch_run_invalid", release.automaticRun(sha, { path: ".github/workflows/release-build-tag.yml" })],
      ["dispatch_run_invalid", release.automaticRun(sha, { workflowId: 1 })],
      ["dispatch_run_invalid", { runId: 99999, attempt: 1 }],
      ["dispatch_run_invalid", finished],
      // The manual stable route is not this release's route, however the Owner started it.
      ["dispatch_run_invalid", release.dispatch(sha)],
    ];
    for (const [code, dispatch] of cases) {
      const attempt = await release.evaluate(evidence.request, { dispatch });
      expect(attempt.code, code).toBe(4);
      expect(release.unsatisfied(attempt.json), `${code} ${dispatch.runId}`).toEqual([`dispatch:${code}`]);
    }

    const owners = release.automaticRun(sha);
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
    const { history, release: prepared, evidence, run } = await release.validRelease();
    const sha = prepared.mergeSha;
    /** A request naming `deployment`, with an acceptance that names it too. */
    const naming = (deployment: number) => {
      const productionAcceptance = release.comment(
        prepared.pr,
        OWNER,
        release.acceptanceBody(prepared, { deployment, review: evidence.review.reference }),
        TIMES.accepted,
      ).reference;
      return { ...evidence.request, deployment, productionAcceptance };
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
      const attempt = await release.evaluate(naming(id), { dispatch: run });
      expect(attempt.code, codes.join()).toBe(4);
      expect(release.unsatisfied(attempt.json), codes.join()).toEqual(codes.map((code) => `deployment:${code}`));
      state.github.deployments.delete(id);
    }

    const wrongCommit = release.deploy(history.pr42.mergeSha);
    expect(release.unsatisfied((await release.evaluate(naming(wrongCommit), { dispatch: run })).json)).toEqual([
      "deployment:deployment_wrong_commit",
    ]);
    state.github.deployments.delete(wrongCommit);

    const missing = await release.evaluate(naming(6599999999), { dispatch: run });
    expect(release.unsatisfied(missing.json)).toEqual(["deployment:deployment_missing"]);

    // A newer production deployment supersedes the one the request names.
    const newer = release.deploy(sha, { createdAt: "2026-09-13T09:30:00Z" });
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch: run })).json)).toEqual([
      "deployment:deployment_superseded",
    ]);
    state.github.deployments.delete(newer);

    const building = release.deploy(sha, { state: "in_progress" });
    const pending = await release.evaluate(naming(building), { dispatch: run });
    expect(pending.code).toBe(3);
    expect(pending.json.decision).toBe("pending");
    expect(release.unsatisfied(pending.json)).toEqual(["deployment:deployment_in_progress"]);
    expect(pending.json.deployment).toMatchObject({ id: building, state: "in_progress", environmentUrl: PRODUCTION_URL });
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses the wrong version, the wrong preparation, and a tag name that is not free", async () => {
    const { history, release: prepared, evidence, run } = await release.validRelease();
    const { repo } = state;

    const wrongVersion = await release.evaluate({ ...evidence.request, version: "0.0.8" }, { dispatch: run });
    expect(wrongVersion.code).toBe(4);
    // The records name 0.0.7, so each of them disagrees too.
    expect(release.unsatisfied(wrongVersion.json)).toEqual([
      "version:version_mismatch",
      "review:evidence_field_mismatch",
      "production-acceptance:evidence_field_mismatch",
    ]);

    const otherPr = await release.evaluate({ ...evidence.request, preparationPr: 99 }, { dispatch: run });
    // Without the named preparation there is no reviewed head, so the review cannot be checked.
    expect(release.unsatisfied(otherPr.json)).toEqual([
      "preparation:preparation_pr_mismatch",
      "review:not_checked",
      "production-acceptance:evidence_wrong_location",
      "production-acceptance:evidence_field_mismatch",
    ]);

    const notPreparation = await release.evaluate({ ...evidence.request, sha: history.pr42.mergeSha }, { dispatch: run });
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
    const newer = await release.evaluate(evidence.request, { dispatch: run });
    expect(release.unsatisfied(newer.json)).toEqual(["version:normal_version_not_newest"]);
    repo.git("tag", "-d", "v0.0.9");
    repo.tag("v0.1.0", prepared.mergeSha);
    const twice = await release.evaluate(evidence.request, { dispatch: run });
    expect(release.unsatisfied(twice.json)).toEqual(["version:target_already_released", "version:normal_version_not_newest"]);
    repo.git("tag", "-d", "v0.1.0");

    // The requested name already taken at the commit, by a lightweight tag or by an annotation that is not this release.
    repo.lightweightTag("v0.0.7", prepared.mergeSha);
    expect(release.unsatisfied((await release.evaluate(evidence.request, { dispatch: run })).json)).toEqual(["version:normal_tag_conflict"]);
    repo.git("tag", "-d", "v0.0.7");
    repo.tag("v0.0.7", prepared.mergeSha, "Release v0.0.7 of freeventures-tz/free-oms-app\n\nMade by hand.");
    const handMade = await release.evaluate(evidence.request, { dispatch: run });
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
    const attempt = await release.evaluate(evidence.request, { dispatch: release.automaticRun(stale.mergeSha) });
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toEqual(["preparation:prepared_changelog_stale"]);
    expect(attempt.json.reasons[0].detail).toContain("it leaves out #44");
  });

  it("refuses a release when main has moved past the accepted commit", async () => {
    const { evidence, run } = await release.validRelease();
    state.repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" });
    const attempt = await release.evaluate(evidence.request, { dispatch: run });
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toEqual(["main:main_moved"]);
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
        "--ticket",
        evidence.request.ticket,
        "--preparation-pr",
        String(evidence.request.preparationPr),
        "--deployment",
        String(evidence.request.deployment),
        "--review",
        evidence.request.review,
        "--production-acceptance",
        evidence.request.productionAcceptance,
        "--owner-approval",
        "none",
      ],
      { env: release.fixture.environment(null) },
    );
    expect(markdown.code).toBe(4);
    expect(markdown.stdout).toContain("## Normal release `v0.0.7`: refused");
    expect(markdown.stdout).toContain("| main | refused |");
    expect(markdown.stdout).toContain("| dispatch | not checked |");
    expect(markdown.stdout).toContain("| Authorization | standing |");
    // The ticket prints as inline code, so it reads as itself rather than as a Markdown heading.
    expect(markdown.stdout).toContain(["| Ticket | ", TICKET, " |"].join("`"));
    expect(markdown.stdout).toContain("- main · `main_moved` (refusal): ");
    expect(markdown.stdout).not.toContain("### The Owner's approval");
    expect(markdown.stdout).not.toContain("### Final release notes");
  });

  it("requires every final-merge CI gate of the exact commit: failed, skipped, unfinished and missing runs hold the release", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();
    const ci = state.github.runs.get(evidence.ciRun)!;
    const passing = ci.attempts;

    const evaluateWith = async (attempts: typeof passing) => {
      ci.attempts = attempts;
      return release.evaluate(evidence.request, { dispatch: run });
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
    ci.attempts = passing;
    ci.event = "pull_request";
    const missing = await release.evaluate(evidence.request, { dispatch: run });
    expect(missing.code).toBe(3);
    expect(release.unsatisfied(missing.json)).toEqual(["ci:ci_run_missing"]);
    ci.event = "push";

    // A failed attempt retried on the same run satisfies the gate, and the failure stays on record.
    const retried = await evaluateWith([...withJob(job(E2E_GATE, "failure")), passing[0]]);
    expect(retried.code, retried.stderr).toBe(0);
    expect(retried.json.ci!.satisfiedBy).toMatchObject({ runId: evidence.ciRun, attempt: 2 });
    const published = await release.publish(retried.json, run);
    expect(published.json.decision).toBe("published");
    const annotation = state.repo.git("cat-file", "tag", "v0.0.7");
    expect(annotation).toContain(`- run ${evidence.ciRun} attempt 1: failure (${E2E_GATE} failure)`);
    expect(annotation).toContain(`- accepted flaky retry in run ${evidence.ciRun}: ${E2E_GATE} failure in attempt 1, success in attempt 2`);
    expect(annotation).toContain("CI-Attempt: 2");
    expect(state.repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);
  });

  it("refuses a release whose commit carries no usable release-evidence policy", async () => {
    const { evidence, run } = await release.validRelease({ history: { policy: null } });
    const missing = await release.evaluate(evidence.request, { dispatch: run });
    expect(missing.code).toBe(4);
    expect(release.gate(missing.json, "policy").reasons.map((r) => r.code)).toEqual(["release_policy_missing"]);
    for (const gate of ["dispatch", "deployment", "review", "production-acceptance", "owner-approval"]) {
      expect(release.gate(missing.json, gate).state, gate).toBe("not_checked");
    }

    // A policy that is present but unusable. Each is committed directly on main, which history also holds
    // for a decision; the policy is refused all the same.
    for (const text of [
      "not json",
      policyText({ extra: { schema: 1 } }),
      policyText({ extra: { repository: "someone/else" } }),
      policyText({ extra: { owner: { login: "freeventures-tz" } } }),
      policyText({ extra: { evidence: { author: "owner" } } }),
      policyText({ attestations: { "hosted-migration": { agent: "ChatGPT", role: "independent-review" } } }),
      policyText({ attestations: { "production-acceptance": { agent: "Nobody", role: "production-acceptance" } } }),
      policyText({ extra: { authorization: { "standing-normal-below": "one" } } }),
      policyText({ extra: { authorization: {} } }),
      policyText({ extra: { vercel: { creator: VERCEL, environment: "Production", project: "Free OMS", team: "freeventures-tz" } } }),
    ]) {
      state.repo.commitFile("scripts/release/release-evidence-policy.json", text, "chore: change the policy");
      const commit = state.repo.head();
      const attempt = await release.evaluate({ ...evidence.request, sha: commit }, { dispatch: run });
      expect(release.gate(attempt.json, "policy").reasons.map((r) => r.code), text.slice(0, 60)).toEqual(["release_policy_invalid"]);
    }
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a hosted-migration record on a release whose migration tree never changed", async () => {
    release.history();
    const prepared = await release.prepareAndMerge();
    const evidence = release.evidence(prepared);
    const run = release.automaticRun(prepared.mergeSha);
    // The tree is unchanged here, so naming a hosted record at all is wrong.
    const hosted = release.comment(prepared.pr, OWNER, release.hostedBody(prepared), TIMES.hosted);
    const acceptance = release.comment(
      prepared.pr,
      OWNER,
      release.acceptanceBody(prepared, {
        deployment: evidence.deployment,
        review: evidence.review.reference,
        hostedMigration: hosted.reference,
      }),
      TIMES.accepted,
    );
    const attempt = await release.evaluate(
      { ...evidence.request, hostedMigration: hosted.reference, productionAcceptance: acceptance.reference },
      { dispatch: run },
    );
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toEqual([
      "schema-boundary:hosted_migration_record_unexpected",
      "hosted-migration:not_checked",
    ]);
    expect(state.github.writes()).toEqual([]);
  });
});
