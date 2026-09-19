// @vitest-environment node
import { describe, expect, it } from "vitest";

import { E2E_GATE } from "./support/build-harness";
import {
  INTRUDER,
  MIGRATOR,
  MIGRATIONS,
  OWNER,
  TICKET,
  policyText,
  recordBody,
  TIMES,
  useReleaseFixture,
  type PreparedRelease,
} from "./support/release-harness";

/**
 * A normal release across its boundaries: the schema boundary a release crosses or does not, the build tags
 * published beside it through the same writer, build tags that arrive after it, and the releases after it.
 */
describe("normal releases: schema boundaries, build tags and later releases", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  /** Fresh evidence for a release, with a hosted migration record the Owner's approval names. */
  const withHostedRecord = (prepared: PreparedRelease, hosted: string) => release.evidence(prepared, { hostedMigration: hosted });
  const hostedBody = (boundary: string, overrides: Record<string, string> = {}) =>
    recordBody("hosted-migration", {
      agent: "ChatGPT",
      role: "hosted-migration",
      ticket: TICKET,
      "schema-boundary": boundary,
      "migration-first": "applied-before-merge",
      "hosted-preservation": "verified",
      ...overrides,
    });

  it("proves an unchanged migration tree from Git, and refuses a hosted record that does not belong", async () => {
    const { release: prepared, evidence, run: dispatch } = await release.validRelease();
    const unchanged = await release.evaluate(evidence.request, { dispatch });
    expect(unchanged.json.schemaBoundary).toMatchObject({ state: "unchanged", changedBy: [] });
    expect(unchanged.json.schemaBoundary!.before).toBe(state.repo.git("rev-parse", `v0.0.6^{commit}:${MIGRATIONS}`));
    expect(unchanged.json.schemaBoundary!.after).toBe(unchanged.json.schemaBoundary!.before);
    expect(release.gate(unchanged.json, "hosted-migration").state).toBe("not_required");

    const stray = release.comment(prepared.pr, OWNER, hostedBody(prepared.boundary), TIMES.hosted);
    const withStray = withHostedRecord(prepared, stray.reference);
    const run = await release.evaluate(withStray.request, { dispatch });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual(["schema-boundary:hosted_migration_record_unexpected", "hosted-migration:not_checked"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("proves a history with no migrations at all as an unchanged, absent boundary", async () => {
    const { release: prepared, evidence, run: dispatch } = await release.validRelease({ history: { migrations: false } });
    expect(prepared.boundary).toBe("unchanged absent");
    const run = await release.evaluate(evidence.request, { dispatch });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json.schemaBoundary).toMatchObject({ state: "unchanged", before: null, after: null, value: "unchanged absent" });
  });

  it("requires hosted migration evidence, issued before the migration merged, when the migration tree changed", async () => {
    const { repo, github } = state;
    release.history();
    const migration = release.mergeFiles(44, "fix(db): index invoices by customer", {
      [`${MIGRATIONS}/20260915000000_invoice_index.sql`]: "create index invoices_customer on invoices (customer_id);\n",
    });
    const prepared = await release.prepareAndMerge();
    expect(prepared.boundary).toMatch(/^changed [0-9a-f]{40} [0-9a-f]{40}$/);

    // No record: refused, naming the merge that changed the tree.
    const bare = release.evidence(prepared);
    const dispatch = release.automaticRun(prepared.mergeSha);
    const withoutRecord = await release.evaluate(bare.request, { dispatch });
    expect(withoutRecord.code).toBe(4);
    expect(release.unsatisfied(withoutRecord.json)).toEqual(["schema-boundary:hosted_migration_record_required", "hosted-migration:not_checked"]);
    expect(withoutRecord.json.schemaBoundary).toMatchObject({ state: "changed", changedBy: [44] });
    expect(withoutRecord.json.reasons[0].detail).toContain("#44");

    const hosted = (user = OWNER, body = hostedBody(prepared.boundary), time = TIMES.hosted, issue = 44) =>
      release.comment(issue, user, body, time).reference;
    const cases: Array<[string, string]> = [
      ["evidence_out_of_order", hosted(OWNER, hostedBody(prepared.boundary), "2026-09-13T09:30:00Z")],
      ["evidence_out_of_order", hosted(OWNER, hostedBody(prepared.boundary), TIMES.merged)],
      ["evidence_wrong_issuer", hosted(INTRUDER)],
      ["evidence_wrong_issuer", hosted(MIGRATOR)],
      ["evidence_agent_mismatch", hosted(OWNER, hostedBody(prepared.boundary, { agent: "Claude Code" }))],
      ["evidence_role_mismatch", hosted(OWNER, hostedBody(prepared.boundary, { role: "production-acceptance" }))],
      ["evidence_ticket_mismatch", hosted(OWNER, hostedBody(prepared.boundary, { ticket: "#40" }))],
      ["evidence_field_mismatch", hosted(OWNER, hostedBody(`changed ${"1".repeat(40)} ${"2".repeat(40)}`))],
      ["evidence_field_mismatch", hosted(OWNER, hostedBody(prepared.boundary, { "hosted-preservation": "skipped" }))],
      ["evidence_field_mismatch", hosted(OWNER, hostedBody(prepared.boundary, { "migration-first": "applied-after-merge" }))],
    ];
    for (const [code, reference] of cases) {
      const run = await release.evaluate(withHostedRecord(prepared, reference).request, { dispatch });
      expect(run.code, code).toBe(4);
      expect(release.unsatisfied(run.json), code).toEqual([`hosted-migration:${code}`]);
    }

    // The Owner's record, attesting ChatGPT, made before #44 merged, on #44 itself: the release publishes.
    const good = hosted();
    const evidence = withHostedRecord(prepared, good);
    const plan = await release.evaluate(evidence.request, { dispatch });
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.json.records.hostedMigration).toMatchObject({ author: OWNER, agent: "ChatGPT", issue: 44, satisfied: true });
    const published = await release.publish(plan.json, dispatch);
    expect(published.json.decision).toBe("published");
    const annotation = repo.git("cat-file", "tag", "v0.0.7").split("\n");
    expect(annotation).toContain(`Schema-Boundary: ${prepared.boundary}`);
    expect(annotation).toContain(`Hosted-Migration-Record: ${good}`);
    expect(annotation).toContain(`- #44 ${migration.mergeSha} fix patch`);
    expect(github.writes()).toHaveLength(2);
  });

  it("refuses a changed migration tree when the policy attests no agent for hosted migrations", async () => {
    release.history({ policy: policyText({ attestations: { "hosted-migration": null } }) });
    release.mergeFiles(44, "fix(db): index invoices by customer", {
      [`${MIGRATIONS}/20260915000000_invoice_index.sql`]: "create index invoices_customer on invoices (customer_id);\n",
    });
    const prepared = await release.prepareAndMerge();
    const record = release.comment(44, OWNER, hostedBody(prepared.boundary), TIMES.hosted).reference;
    const evidence = withHostedRecord(prepared, record);
    const run = await release.evaluate(evidence.request, { dispatch: release.automaticRun(prepared.mergeSha) });
    expect(run.code).toBe(4);
    expect(release.unsatisfied(run.json)).toEqual(["hosted-migration:evidence_attestation_unconfigured"]);
    expect(state.github.writes()).toEqual([]);
  });

  it("shares one writer with build tags: build tags before and after the release, a late build from its own ancestral release, and the next patch", async () => {
    const { repo, github } = state;
    const build = release.fixture;
    const { pr32, pr33, pr42 } = release.history();
    // #32's final-merge CI failed; the others passed.
    const run32 = build.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    build.ci(pr33.mergeSha);
    build.ci(pr42.mergeSha);
    const prepared = await release.prepareAndMerge();
    const evidence = release.evidence(prepared);

    // The build-tag workflow runs for the preparation's CI completion: #33, #42 and #43 are tagged, #32 is blocked.
    const before = await build.workflowRun({ sha: prepared.mergeSha, runId: evidence.ciRun });
    expect(before.publication!.json.decision).toBe("published");
    expect(before.publication!.json.commits.map((c) => [c.pr, c.tag?.name])).toEqual([
      [33, "v0.0.7-dev.1"],
      [42, "v0.0.7-dev.2"],
      [43, "v0.0.7-dev.3"],
    ]);
    const buildTagsBefore = build.remoteTags();

    // The normal release is published at the preparation's merge through the same writer.
    const dispatch = release.automaticRun(prepared.mergeSha);
    const normal = await release.workflowRun(evidence.request, dispatch);
    expect(normal.publication!.code, normal.publication!.stderr).toBe(0);
    expect(normal.publication!.json.decision).toBe("published");
    expect(build.remoteTags().split("\n").filter((line) => !line.startsWith("v0.0.7 "))).toEqual(buildTagsBefore.split("\n"));
    expect(build.tagsOn(prepared.mergeSha).sort()).toEqual(["v0.0.7", "v0.0.7-dev.3"]);

    // Reconciliation after the release: the merges it contains are recorded from Git and CI, and #32 stays blocked.
    const after = await build.reconcile();
    expect(after.json.commits.map((c) => [c.pr, c.decision, c.recordedTag?.verification ?? null])).toEqual([
      [32, "failed", null],
      [33, "recorded", "git-and-ci"],
      [42, "recorded", "git-and-ci"],
      [43, "recorded", "git-and-ci"],
    ]);

    // #32 passes on a retry after v0.0.7 shipped. Its build tag comes from its own ancestral release, v0.0.6.
    build.retry(run32);
    const late = await build.workflowRun(null);
    expect(late.publication!.json.commits.map((c) => [c.pr, c.tag?.name])).toEqual([[32, "v0.0.7-dev.4"]]);
    const lateTag = repo.git("cat-file", "tag", "v0.0.7-dev.4");
    expect(lateTag).toContain("Release-Base: v0.0.6 ");
    expect(lateTag).toContain(`Commit: ${pr32.mergeSha}`);

    // The next fix is a patch from v0.0.7, and a normal release request for it cannot reuse v0.0.7's evidence.
    const pr44 = repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" });
    const ci44 = build.ci(pr44.mergeSha);
    const next = await build.workflowRun({ sha: pr44.mergeSha, runId: ci44 });
    expect(next.publication!.json.commits.map((c) => [c.pr, c.tag?.name])).toEqual([[44, "v0.0.8-dev.1"]]);
    const replay = await release.evaluate(
      { ...evidence.request, sha: pr44.mergeSha, version: "0.0.8" },
      { dispatch: release.automaticRun(pr44.mergeSha) },
    );
    expect(replay.code).toBe(4);
    expect(release.unsatisfied(replay.json)).toEqual(
      expect.arrayContaining([
        "preparation:preparation_pr_mismatch",
        "deployment:deployment_wrong_commit",
        "production-acceptance:evidence_field_mismatch",
      ]),
    );
    expect(replay.json.release).toMatchObject({ version: "0.0.8", base: { tag: "v0.0.7" } });
    expect(replay.json.release!.merges.map((m) => m.pr)).toEqual([44]);

    // Every tag created along the way kept its object; v0.0.6 was never touched.
    const final = build.remoteTags();
    for (const line of buildTagsBefore.split("\n")) expect(final.split("\n")).toContain(line);
    expect(github.writes().filter((w) => w.path.endsWith("/git/refs")).map((w) => (w.body as { ref: string }).ref)).toEqual([
      "refs/tags/v0.0.7-dev.1",
      "refs/tags/v0.0.7-dev.2",
      "refs/tags/v0.0.7-dev.3",
      "refs/tags/v0.0.7",
      "refs/tags/v0.0.7-dev.4",
      "refs/tags/v0.0.8-dev.1",
    ]);
  });

  it("publishes a build tag and the normal tag concurrently without either touching the other", async () => {
    const { github } = state;
    const build = release.fixture;
    const { pr32, pr33, pr42 } = release.history();
    for (const merge of [pr32, pr33, pr42]) build.ci(merge.mergeSha);
    const prepared = await release.prepareAndMerge();
    const evidence = release.evidence(prepared);
    const dispatch = release.automaticRun(prepared.mergeSha);
    const plan = await release.evaluate(evidence.request, { dispatch });
    const buildPlan = await build.reconcile();
    const normalPath = build.writePlan(plan.json);
    const buildPath = build.writePlan(buildPlan.json);
    state.checkout.sync();

    const [normal, tags] = await Promise.all([
      release.publish(null, dispatch, { planPath: normalPath, sync: false }),
      build.publishReconciled(null, { planPath: buildPath, sync: false }),
    ]);
    // Each writer compares its checkout's tags with GitHub's before it evaluates. Racing past the lock, one may
    // find the other's new tag missing from its checkout and stop, reporting what it confirmed; nothing else
    // is accepted here.
    const stale = (run: { code: number | null; stdout: string; stderr: string }) =>
      run.code === 1 && /tag_state_out_of_date/.test(`${run.stderr}${run.stdout}`);
    expect(normal.code === 0 ? normal.json.decision : stale(normal) ? "stale" : normal.stderr).toMatch(/^(published|stale)$/);
    expect(tags.code === 0 ? tags.json.decision : stale(tags) ? "stale" : tags.stdout + tags.stderr).toMatch(/^(published|stale)$/);
    expect([normal.code, tags.code]).toContain(0);

    // Whatever raced, the next runs converge. The older merges each hold one build tag, in merge order. The
    // preparation's merge holds the normal tag, and a build tag only if the build writer reached it before the
    // normal tag existed: a commit that already is a normal release is not owed one (`not_applicable`).
    await build.workflowRun(null);
    const again = await release.workflowRun(evidence.request, release.rerun(dispatch, OWNER));
    expect(["published", "already_published"]).toContain(again.publication?.json.decision ?? again.plan.json.decision);
    const onPreparation = build.tagsOn(prepared.mergeSha).sort();
    expect([["v0.0.7"], ["v0.0.7", "v0.0.7-dev.4"]]).toContainEqual(onPreparation);
    for (const [merge, tag] of [[pr32, "v0.0.7-dev.1"], [pr33, "v0.0.7-dev.2"], [pr42, "v0.0.7-dev.3"]] as const) {
      expect(build.tagsOn(merge.mergeSha)).toEqual([tag]);
    }
    const refs = github.writes().filter((w) => w.path.endsWith("/git/refs"));
    expect(new Set(refs.map((w) => (w.body as { ref: string }).ref)).size).toBe(onPreparation.length + 3);
    const settled = await build.reconcile();
    expect(settled.json.counts).toMatchObject({ eligible: 0, blocked: 0 });
    expect(settled.json.commits.find((c) => c.sha === prepared.mergeSha)!.decision).toBe(
      onPreparation.length === 2 ? "recorded" : "not_applicable",
    );
  });

  it("refuses 0.0.7 once a feature has raised the target to 0.1.0, and publishes 0.1.0", async () => {
    const { repo } = state;
    release.history();
    repo.mergePullRequest({ number: 44, title: "feat(reports): add the daily sales report" });
    const prepared = await release.prepareAndMerge({ version: "0.1.0", branch: "release/v0.1.0" });
    const evidence = release.evidence(prepared);
    const dispatch = release.automaticRun(prepared.mergeSha);

    const patch = await release.evaluate({ ...evidence.request, version: "0.0.7" }, { dispatch });
    expect(patch.code).toBe(4);
    expect(release.unsatisfied(patch.json)[0]).toBe("version:version_mismatch");
    expect(patch.json.reasons[0].detail).toContain("calculate 0.1.0");

    const minor = await release.workflowRun(evidence.request, dispatch);
    expect(minor.plan.json.release).toMatchObject({ version: "0.1.0", highestChange: "minor" });
    expect(minor.publication!.json.decision).toBe("published");
    expect(repo.git("cat-file", "tag", "v0.1.0")).toContain("Classification: minor");
  });
});
