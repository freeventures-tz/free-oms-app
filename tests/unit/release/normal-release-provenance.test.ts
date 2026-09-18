// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Fault } from "./support/github-simulator";
import { INTRUDER, OWNER, useReleaseFixture } from "./support/release-harness";

/**
 * The dispatch an existing normal tag cites. A tag counts as this release only when its `Dispatch-Run` names
 * the Owner's dispatch of the tag's commit, read from GitHub. The run that wrote a tag may since have finished,
 * failed after writing, or been re-run, and a legitimate retry still finds its release.
 */
describe("normal releases: the dispatch an existing tag cites", { timeout: 300_000 }, () => {
  const release = useReleaseFixture();
  const { state } = release;

  /** The current tag's annotation, citing another dispatch. */
  const annotationCiting = (object: string, cited: string) => {
    const raw = state.repo.git("cat-file", "tag", object);
    return raw.slice(raw.indexOf("\n\n") + 2).replace(/^Dispatch-Run: .*$/m, `Dispatch-Run: ${cited}`);
  };
  const finishAttempt = (runId: number, attempt: number, conclusion: string) =>
    Object.assign(state.github.runs.get(runId)!.attempts[attempt - 1], { status: "completed", conclusion });

  it("refuses an existing tag whose cited dispatch is missing, or is not the Owner's dispatch of this commit", async () => {
    const { repo, github } = state;
    const { history, release: prepared, evidence, run: dispatch } = await release.validRelease();
    const sha = prepared.mergeSha;
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    expect((await release.publish(plan, dispatch)).json.decision).toBe("published");

    // Runs that look like a dispatch but are not the Owner's dispatch of this commit.
    const byIntruder = release.automaticRun(sha, { actor: INTRUDER });
    const reranByIntruder = release.rerun(release.automaticRun(sha), INTRUDER);
    const otherCommit = release.automaticRun(history.pr42.mergeSha);
    const pushed = release.automaticRun(sha, { event: "push" });
    const otherBranch = release.automaticRun(sha, { branch: "release/v0.0.7" });
    const otherWorkflow = release.automaticRun(sha, { path: ".github/workflows/release-build-tag.yml", workflowId: 1 });
    const cases: Array<[string, string]> = [
      ["999999999999 99", "has no workflow run 999999999999"],
      [`${dispatch.runId} 9`, "the run has no attempt 9"],
      [`${byIntruder.runId} 1`, `it was started by "fixture-intruder", not the Owner`],
      [`${reranByIntruder.runId} 2`, `attempt 2 was started by "fixture-intruder", not the Owner`],
      [`${otherCommit.runId} 1`, `its head commit is "${history.pr42.mergeSha}"`],
      [`${pushed.runId} 1`, `its event is "push"`],
      [`${otherBranch.runId} 1`, `its branch is "release/v0.0.7"`],
      [`${otherWorkflow.runId} 1`, "its workflow id is 1"],
      [`${evidence.ciRun} 1`, `its workflow path is ".github/workflows/ci.yml"`],
    ];

    const current = release.automaticRun(sha);
    for (const [cited, why] of cases) {
      repo.git("tag", "-f", "-a", "v0.0.7", "-m", annotationCiting("v0.0.7", cited), sha);
      const run = await release.evaluate(evidence.request, { dispatch: current });
      expect(run.code, cited).toBe(4);
      expect(run.json.decision, cited).toBe("refused");
      expect(release.unsatisfied(run.json), cited).toEqual(["version:normal_tag_conflict"]);
      expect(run.json.reasons[0].detail, cited).toContain(`its Dispatch-Run ${cited} is not the Owner's standing dispatch of ${sha}`);
      expect(run.json.reasons[0].detail, cited).toContain(why);
    }

    // The writer's retry refuses the fabricated citation too, and writes nothing.
    repo.git("tag", "-f", "-a", "v0.0.7", "-m", annotationCiting("v0.0.7", "999999999999 99"), sha);
    const retried = await release.publish(plan, release.rerun(dispatch, OWNER));
    expect(retried.code).toBe(4);
    expect(retried.json.decision).toBe("refused");
    expect(release.unsatisfied(retried.json)).toEqual(["version:normal_tag_conflict"]);
    expect(github.writes()).toHaveLength(2);

    // With the citation the writer made, the same tag is this release again.
    repo.git("tag", "-f", "-a", "v0.0.7", "-m", annotationCiting("v0.0.7", `${dispatch.runId} 1`), sha);
    const genuine = await release.evaluate(evidence.request, { dispatch: current });
    expect(genuine.code, genuine.stderr).toBe(0);
    expect(genuine.json.decision).toBe("already_published");
  });

  it("recovers a release whose writing attempt lost its response and failed, through the Owner's re-run and a later dispatch", async () => {
    const { repo, github } = state;
    const { release: prepared, evidence, run: dispatch } = await release.validRelease();
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;

    // The reference is created, its response is lost, and the attempt fails.
    github.faults.push({ method: "POST", path: /\/git\/refs$/, when: "after", status: 502 });
    const lost = await release.publish(plan, dispatch);
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain("tag_reference_unconfirmed");
    finishAttempt(dispatch.runId, 1, "failure");
    expect(repo.git("cat-file", "tag", "v0.0.7")).toContain(`Dispatch-Run: ${dispatch.runId} 1`);

    // The Owner re-runs it. The tag cites the failed first attempt, which is no longer the latest, and counts.
    const retry = release.rerun(dispatch, OWNER);
    const confirmed = await release.publish(plan, retry);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect(confirmed.json.decision).toBe("already_published");
    finishAttempt(dispatch.runId, 2, "success");

    // A later dispatch, after that run finished, finds the release as well.
    const later = await release.workflowRun(evidence.request, release.automaticRun(prepared.mergeSha));
    expect(later.plan.code, later.plan.stderr).toBe(0);
    expect(later.plan.json.decision).toBe("already_published");
    expect(later.publication).toBeNull();
    expect(github.writes().map((w) => w.path.replace(/^.*\/git\//, ""))).toEqual(["tags", "refs"]);
  });

  it("reads a racing tag back as this release only when it cites the Owner's dispatch", async () => {
    const { repo, github } = state;
    const { release: prepared, evidence, run: dispatch } = await release.validRelease();
    const sha = prepared.mergeSha;
    const plan = (await release.evaluate(evidence.request, { dispatch })).json;
    const earlier = release.automaticRun(sha);
    finishAttempt(earlier.runId, 1, "success");
    const intruded = release.automaticRun(sha, { actor: INTRUDER });

    // Just before the reference is created, another tag takes the name: the writer's own annotation, citing
    // another dispatch.
    const racer = (cited: string): Fault => ({
      method: "POST",
      path: /\/git\/refs$/,
      when: "before",
      effect: (body) => {
        const object = (body as { sha: string }).sha;
        repo.git("tag", "-a", "v0.0.7", "-m", annotationCiting(object, cited), sha);
      },
    });

    github.faults.push(racer(`${intruded.runId} 1`));
    const refused = await release.publish(plan, dispatch);
    expect(refused.code).toBe(4);
    expect(refused.json.decision).toBe("refused");
    expect(refused.json.reasons.map((r) => r.code)).toEqual(["normal_tag_name_collision"]);
    expect(refused.json.reasons[0].detail).toContain(`its Dispatch-Run ${intruded.runId} 1 is not the Owner's standing dispatch of ${sha}`);
    expect(repo.git("cat-file", "tag", "v0.0.7")).toContain(`Dispatch-Run: ${intruded.runId} 1`);

    // The same race won by the Owner's earlier, finished dispatch of this release is this release.
    repo.git("tag", "-d", "v0.0.7");
    github.faults.push(racer(`${earlier.runId} 1`));
    const confirmed = await release.publish(plan, dispatch);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect(confirmed.json.decision).toBe("already_published");
    expect(confirmed.json.existingTag).toMatchObject({ name: "v0.0.7", commit: sha });
    expect(repo.git("cat-file", "tag", "v0.0.7")).toContain(`Dispatch-Run: ${earlier.runId} 1`);
  });
});
