// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE } from "./support/build-harness";
import {
  CLAUDE_CODE,
  INTRUDER,
  OWNER,
  TICKET,
  TIMES,
  useReleaseFixture,
} from "./support/release-harness";

/**
 * The explicit route: `v1.0.0`, and any later stable version. Two separate things are required, and neither
 * substitutes for the other — the Owner's own approval record saying the stable contract is authorized, and
 * the Owner's own manual dispatch.
 *
 * The record says an agent relayed a direct Owner instruction. The controller cannot read the conversation
 * that instruction was given in and never claims the record proves it happened. What it does prove is that
 * the Owner's account posted the record and started the run: everything else in the block is bound to this
 * exact release, and an instruction quoted anywhere else carries no authority at all.
 */
describe("evaluate-release: a stable version needs the Owner's own approval and dispatch", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  it("publishes v1.0.0 with the Owner's approval and dispatch, and records the explicit authorization", async () => {
    const { release: prepared, evidence, dispatch } = await release.validRelease({ stableContract: true });
    expect(prepared.version).toBe("1.0.0");

    const plan = await release.evaluate(evidence.explicitRequest, { dispatch });
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.json.decision).toBe("eligible");
    expect(plan.json.mode).toBe("explicit");
    expect(plan.json.records.ownerApproval).toMatchObject({
      author: OWNER,
      agent: "ChatGPT",
      role: "owner-authorization-relay",
      ticket: TICKET,
      satisfied: true,
    });

    const published = await release.publish(plan.json, dispatch);
    expect(published.code, published.stderr).toBe(0);
    expect(published.json.decision).toBe("published");
    expect(state.repo.git("rev-parse", "v1.0.0^{commit}")).toBe(prepared.mergeSha);

    const annotation = state.repo.git("cat-file", "tag", "v1.0.0");
    expect(annotation).toContain("Release-Authorization: explicit");
    expect(annotation).toContain(`Owner-Approval-Record: ${evidence.approval.reference}`);
    expect(annotation).toContain("Dispatch-Workflow: .github/workflows/release-normal-tag.yml");
    expect(annotation).toContain(`Dispatch-Run: ${dispatch.runId} ${dispatch.attempt}`);
  });

  it("refuses v1.0.0 with no approval record at all, however complete the rest is", async () => {
    const { evidence, dispatch } = await release.validRelease({ stableContract: true });
    const bare = await release.evaluate({ ...evidence.request, ownerApproval: "none" }, { dispatch });
    expect(bare.code).toBe(4);
    expect(release.unsatisfied(bare.json)).toEqual(["owner-approval:owner_approval_record_required"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses an approval that does not authorize the stable contract, or that no Owner instruction backs", async () => {
    const { evidence, dispatch, release: prepared } = await release.validRelease({ stableContract: true });
    const refs = {
      deployment: evidence.deployment,
      review: evidence.review.reference,
      productionAcceptance: evidence.acceptance.reference,
    };
    const approve = (overrides: Record<string, string | number>, user = OWNER) =>
      release.comment(prepared.pr, user, release.approvalBody(prepared, refs, overrides), TIMES.approved).reference;

    const cases: Array<[string, string]> = [
      // The stable contract is the whole decision; a block that leaves it unauthorized authorises nothing.
      ["evidence_field_mismatch", approve({ "stable-contract": "pending" })],
      ["evidence_field_mismatch", approve({ "stable-contract": "not-required" })],
      // The authority is the Owner's direct instruction. A record that cites anything else is refused.
      ["evidence_field_mismatch", approve({ authorization: "standing-authorization" })],
      ["evidence_field_mismatch", approve({ authorization: "quoted-in-review" })],
      // The agent relays; it does not decide. A role that claims otherwise is not the relay role.
      ["evidence_role_mismatch", approve({ role: "release-authority" })],
      ["evidence_role_mismatch", approve({ role: "production-acceptance" })],
      ["evidence_ticket_mismatch", approve({ ticket: "#99" })],
      // Only the Owner's account can authorise; an agent cannot post this record as itself.
      ["evidence_wrong_issuer", approve({}, INTRUDER)],
      ["evidence_wrong_issuer", approve({}, { login: "freeventures-tz", id: 1 })],
    ];
    for (const [code, ownerApproval] of cases) {
      const run = await release.evaluate({ ...evidence.request, ownerApproval }, { dispatch });
      expect(run.code, code).toBe(4);
      expect(release.unsatisfied(run.json), code).toEqual([`owner-approval:${code}`]);
    }

    // Either agent may relay the Owner's instruction, so Claude Code's own relay is accepted as a relay.
    const byClaude = await release.evaluate({ ...evidence.request, ownerApproval: approve({ agent: CLAUDE_CODE }) }, { dispatch });
    expect(byClaude.code, byClaude.stderr).toBe(0);
    expect(byClaude.json.records.ownerApproval).toMatchObject({ agent: CLAUDE_CODE, role: "owner-authorization-relay" });
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a stable release started through the automatic route, with or without the approval", async () => {
    const { evidence, run } = await release.validRelease({ stableContract: true });

    // The acceptance comment is valid, and the run it started is of the standing workflow. A stable version
    // does not publish through that workflow, so its dispatch is not a dispatch of this release.
    const automatic = await release.standingEvaluate(evidence.acceptance, { dispatch: run });
    expect(automatic.code).toBe(4);
    expect(release.unsatisfied(automatic.json)).toEqual(
      expect.arrayContaining(["dispatch:dispatch_run_invalid", "owner-approval:owner_approval_record_required"]),
    );
    expect(automatic.json.mode).toBe("explicit");

    // Even with the Owner's approval named, the automatic run still cannot carry it: the route is wrong.
    const plan = await release.evaluate(evidence.explicitRequest, { dispatch: run });
    expect(plan.code).toBe(4);
    expect(release.unsatisfied(plan.json)).toEqual(["dispatch:dispatch_run_invalid"]);
    expect(plan.json.reasons[0].detail).toContain("not the Owner's explicit dispatch");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses a release below the stable version dispatched by hand, approval or not", async () => {
    const { evidence, dispatch, release: prepared } = await release.validRelease();
    expect(prepared.version).toBe("0.0.7");

    // The manual workflow's run is not the workflow a 0.x release publishes through.
    const manual = await release.evaluate(evidence.request, { dispatch });
    expect(manual.code).toBe(4);
    expect(release.unsatisfied(manual.json)).toEqual(["dispatch:dispatch_run_invalid"]);
    expect(manual.json.mode).toBe("standing");
    expect(manual.json.reasons[0].detail).toContain("not the Owner's standing dispatch");

    // Adding the Owner's own approval to a standing release does not make the manual route available; it is
    // an extra record no gate read, and a tag beside it would look approved when nothing checked it.
    const approved = await release.evaluate(evidence.explicitRequest, { dispatch });
    expect(release.unsatisfied(approved.json)).toEqual([
      "dispatch:dispatch_run_invalid",
      "owner-approval:owner_approval_record_unexpected",
    ]);
    expect(state.github.writes()).toEqual([]);
  });

  it("shares one writer with build tags, and reconciles a late build after a stable release", async () => {
    const build = release.fixture;
    const { pr32, pr33, pr42 } = release.history();
    // #32's final-merge CI failed; the others passed.
    const run32 = build.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    build.ci(pr33.mergeSha);
    build.ci(pr42.mergeSha);
    const prepared = await release.prepareAndMerge({ stableContract: true });
    expect(prepared.version).toBe("1.0.0");
    const evidence = release.evidence(prepared);

    // Build tags name the version the accepted changes calculate, which is 0.0.7. They know nothing of the
    // Owner's stable-contract decision, and they should not: a build tag marks a build toward the version
    // the history implies, and `1.0.0` is a decision no history implies.
    const before = await build.workflowRun({ sha: prepared.mergeSha, runId: evidence.ciRun });
    expect(before.publication!.json.commits.map((c) => [c.pr, c.tag?.name])).toEqual([
      [33, "v0.0.7-dev.1"],
      [42, "v0.0.7-dev.2"],
      [43, "v0.0.7-dev.3"],
    ]);
    const buildTagsBefore = build.remoteTags();

    // The stable release goes through the same writer, and moves none of them.
    const dispatch = release.dispatch(prepared.mergeSha);
    const normal = await release.workflowRun(evidence.explicitRequest, dispatch);
    expect(normal.publication!.code, normal.publication!.stderr).toBe(0);
    expect(normal.publication!.json.decision).toBe("published");
    expect(build.remoteTags().split("\n").filter((line) => !line.startsWith("v1.0.0 "))).toEqual(buildTagsBefore.split("\n"));
    expect(build.tagsOn(prepared.mergeSha).sort()).toEqual(["v0.0.7-dev.3", "v1.0.0"]);

    // #32 passes on a retry after 1.0.0 shipped. Its build tag still comes from its own ancestral release.
    build.retry(run32);
    const late = await build.workflowRun(null);
    expect(late.publication!.json.commits.map((c) => [c.pr, c.tag?.name])).toEqual([[32, "v0.0.7-dev.4"]]);
    expect(state.repo.git("cat-file", "tag", "v0.0.7-dev.4")).toContain("Release-Base: v0.0.6 ");
  });

  it("does not mistake a tag written under the old provenance for this release", async () => {
    const { evidence, dispatch, release: prepared } = await release.validRelease({ stableContract: true });
    // Everything a schema-1 annotation carried, with none of what schema 2 added. It names the right commit
    // and the right version, and it is still not a tag this controller wrote.
    const plan = (await release.evaluate(evidence.explicitRequest, { dispatch })).json;
    const old = [
      `Release v1.0.0 of freeventures-tz/free-oms-app`,
      "",
      "Release-Controller-Schema: 1",
      "Release-Kind: normal",
      `Repository: freeventures-tz/free-oms-app`,
      `Commit: ${prepared.mergeSha}`,
      "Version: 1.0.0",
      "Classification: patch",
      `Release-Base: v0.0.6 ${plan.release!.base.tagObject} ${plan.release!.base.commit}`,
      `Notes-Digest: ${plan.release!.notesDigest}`,
      "Preparation-PR: 43",
      `Reviewed-Head: ${prepared.reviewedHead}`,
      "Release-Date: 2026-09-20",
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
      "",
    ].join("\n");
    state.repo.tag("v1.0.0", prepared.mergeSha, old);
    const attempt = await release.evaluate(evidence.explicitRequest, { dispatch });
    expect(attempt.code).toBe(4);
    expect(release.unsatisfied(attempt.json)).toEqual(["version:normal_tag_conflict"]);
    // It is refused for carrying no complete provenance of this schema, not for a field that happens to differ.
    expect(attempt.json.reasons[0].detail).toContain("carries no complete release provenance");
    expect(state.github.writes()).toEqual([]);
  });

  it("refuses 1.0.0 when the preparation was not prepared as the stable release", async () => {
    // A 0.0.7 preparation asked to publish as 1.0.0. Asking is not the gate: what refuses is the merged
    // commit itself, whose package version, changelog and title all say 0.0.7. A stable release is a
    // reviewed preparation made for it, not a version named at dispatch time over one that was not.
    const { evidence, dispatch } = await release.validRelease();
    const run = await release.evaluate({ ...evidence.explicitRequest, version: "1.0.0" }, { dispatch });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual(
      expect.arrayContaining([
        "preparation:preparation_title_mismatch",
        "preparation:prepared_version_stale",
        "preparation:prepared_changelog_mismatch",
      ]),
    );
    // Every record names 0.0.7 too, so none of them vouches for the release that was asked for.
    expect(release.unsatisfied(run.json)).toEqual(expect.arrayContaining(["review:evidence_field_mismatch"]));
    expect(state.github.writes()).toEqual([]);
  });
});
