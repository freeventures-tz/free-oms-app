// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE,
  INTRUDER,
  OWNER,
  recordBody,
  TICKET,
  TIMES,
  useReleaseFixture,
} from "./support/release-harness";

/**
 * The automatic route: a release below the policy's stable version, authorised in advance by the Owner and
 * started by the Owner's own production-acceptance comment.
 *
 * The comment is the request. The controller is given its id and the pull request the event claimed, and
 * reads everything else from the API: the body, the author, the location. Nothing an event asserts reaches a
 * decision, and a record that is merely well formed satisfies nothing.
 */
describe("evaluate-standing-release: the Owner's acceptance is the request", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  it("derives the release from the acceptance record and publishes exactly one annotated tag", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();

    const plan = await release.standingEvaluate(evidence.acceptance, { dispatch: run });
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.json.decision).toBe("eligible");
    expect(plan.json.mode).toBe("standing");
    expect(plan.json.acceptanceComment).toBe(evidence.acceptance.id);
    // Everything the request names came out of the record, not out of the invocation.
    expect(plan.json.request).toMatchObject({
      mode: "standing",
      ticket: TICKET,
      sha: prepared.mergeSha,
      version: prepared.version,
      preparationPr: prepared.pr,
      deployment: evidence.deployment,
      review: evidence.review.reference,
      productionAcceptance: evidence.acceptance.reference,
      ownerApproval: "none",
      hostedMigration: "none",
    });
    // No approval record is read, because none exists: the Owner authorised this class of release in advance.
    expect(release.gate(plan.json, "owner-approval").state).toBe("satisfied");
    expect(plan.json.records.ownerApproval).toBeNull();
    expect(plan.json.approvalTemplate).toBeNull();

    const published = await release.publish(plan.json, run);
    expect(published.code, published.stderr).toBe(0);
    expect(published.json.decision).toBe("published");
    expect(state.repo.git("rev-parse", "v0.0.7^{commit}")).toBe(prepared.mergeSha);

    const annotation = state.repo.git("cat-file", "tag", "v0.0.7");
    expect(annotation).toContain("Release-Authorization: standing");
    expect(annotation).toContain(`Release-Ticket: ${TICKET}`);
    expect(annotation).toContain(`Production-Acceptance-Record: ${evidence.acceptance.reference}`);
    expect(annotation).toContain(`Review-Record: ${evidence.review.reference}`);
    expect(annotation).toContain("Owner-Approval-Record: none");
    expect(annotation).toContain("Hosted-Migration-Record: none");
    expect(annotation).toContain("Dispatch-Workflow: .github/workflows/release-normal-tag-automatic.yml");
    expect(annotation).toContain(`Dispatch-Run: ${run.runId} ${run.attempt}`);
    expect(annotation).toContain(`Owner: ${OWNER.login} ${OWNER.id}`);

    // Exactly one tag object and one reference, and nothing else was written.
    expect(state.github.writes().filter((write) => write.method === "POST").length).toBe(2);
  });

  it("writes nothing when publication is not activated, and nothing at all while only evaluating", async () => {
    const { evidence, run } = await release.validRelease();
    const plan = await release.standingEvaluate(evidence.acceptance, { dispatch: run });
    expect(plan.json.decision).toBe("eligible");
    expect(state.github.writes()).toEqual([]);

    const off = await release.publish(plan.json, run, { activation: null });
    expect(off.code).toBe(6);
    expect(off.json.decision).toBe("publication_disabled");
    const disabled = await release.publish(plan.json, run, { activation: "Enabled" });
    expect(disabled.code).toBe(6);
    expect(state.github.writes()).toEqual([]);
    expect(() => state.repo.git("rev-parse", "v0.0.7")).toThrow();
  });

  it("reads the record GitHub serves, not what the event said about it", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();

    // The event claims the comment is on another pull request. GitHub says otherwise, and the API wins:
    // the release stops rather than following the event to a preparation the Owner did not accept.
    const lied = await release.standingEvaluate(evidence.acceptance, { dispatch: run, eventPullRequest: 42 });
    expect(lied.code).toBe(4);
    expect(lied.json.decision).toBe("refused");
    expect(lied.json.reasons.map((r) => r.code)).toEqual(["standing_event_mismatch"]);
    expect(lied.json.request).toBeNull();

    // With no claim at all the API is still the only source, and the same release is derived.
    const silent = await release.standingEvaluate(evidence.acceptance, { dispatch: run, eventPullRequest: null });
    expect(silent.json.decision).toBe("eligible");
    expect(silent.json.request).toMatchObject({ sha: prepared.mergeSha, preparationPr: prepared.pr });
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses an acceptance that is not the Owner's, however well formed it is", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();
    const body = release.acceptanceBody(prepared, { deployment: evidence.deployment, review: evidence.review.reference });

    for (const user of [INTRUDER, { login: "freeventures-tz", id: 1 }, { login: "FREEVENTURES-TZ", id: OWNER.id }]) {
      const forged = release.comment(prepared.pr, user, body, TIMES.accepted);
      const attempt = await release.standingEvaluate(forged, { dispatch: run });
      expect(attempt.code, user.login).toBe(4);
      expect(release.unsatisfied(attempt.json), user.login).toContain("production-acceptance:evidence_wrong_issuer");
      // A refused evaluation is never eligible, so the writer is never reached.
      expect(attempt.json.decision).toBe("refused");
    }
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses an acceptance that attests the wrong agent, role or ticket", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();
    const refs = { deployment: evidence.deployment, review: evidence.review.reference };
    const post = (overrides: Record<string, string | number>) =>
      release.comment(prepared.pr, OWNER, release.acceptanceBody(prepared, refs, overrides), TIMES.accepted);

    // The agent and the role are checked at the gate, against the attestation the policy names for this kind.
    // Claude Code implements; it does not verify its own work, and saying so in the block does not make it so.
    for (const [code, overrides] of [
      ["evidence_agent_mismatch", { agent: CLAUDE_CODE }],
      ["evidence_agent_mismatch", { agent: "Some Other Model" }],
      ["evidence_role_mismatch", { role: "independent-review" }],
    ] as Array<[string, Record<string, string | number>]>) {
      const attempt = await release.standingEvaluate(post(overrides), { dispatch: run });
      expect(attempt.code, code).toBe(4);
      expect(release.unsatisfied(attempt.json), code).toContain(`production-acceptance:${code}`);
    }

    // A ticket that is not #<number> stops earlier still: no release can be derived from it at all, so the
    // automatic route refuses before any gate is checked.
    for (const ticket of ["36", "#0", "#", "#36 and #40"]) {
      const attempt = await release.standingEvaluate(post({ ticket }), { dispatch: run });
      expect(attempt.code, ticket).toBe(4);
      expect(attempt.json.reasons.map((r) => r.code), ticket).toEqual(["standing_request_underived"]);
      expect(attempt.json.request, ticket).toBeNull();
    }

    // A block with no attestation at all is not a schema-2 record.
    const bare = release.comment(
      prepared.pr,
      OWNER,
      recordBody("production-acceptance", {
        "pull-request": prepared.pr,
        version: prepared.version,
        commit: prepared.mergeSha,
        deployment: evidence.deployment,
        review: evidence.review.reference,
        "hosted-migration": "none",
        verdict: "ACCEPTED",
      }),
      TIMES.accepted,
    );
    const missing = await release.standingEvaluate(bare, { dispatch: run });
    expect(missing.code).toBe(4);
    expect(missing.json.reasons.map((r) => r.code)).toEqual(["standing_request_underived"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses an acceptance whose own references are missing, ambiguous or another release's", async () => {
    const { history, release: prepared, evidence, run } = await release.validRelease();
    const refs = { deployment: evidence.deployment, review: evidence.review.reference };
    const post = (overrides: Record<string, string | number>) =>
      release.comment(prepared.pr, OWNER, release.acceptanceBody(prepared, refs, overrides), TIMES.accepted);

    // A second, older READY for the same head, replayed in place of the one this release names.
    const replayed = release.comment(prepared.pr, OWNER, release.reviewBody(prepared), "2026-09-13T08:10:00Z");
    // Its review names a comment that is not a review at all.
    const notAReview = release.comment(prepared.pr, OWNER, release.hostedBody(prepared), TIMES.hosted);

    // The acceptance's own references become the request, so they cannot disagree with it. What stands between
    // a bad reference and a tag is that every record it names is then read and checked in full.
    const cases: Array<[string[], ReturnType<typeof post>]> = [
      [["review:evidence_block_invalid"], post({ review: notAReview.reference })],
      [["review:evidence_record_missing"], post({ review: `comment:5799999999@sha256:${"a".repeat(64)}` })],
      [["version:version_mismatch", "review:evidence_field_mismatch"], post({ version: "0.0.8" })],
    ];
    for (const [codes, acceptance] of cases) {
      const attempt = await release.standingEvaluate(acceptance, { dispatch: run });
      expect(attempt.code, codes.join()).toBe(4);
      expect(release.unsatisfied(attempt.json), codes.join()).toEqual(expect.arrayContaining(codes));
    }

    // An acceptance that names a preparation it is not sitting on is ambiguous about which release it accepts,
    // so no release is derived from it: the comment's own location cannot be argued with, and the block can.
    const elsewherePr = await release.standingEvaluate(post({ "pull-request": 42 }), { dispatch: run });
    expect(elsewherePr.code).toBe(4);
    expect(elsewherePr.json.reasons.map((r) => r.code)).toEqual(["evidence_wrong_location"]);
    expect(elsewherePr.json.request).toBeNull();

    // A replayed READY is a valid record for the same head, so naming it publishes the same release. The
    // digest in the reference is what stops a different body being substituted for the one that was read.
    const swapped = await release.standingEvaluate(post({ review: replayed.reference }), { dispatch: run });
    expect(swapped.json.decision).toBe("eligible");
    expect(swapped.json.request!.review).toBe(replayed.reference);
    const forged = post({ review: replayed.reference.replace(/[0-9a-f]{64}$/, "f".repeat(64)) });
    expect(release.unsatisfied((await release.standingEvaluate(forged, { dispatch: run })).json)).toContain(
      "review:evidence_digest_mismatch",
    );

    // An acceptance for another commit entirely.
    const elsewhere = await release.standingEvaluate(post({ commit: history.pr42.mergeSha }), { dispatch: run });
    expect(elsewhere.code).toBe(4);
    expect(release.unsatisfied(elsewhere.json)).toEqual(expect.arrayContaining(["preparation:preparation_pr_mismatch"]));
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a release whose records do not all name the same ticket", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();
    const otherReview = release.comment(prepared.pr, OWNER, release.reviewBody(prepared, { ticket: "#99" }), TIMES.review);
    const acceptance = release.comment(
      prepared.pr,
      OWNER,
      release.acceptanceBody(prepared, { deployment: evidence.deployment, review: otherReview.reference }),
      TIMES.accepted,
    );
    const attempt = await release.standingEvaluate(acceptance, { dispatch: run });
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toContain("review:evidence_ticket_mismatch");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a comment that carries no acceptance, or no comment at all", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();

    const prose = release.comment(prepared.pr, OWNER, "Looks good to me, ship it.", TIMES.accepted);
    const noBlock = await release.standingEvaluate(prose, { dispatch: run });
    expect(noBlock.code).toBe(4);
    expect(noBlock.json.reasons.map((r) => r.code)).toEqual(["evidence_block_invalid"]);

    // A review record is not an acceptance, whoever posted it.
    const wrongKind = await release.standingEvaluate(evidence.review, { dispatch: run });
    expect(wrongKind.json.reasons.map((r) => r.code)).toEqual(["evidence_block_invalid"]);

    const absent = await release.standingEvaluate(5_799_999_999, { dispatch: run });
    expect(absent.json.reasons.map((r) => r.code)).toEqual(["evidence_record_missing"]);

    // Hiding the block inside an HTML comment does not make a record GitHub never showed anyone.
    const hidden = release.comment(
      prepared.pr,
      OWNER,
      `Fine by me.\r\n<!--\r\n${release.acceptanceBody(prepared, { deployment: evidence.deployment, review: evidence.review.reference })}-->\r\n`,
      TIMES.accepted,
    );
    expect((await release.standingEvaluate(hidden, { dispatch: run })).json.reasons.map((r) => r.code)).toEqual(["evidence_block_invalid"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses an acceptance edited after it was posted, whichever digest is quoted", async () => {
    const { release: prepared, evidence, run } = await release.validRelease();
    const acceptance = release.comment(
      prepared.pr,
      OWNER,
      release.acceptanceBody(prepared, { deployment: evidence.deployment, review: evidence.review.reference }),
      TIMES.accepted,
    );
    // The automatic route takes the digest of the bytes GitHub is serving, so a mismatch cannot arise. What
    // catches an edit is GitHub's own record that the comment changed after it was written.
    release.editComment(
      acceptance.id,
      release.acceptanceBody(prepared, { deployment: evidence.deployment, review: evidence.review.reference }, { version: "0.0.8" }),
    );
    const attempt = await release.standingEvaluate(acceptance, { dispatch: run });
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toContain("production-acceptance:evidence_record_edited");
    expect(state.github.writes()).toEqual([]);
  });
});
