// @vitest-environment node
import { existsSync } from "node:fs";

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
} from "./support/build-harness";
import type { Fault } from "./support/github-simulator";

/**
 * Publishing a build tag through `publish-build`, into a real disposable repository behind a simulated
 * GitHub. Tag objects and references are real Git objects, so annotation, peeling and immutability are
 * checked with Git itself, and every write the controller sent is on the simulator's record.
 */
describe("publish-build: an immutable build tag for an exact merge", { timeout: 300_000 }, () => {
  const fixture = useBuildFixture();
  const { state } = fixture;
  const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code);
  const tagsOn = (sha: string) => state.repo.git("tag", "--points-at", sha).split("\n").filter(Boolean);

  it("writes nothing unless RELEASE_BUILD_PUBLICATION is exactly `enabled`", async () => {
    const { github } = state;
    const { pr33 } = fixture.releasedHistory();
    const evaluation = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));
    const planPath = fixture.writePlan(evaluation.json);
    const tagsBefore = fixture.remoteTags();

    for (const activation of [null, "", "true", "1", "yes", "Enabled", "ENABLED", " enabled", "enabled "]) {
      const { code, json } = await fixture.publish(null, { activation, planPath });
      expect(code, JSON.stringify(activation)).toBe(6);
      expect(json).toMatchObject({
        command: "publish-build",
        decision: "publication_disabled",
        publication: "none",
        status: null,
        tag: { name: "v0.0.7-dev.1", provisional: true },
      });
    }
    expect(github.writes()).toEqual([]);
    expect(fixture.remoteTags()).toBe(tagsBefore);
  });

  it("creates one annotated tag of the exact merge, reads it back, and changes nothing else", async () => {
    const { repo, github, checkout } = state;
    const { released, pr32, pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    const tagsBefore = fixture.remoteTags();
    const branchesBefore = repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
    const requestsBefore = github.requests.length;

    const { code, json, stderr } = await fixture.publish(evaluation.json);

    expect(code, stderr).toBe(0);
    expect(json).toMatchObject({
      command: "publish-build",
      decision: "tagged",
      publication: "created",
      tag: { name: "v0.0.7-dev.1", ordinal: 1, provisional: false, commit: pr33.mergeSha },
      status: { context: "release/build-tag", state: "success", description: "Build tag v0.0.7-dev.1" },
      reasons: [],
    });

    // Exactly two writes — the tag object, then a reference to it — each read back before success.
    const writes = github.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `POST /repos/${REPOSITORY}/git/tags`,
      `POST /repos/${REPOSITORY}/git/refs`,
    ]);
    expect(writes[0].body).toMatchObject({ tag: "v0.0.7-dev.1", object: pr33.mergeSha, type: "commit" });
    expect(writes[1].body).toEqual({ ref: "refs/tags/v0.0.7-dev.1", sha: json.tag!.object });
    const sequence = github.requests.slice(requestsBefore).map((r) => `${r.method} ${r.path}`);
    expect(sequence.slice(sequence.indexOf(`POST /repos/${REPOSITORY}/git/refs`) + 1)).toEqual([
      `GET /repos/${REPOSITORY}/git/ref/tags/v0.0.7-dev.1`,
      `GET /repos/${REPOSITORY}/git/tags/${json.tag!.object}`,
    ]);
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

    // A real annotated tag object that peels to the exact merge and carries its provenance.
    expect(repo.git("cat-file", "-t", "v0.0.7-dev.1")).toBe("tag");
    expect(repo.git("rev-parse", "v0.0.7-dev.1")).toBe(json.tag!.object);
    expect(repo.git("rev-parse", "v0.0.7-dev.1^{commit}")).toBe(pr33.mergeSha);
    const raw = repo.git("cat-file", "tag", "v0.0.7-dev.1");
    expect(raw.startsWith(`object ${pr33.mergeSha}\ntype commit\ntag v0.0.7-dev.1\n`)).toBe(true);
    for (const line of [
      `Build v0.0.7-dev.1 of ${REPOSITORY}`,
      "Release-Controller-Schema: 1",
      `Repository: ${REPOSITORY}`,
      `Commit: ${pr33.mergeSha}`,
      "Target-Version: 0.0.7",
      "Classification: patch",
      `Release-Base: v0.0.6 ${evaluation.json.target!.base.tagObject} ${released.mergeSha}`,
      `Notes-Digest: ${evaluation.json.target!.notesDigest}`,
      "CI-Workflow: .github/workflows/ci.yml",
      `CI-Run: ${run}`,
      "CI-Attempt: 1",
      `- run ${run} attempt 1: success`,
      `- #32 ${pr32.mergeSha}`,
      `- #33 ${pr33.mergeSha}`,
    ]) {
      expect(raw.split("\n")).toContain(line);
    }
    expect(raw).not.toContain("set the yard");

    // Every other ref is as it was; no commit was made and no package version changed.
    const otherTags = fixture
      .remoteTags()
      .split("\n")
      .filter((line) => !line.startsWith("v0.0.7-dev.1 "))
      .join("\n");
    expect(otherTags).toBe(tagsBefore);
    expect(repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")).toBe(branchesBefore);
    expect(repo.git("rev-parse", "main")).toBe(pr33.mergeSha);
    expect(JSON.parse(repo.git("show", "main:package.json")).version).toBe("0.0.6");
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(checkout.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("treats a duplicate invocation, and a later event for the tagged commit, as already tagged, with no second write", async () => {
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const { evaluation, publication } = await fixture.tagBuild(pr33.mergeSha, run);
    expect(publication.code).toBe(0);
    const writes = state.github.writes().length;

    const again = await fixture.publish(evaluation.json);
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({
      decision: "already_tagged",
      publication: "none",
      tag: null,
      existingTag: { name: "v0.0.7-dev.1", object: publication.json.tag!.object, ciRun: String(run), ciAttempt: "1" },
      status: { state: "success", description: "Build tag v0.0.7-dev.1" },
    });

    // CI re-run on the tagged commit, even failing, does not make another tag or unmake this one.
    fixture.retry(run, { jobs: { [E2E_GATE]: "failure" } });
    const reevaluated = await fixture.evaluate(pr33.mergeSha, run);
    expect(reevaluated.code).toBe(0);
    expect(reevaluated.json).toMatchObject({ decision: "already_tagged", tag: null, existingTag: { name: "v0.0.7-dev.1" } });

    expect(state.github.writes()).toHaveLength(writes);
    expect(tagsOn(pr33.mergeSha)).toEqual(["v0.0.7-dev.1"]);
  });

  it("keeps a build tag verified after a normal release is published at the same commit", async () => {
    const { repo } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    expect((await fixture.tagBuild(pr33.mergeSha, run)).publication.code).toBe(0);
    repo.tag("v0.0.7", pr33.mergeSha, "v0.0.7\n\nThe normal release.");

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(0);
    expect(json).toMatchObject({
      decision: "already_tagged",
      releasedAs: ["v0.0.7"],
      existingTag: { name: "v0.0.7-dev.1" },
      target: { version: "0.0.7", base: { tag: "v0.0.6" } },
    });
  });

  it("publishes nothing when the reference is not created after the tag object, and a retry creates the tag once", async () => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    const tagsBefore = fixture.remoteTags();
    github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "before", status: 502 });

    const interrupted = await fixture.publish(evaluation.json);

    expect(interrupted.code).toBe(1);
    expect(interrupted.stdout).toBe("");
    expect(interrupted.stderr).toContain("tag_reference_unconfirmed");
    expect(fixture.remoteTags()).toBe(tagsBefore);
    const orphan = /tag object ([0-9a-f]{40})/.exec(interrupted.stderr)![1];
    expect(repo.git("cat-file", "-t", orphan)).toBe("tag");

    // The object exists but nothing names it, so it is not a publication: the commit is still eligible.
    const still = await fixture.evaluate(pr33.mergeSha, run);
    expect(still.json).toMatchObject({ decision: "eligible", tag: { name: "v0.0.7-dev.1" } });

    const retried = await fixture.publish(still.json);
    expect(retried.code).toBe(0);
    expect(retried.json).toMatchObject({ decision: "tagged", tag: { name: "v0.0.7-dev.1", commit: pr33.mergeSha } });
    expect(retried.json.tag!.object).not.toBe(orphan);
    expect(tagsOn(pr33.mergeSha)).toEqual(["v0.0.7-dev.1"]);
  });

  it.each<{ label: string; fault: Fault; code: string }>([
    {
      label: "the reference was created but the response was lost",
      fault: { method: "POST", path: /\/git\/refs$/, when: "after", status: 502 },
      code: "tag_reference_unconfirmed",
    },
    {
      label: "the new tag could not be read back",
      fault: { method: "GET", path: /\/git\/ref\/tags\//, when: "before", status: 503 },
      code: "tag_readback_failed",
    },
  ])("does not report success when $label, and a retry confirms the tag without writing again", async ({ fault, code }) => {
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    state.github.faults.push({ ...fault });

    const interrupted = await fixture.publish(evaluation.json);
    expect(interrupted.code).toBe(1);
    expect(interrupted.stdout).toBe("");
    expect(interrupted.stderr).toContain(code);
    expect(tagsOn(pr33.mergeSha)).toEqual(["v0.0.7-dev.1"]);
    const writes = state.github.writes().length;

    const retried = await fixture.publish(evaluation.json);
    expect(retried.code).toBe(0);
    expect(retried.json).toMatchObject({ decision: "already_tagged", existingTag: { name: "v0.0.7-dev.1" } });
    expect(state.github.writes()).toHaveLength(writes);
    expect(tagsOn(pr33.mergeSha)).toEqual(["v0.0.7-dev.1"]);
  });

  it("refuses a name another writer took after allocation, and never tries another name", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const evaluation = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: () => repo.tag("v0.0.7-dev.1", pr32.mergeSha, "v0.0.7-dev.1\n\nNot this commit's build."),
    });
    const collidingObject = () => repo.git("rev-parse", "v0.0.7-dev.1");

    const { code, json } = await fixture.publish(evaluation.json);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", publication: "none", status: { state: "failure" } });
    expect(codes(json.reasons)).toEqual(["build_tag_name_collision"]);
    expect(json.reasons[0].detail).toContain("No other name is tried");
    expect(github.writes().filter((w) => w.path.endsWith("/git/refs"))).toHaveLength(1);
    expect(repo.git("rev-parse", "v0.0.7-dev.1^{commit}")).toBe(pr32.mergeSha);
    const object = collidingObject();

    // A retry sees the other tag for what it is — not a build tag — and does not allocate past it.
    const retried = await fixture.publish(evaluation.json);
    expect(retried.code).toBe(4);
    expect(codes(retried.json.reasons)).toEqual(["untrusted_build_tag"]);
    expect(github.writes().filter((w) => w.path.endsWith("/git/refs"))).toHaveLength(1);
    expect(collidingObject()).toBe(object);
    expect(tagsOn(pr33.mergeSha)).toEqual([]);
  });

  it("refuses, rather than confirms, a same-named tag created first whose provenance names another commit's run", async () => {
    const { repo, github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const otherRun = fixture.ci(pr32.mergeSha);
    const run = fixture.ci(pr33.mergeSha);
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: (body) => {
        const { ref, sha } = body as { ref: string; sha: string };
        const message = repo.git("cat-file", "tag", sha).split("\n\n").slice(1).join("\n\n");
        repo.tag(ref.slice("refs/tags/".length), pr33.mergeSha, message.replace(`CI-Run: ${run}`, `CI-Run: ${otherRun}`));
      },
    });

    const { code, json } = await fixture.publish(evaluation.json);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", publication: "none" });
    expect(codes(json.reasons)).toEqual(["build_tag_name_collision"]);
    expect(json.reasons[0].detail).toContain(`CI-Run ${otherRun} is not a final-merge CI run of this commit`);
  });

  it("writes nothing when the commit is no longer eligible by the time the writer runs, or GitHub cannot answer", async () => {
    const { github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);

    fixture.retry(run, { jobs: { [E2E_GATE]: "in_progress" } });
    const rerunning = await fixture.publish(evaluation.json);
    expect(rerunning.code).toBe(3);
    expect(rerunning.json).toMatchObject({ command: "publish-build", decision: "pending", publication: "none", tag: null });
    expect(codes(rerunning.json.reasons)).toEqual(["ci_incomplete"]);

    github.runs.get(run)!.attempts.pop();
    github.failures.set(`/repos/${REPOSITORY}/actions/runs/${run}/jobs`, 502);
    const unanswered = await fixture.publish(evaluation.json);
    expect(unanswered.code).toBe(1);
    expect(unanswered.stdout).toBe("");
    expect(unanswered.stderr).toContain("github_request_failed");

    expect(github.writes()).toEqual([]);
    expect(tagsOn(pr33.mergeSha)).toEqual([]);
  });

  it("confirms, rather than duplicates, the tag an identical writer created first", async () => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const evaluation = await fixture.evaluate(pr33.mergeSha, fixture.ci(pr33.mergeSha));
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: (body) => {
        const { ref, sha } = body as { ref: string; sha: string };
        repo.git("update-ref", ref, sha);
      },
    });

    const { code, json } = await fixture.publish(evaluation.json);

    expect(code).toBe(0);
    expect(json).toMatchObject({ decision: "already_tagged", existingTag: { name: "v0.0.7-dev.1" } });
    expect(tagsOn(pr33.mergeSha)).toEqual(["v0.0.7-dev.1"]);
  });

  it.each<{ label: string; setup: (repo: FixtureRepository, sha: string) => void; code: string }>([
    {
      label: "a hand-made annotated tag on the commit",
      setup: (repo, sha) => repo.tag("v0.0.7-dev.1", sha, "v0.0.7-dev.1\n\nMade by hand."),
      code: "conflicting_build_provenance",
    },
    {
      label: "two build tags on the commit",
      setup: (repo, sha) => {
        repo.tag("v0.0.7-dev.1", sha);
        repo.tag("v0.0.7-dev.2", sha);
      },
      code: "duplicate_build_tags",
    },
    {
      label: "another commit's annotated tag for the target that carries no build provenance",
      setup: (repo) => repo.tag("v0.0.7-dev.1", repo.root, "v0.0.7-dev.1\n\nMade by hand."),
      code: "untrusted_build_tag",
    },
    {
      label: "a malformed build tag for the target",
      setup: (repo) => repo.tag("v0.0.7-dev.01", repo.root),
      code: "malformed_build_tag",
    },
    {
      label: "a lightweight build tag for the target",
      setup: (repo) => repo.lightweightTag("v0.0.7-dev.4", repo.root),
      code: "lightweight_build_tag",
    },
  ])("refuses to allocate beside $label, and a refused plan cannot be published", async ({ setup, code }) => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    setup(repo, pr33.mergeSha);

    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    expect(evaluation.code).toBe(4);
    expect(evaluation.json).toMatchObject({ decision: "refused", tag: null, existingTag: null });
    expect(codes(evaluation.json.reasons)).toEqual([code]);

    const tagsBefore = fixture.remoteTags();
    const publication = await fixture.publish(evaluation.json);
    expect(publication.code).toBe(4);
    expect(codes(publication.json.reasons)).toEqual(["plan_not_eligible"]);
    expect(github.writes()).toEqual([]);
    expect(fixture.remoteTags()).toBe(tagsBefore);
  });

  it("refuses a forged build tag whose provenance names a run that is not the commit's final-merge CI", async () => {
    const { repo } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const otherRun = fixture.ci(pr32.mergeSha);
    const { publication } = await fixture.tagBuild(pr33.mergeSha, run);
    const message = repo.git("tag", "-l", "--format=%(contents)", "v0.0.7-dev.1");
    repo.git("tag", "-d", "v0.0.7-dev.1");
    repo.tag("v0.0.7-dev.1", pr33.mergeSha, message.replace(`CI-Run: ${run}`, `CI-Run: ${otherRun}`));
    expect(repo.git("rev-parse", "v0.0.7-dev.1")).not.toBe(publication.json.tag!.object);

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(4);
    expect(codes(json.reasons)).toEqual(["conflicting_build_provenance"]);
    expect(json.reasons[0].detail).toContain(`CI-Run ${otherRun} is not a final-merge CI run of this commit`);
  });

  /** An annotation carrying this commit's correct stable provenance, citing a chosen run and attempt. */
  const provenance = (plan: BuildReport, run: number, attempt: number) =>
    [
      `Build v0.0.7-dev.1 of ${REPOSITORY}`,
      "",
      "Written for the test, with every stable field correct.",
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

  it.each<{ label: string; attempts: AttemptSpec[]; cited: number; detail: string }>([
    {
      label: "the only attempt, which failed",
      attempts: [{ jobs: { [E2E_GATE]: "failure" } }],
      cited: 1,
      detail: `attempt 1 did not pass final-merge CI (concluded failure; ${E2E_GATE} failed)`,
    },
    {
      label: "a failed attempt of a run whose retry later passed",
      attempts: [{ jobs: { [E2E_GATE]: "failure" } }, {}],
      cited: 1,
      detail: `attempt 1 did not pass final-merge CI (concluded failure; ${E2E_GATE} failed)`,
    },
    {
      label: "an attempt that has not finished",
      attempts: [{}, { jobs: { [E2E_GATE]: "in_progress" } }],
      cited: 2,
      detail: `attempt 2 did not pass final-merge CI (is in_progress; ${E2E_GATE} incomplete)`,
    },
    {
      label: "an attempt the run never had",
      attempts: [{}],
      cited: 3,
      detail: "CI-Attempt 3 is not an attempt of run",
    },
  ])("refuses an existing build tag whose provenance cites $label", async ({ attempts, cited, detail }) => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts });
    const before = await fixture.evaluate(pr33.mergeSha, run);
    expect(before.json.target).not.toBeNull();
    repo.tag("v0.0.7-dev.1", pr33.mergeSha, provenance(before.json, run, cited));
    const tagsBefore = fixture.remoteTags();

    const { code, json } = await fixture.evaluate(pr33.mergeSha, run);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", existingTag: null, tag: null, status: { state: "failure" } });
    expect(codes(json.reasons)).toEqual(["conflicting_build_provenance"]);
    expect(json.reasons[0].detail).toContain(detail);

    const publication = await fixture.publish(json);
    expect(publication.code).toBe(4);
    expect(github.writes()).toEqual([]);
    expect(fixture.remoteTags()).toBe(tagsBefore);
  });

  it("keeps a build tag proven by the attempt it cites while a later re-run of the same run is running or has failed", async () => {
    const { github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    expect((await fixture.tagBuild(pr33.mergeSha, run)).publication.json.decision).toBe("tagged");
    const writes = github.writes().length;

    fixture.retry(run, { jobs: { [E2E_GATE]: "in_progress" } });
    const running = await fixture.evaluate(pr33.mergeSha, run);
    expect(running.code).toBe(0);
    expect(running.json).toMatchObject({
      decision: "already_tagged",
      existingTag: { name: "v0.0.7-dev.1", ciRun: String(run), ciAttempt: "1" },
      status: { state: "success" },
    });

    github.runs.get(run)!.attempts.pop();
    fixture.retry(run, { jobs: { [E2E_GATE]: "failure" } });
    const failed = await fixture.evaluate(pr33.mergeSha, run);
    expect(failed.code).toBe(0);
    expect(failed.json).toMatchObject({ decision: "already_tagged", existingTag: { name: "v0.0.7-dev.1" } });
    expect(github.writes()).toHaveLength(writes);
  });

  it("refuses a same-named tag created first that cites an attempt which did not pass, even though a later attempt did", async () => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }, {}] });
    const evaluation = await fixture.evaluate(pr33.mergeSha, run);
    expect(evaluation.json.ci!.satisfiedBy).toMatchObject({ runId: run, attempt: 2 });
    github.faults.push({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: (body) => {
        const { ref, sha } = body as { ref: string; sha: string };
        const message = repo.git("cat-file", "tag", sha).split("\n\n").slice(1).join("\n\n");
        repo.tag(ref.slice("refs/tags/".length), pr33.mergeSha, message.replace("CI-Attempt: 2", "CI-Attempt: 1"));
      },
    });

    const { code, json } = await fixture.publish(evaluation.json);

    expect(code).toBe(4);
    expect(json).toMatchObject({ decision: "refused", publication: "none", existingTag: null });
    expect(codes(json.reasons)).toEqual(["build_tag_name_collision"]);
    expect(json.reasons[0].detail).toContain(`run ${run} attempt 1 did not pass final-merge CI`);
    expect(github.writes().filter((w) => w.path.endsWith("/git/refs"))).toHaveLength(1);
  });

  it.each<{ label: string; add: (repo: FixtureRepository, sha: string) => void; code: string }>([
    { label: "a lightweight build tag", add: (repo, sha) => repo.lightweightTag("v0.0.7-dev.2", sha), code: "lightweight_build_tag" },
    { label: "a malformed build tag", add: (repo, sha) => repo.tag("v0.0.7-dev.02", sha), code: "malformed_build_tag" },
  ])("refuses $label beside a valid build tag on the same commit instead of confirming the valid one", async ({ add, code }) => {
    const { repo, github } = state;
    const { pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const { evaluation, publication } = await fixture.tagBuild(pr33.mergeSha, run);
    expect(publication.json.decision).toBe("tagged");
    const valid = repo.git("rev-parse", "v0.0.7-dev.1");
    add(repo, pr33.mergeSha);
    const tagsBefore = fixture.remoteTags();
    const writes = github.writes().length;

    const reevaluated = await fixture.evaluate(pr33.mergeSha, run);
    expect(reevaluated.code).toBe(4);
    expect(reevaluated.json).toMatchObject({ decision: "refused", existingTag: null, tag: null, status: { state: "failure" } });
    expect(codes(reevaluated.json.reasons)).toEqual(["duplicate_build_tags", code]);

    const republished = await fixture.publish(evaluation.json);
    expect(republished.code).toBe(4);
    expect(codes(republished.json.reasons)).toEqual(["duplicate_build_tags", code]);

    expect(github.writes()).toHaveLength(writes);
    expect(fixture.remoteTags()).toBe(tagsBefore);
    expect(repo.git("rev-parse", "v0.0.7-dev.1")).toBe(valid);
    expect(tagsOn(pr33.mergeSha)).toHaveLength(2);
  });

  it("allocates ordinals in allocation order, tags the exact commit however far main has moved, and never moves an earlier tag", async () => {
    const { repo } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [DATABASE_GATE]: "failure" } }] });
    const run33 = fixture.ci(pr33.mergeSha);
    const run34 = fixture.ci(pr34.mergeSha);

    const seen: string[] = [];
    const earlierTagsUnchanged = () => {
      const now = fixture.remoteTags().split("\n");
      for (const line of seen) expect(now).toContain(line);
      seen.splice(0, seen.length, ...now);
    };
    earlierTagsUnchanged();

    const b = await fixture.tagBuild(pr33.mergeSha, run33);
    expect(b.publication.json.tag).toMatchObject({ name: "v0.0.7-dev.1", commit: pr33.mergeSha });
    earlierTagsUnchanged();
    const c = await fixture.tagBuild(pr34.mergeSha, run34);
    expect(c.publication.json.tag).toMatchObject({ name: "v0.0.7-dev.2", commit: pr34.mergeSha });
    earlierTagsUnchanged();
    expect((await fixture.evaluate(pr32.mergeSha, run32)).code).toBe(5);

    // A feature merges and main moves on. The target rises for it, and only for it.
    const feature = repo.mergePullRequest({ number: 35, title: "feat(reports): print the daily summary" });
    const d = await fixture.tagBuild(feature.mergeSha, fixture.ci(feature.mergeSha));
    expect(d.publication.json.tag).toMatchObject({ name: "v0.1.0-dev.1", commit: feature.mergeSha });
    earlierTagsUnchanged();

    // The oldest merge passes last, on a retry: its own 0.0.7 target, the next 0.0.7 ordinal, its own commit.
    fixture.retry(run32);
    const late = await fixture.tagBuild(pr32.mergeSha, run32);
    expect(late.evaluation.json.target).toMatchObject({ version: "0.0.7", base: { tag: "v0.0.6" } });
    expect(late.evaluation.json.target!.merges.map((merge) => merge.pr)).toEqual([32]);
    expect(late.publication.json.tag).toMatchObject({ name: "v0.0.7-dev.3", commit: pr32.mergeSha });
    expect(repo.git("rev-parse", "v0.0.7-dev.3^{commit}")).toBe(pr32.mergeSha);
    expect(repo.git("rev-parse", "main")).toBe(feature.mergeSha);
    earlierTagsUnchanged();

    const annotation = repo.git("cat-file", "tag", "v0.0.7-dev.3");
    expect(annotation).toContain(`CI-Run: ${run32}\nCI-Attempt: 2`);
    expect(annotation).toContain(`- run ${run32} attempt 1: failure (${DATABASE_GATE} failure)`);
    expect(annotation).toContain(
      `- accepted flaky retry in run ${run32}: ${DATABASE_GATE} failure in attempt 1, success in attempt 2`,
    );
  });

  it("calculates an older commit that passes after a later normal release from its own ancestral release", async () => {
    const { repo } = state;
    const { released, pr32, pr33 } = fixture.releasedHistory();
    const run32 = fixture.ci(pr32.mergeSha, { attempts: [{ jobs: { [E2E_GATE]: "failure" } }] });
    repo.tag("v0.0.7", pr33.mergeSha);
    const pr34 = repo.mergePullRequest({ number: 34, title: "fix(invoices): show the settled amount" });

    const later = await fixture.tagBuild(pr34.mergeSha, fixture.ci(pr34.mergeSha));
    expect(later.evaluation.json.target!.base).toMatchObject({ tag: "v0.0.7", commit: pr33.mergeSha });
    expect(later.publication.json.tag).toMatchObject({ name: "v0.0.8-dev.1", commit: pr34.mergeSha });

    fixture.retry(run32);
    const older = await fixture.tagBuild(pr32.mergeSha, run32);
    expect(older.evaluation.json.target).toMatchObject({ version: "0.0.7", base: { tag: "v0.0.6", commit: released.mergeSha } });
    expect(older.publication.json).toMatchObject({ decision: "tagged", tag: { name: "v0.0.7-dev.1", commit: pr32.mergeSha } });
  });

  it("refuses a plan that is not an eligible evaluation of this repository, or no longer matches Git and GitHub, before any write", async () => {
    const { github } = state;
    const { pr32, pr33 } = fixture.releasedHistory();
    const run = fixture.ci(pr33.mergeSha);
    const pullRequestRun = fixture.ci(pr33.mergeSha, { event: "pull_request", branch: "pr-33" });
    const { json: plan } = await fixture.evaluate(pr33.mergeSha, run);

    const cases: Array<[string, unknown, string]> = [
      ["text that is not JSON", "{ not json", "plan_invalid"],
      ["another repository", { ...plan, repository: "someone/free-oms-app" }, "plan_invalid"],
      ["another repository id", { ...plan, repositoryId: 7 }, "plan_invalid"],
      ["another command's output", { ...plan, command: "preview" }, "plan_invalid"],
      ["a decision evaluate-build never reports", { ...plan, decision: "tagged" }, "plan_invalid"],
      ["a decision that is not eligible", { ...plan, decision: "failed" }, "plan_not_eligible"],
      ["a raised target version", { ...plan, target: { ...plan.target, version: "0.1.0" } }, "plan_drift"],
      ["another notes digest", { ...plan, target: { ...plan.target, notesDigest: `sha256:${"0".repeat(64)}` } }, "plan_drift"],
      ["a pull-request run", { ...plan, runId: pullRequestRun }, "not_final_merge_ci"],
      ["another commit under the same run", { ...plan, sha: pr32.mergeSha }, "not_final_merge_ci"],
    ];
    for (const [label, tampered, code] of cases) {
      const result = await fixture.publish(tampered);
      expect(result.code, label).toBe(4);
      expect(codes(result.json.reasons), label).toEqual([code]);
      expect(result.json.publication, label).toBe("none");
    }
    expect(github.writes()).toEqual([]);
    expect(tagsOn(pr33.mergeSha)).toEqual([]);
  });

  it("keeps hostile accepted history out of the annotation and out of any shell, and never prints the token", async () => {
    const { repo, checkout } = state;
    fixture.releasedHistory();
    const title =
      "fix: $(node -e \"require('fs').writeFileSync('pwned-subshell','x')\") `touch pwned-backtick` ${{ secrets.GITHUB_TOKEN }}";
    const merge = repo.mergePullRequest({ number: 34, title });

    const { evaluation, publication } = await fixture.tagBuild(merge.mergeSha, fixture.ci(merge.mergeSha));

    expect(publication.code, publication.stderr).toBe(0);
    expect(evaluation.json.target!.merges.at(-1)!.title).toBe(title);
    expect(repo.git("cat-file", "tag", publication.json.tag!.name)).not.toContain("pwned");
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(checkout.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(existsSync("pwned-subshell") || existsSync("pwned-backtick")).toBe(false);
    for (const run of [evaluation, publication]) expect(`${run.stdout}${run.stderr}`).not.toContain(TOKEN);
  });
});
