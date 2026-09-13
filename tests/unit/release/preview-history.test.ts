// @vitest-environment node
import { describe, expect, it } from "vitest";

import { REPOSITORY, TOKEN, usePreviewFixture, type PreviewMerge, type PreviewReason } from "./support/preview-harness";

/**
 * Which history a preview will accept, and what it names when it will not. Retained, immutable merge
 * metadata governs; anything that is not a two-parent GitHub merge associated with its pull request
 * is a pending decision; malformed or ambiguous input is a refusal. In every case no version is
 * calculated and nothing is written.
 */
describe("preview: accepted history", { timeout: 180_000 }, () => {
  const { state, preview, previewMarkdown } = usePreviewFixture();

  const codes = (json: Record<string, unknown>) => (json.reasons as PreviewReason[]).map((r) => r.code);

  it("classifies from the retained merge body, so editing the pull request after merge changes nothing", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.6", repo.root);
    const merge = repo.mergePullRequest({ number: 50, title: "fix(receipts): print the till number" });

    const before = await preview(["--sha", merge.mergeSha]);
    expect(before.json).toMatchObject({ version: "0.0.7" });

    const pull = github.pulls.get(50)!;
    pull.title = "feat!: rewrite receipts";
    pull.body = "BREAKING CHANGE: every receipt is different";
    pull.labels = [{ name: "breaking" }, { name: "feature" }];

    const after = await preview(["--sha", merge.mergeSha]);
    expect(after.code).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it("refuses a breaking change whose explanation stayed in the PR description and was not retained in the merge", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    const merge = repo.mergePullRequest({
      number: 51,
      title: "feat(api)!: remove the legacy discount call",
      description: "BREAKING CHANGE: the discount call is gone",
    });

    const { code, json } = await preview(["--sha", merge.mergeSha]);
    expect(code).toBe(4);
    expect(json).toMatchObject({ status: "refused", version: null, merges: [], notes: null });
    expect(json.reasons).toEqual([
      expect.objectContaining({
        kind: "refusal",
        code: "breaking_missing_explanation",
        commit: merge.mergeSha,
        pr: 51,
      }),
    ]);
  });

  it("refuses a retained title that is not a Conventional Commit, at the merge that carries it", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    repo.mergePullRequest({ number: 52, title: "fix: an acceptable change" });
    const bad = repo.mergePullRequest({ number: 53, title: "Update the receipts" });

    const { code, json } = await preview(["--sha", bad.mergeSha]);
    expect(code).toBe(4);
    expect(json.reasons).toEqual([
      expect.objectContaining({ kind: "refusal", code: "malformed_title", commit: bad.mergeSha, pr: 53 }),
    ]);
  });

  it("names every unsupported shape and broken association on main as a pending decision and calculates nothing", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.6", repo.root);
    repo.mergePullRequest({ number: 54, title: "fix: an acceptable change" });
    const direct = repo.commit("fix: pushed straight to main");
    const squash = repo.squashPullRequest({ number: 55, title: "fix: squashed" });
    const local = repo.mergeBranchLocally(["fix: merged locally"], "Merge branch 'hotfix'");
    const octopus = repo.octopusMerge("Merge pull request #56 from fixture/octopus");
    const missing = repo.mergePullRequest({ number: 57, title: "fix: a merge GitHub does not know" });
    github.pulls.delete(57);
    const wrongHead = repo.mergePullRequest({ number: 58, title: "fix: a head that moved" });
    github.pulls.get(58)!.head.sha = "f".repeat(40);
    const unmerged = repo.mergePullRequest({ number: 59, title: "fix: closed without merging" });
    github.pulls.get(59)!.merged = false;
    const refsBefore = repo.refs();

    const { code, json } = await preview(["--sha", unmerged.mergeSha]);

    expect(code).toBe(3);
    expect(json).toMatchObject({ status: "pending_decision", version: null, merges: [], notes: null });
    expect(json.reasons).toEqual([
      expect.objectContaining({ kind: "pending_decision", code: "direct_push", commit: direct }),
      expect.objectContaining({ code: "squash_or_rebase_merge", commit: squash.sha, pr: 55 }),
      expect.objectContaining({ code: "unsupported_merge_subject", commit: local }),
      expect.objectContaining({ code: "octopus_merge", commit: octopus }),
      expect.objectContaining({ code: "missing_pr_association", commit: missing.mergeSha, pr: 57 }),
      expect.objectContaining({ code: "pr_association_mismatch", commit: wrongHead.mergeSha, pr: 58 }),
      expect.objectContaining({ code: "pr_association_mismatch", commit: unmerged.mergeSha, pr: 59 }),
    ]);
    expect((json.reasons as PreviewReason[])[5].detail).toContain("is not the merged parent");
    expect((json.reasons as PreviewReason[])[6].detail).toContain("it is not merged");
    expect(github.writes()).toEqual([]);
    expect(repo.refs()).toBe(refsBefore);

    const markdown = await previewMarkdown(["--sha", unmerged.mergeSha]);
    expect(markdown.code).toBe(3);
    expect(markdown.stdout).toContain("## Release preview: pending an Owner decision");
    expect(markdown.stdout).toContain("`squash_or_rebase_merge`");
  });

  it("reports a refusal ahead of a pending decision when a range has both", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    repo.commit("fix: pushed straight to main");
    const bad = repo.mergePullRequest({ number: 60, title: "fixed the receipts" });

    const { code, json } = await preview(["--sha", bad.mergeSha]);
    expect(code).toBe(4);
    expect(json.status).toBe("refused");
    expect(codes(json)).toEqual(["direct_push", "malformed_title"]);
  });

  it("follows pagination when it asks GitHub which pull requests a single-parent commit belongs to", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.6", repo.root);
    const squash = repo.squashPullRequest({ number: 62, title: "fix: squashed" });
    github.pulls.set(61, { ...github.pulls.get(62)!, number: 61, merged: false, merged_at: null });
    github.commitPulls.set(squash.sha, [61, 62]);
    github.setPageSize(1);

    const { code, json } = await preview(["--sha", squash.sha]);
    expect(code).toBe(3);
    expect(json.reasons).toEqual([expect.objectContaining({ code: "squash_or_rebase_merge", pr: 62 })]);
    expect(github.requests.some((r) => r.path.includes("page=2"))).toBe(true);
  });

  it("refuses anything but an exact accepted merge on main's first-parent line", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    const merge = repo.mergePullRequest({
      number: 63,
      title: "fix: an acceptable change",
      commits: ["fix: part one", "fix: part two"],
    });
    const offMain = repo.unmergedCommit("feat: never merged");

    const unmerged = await preview(["--sha", offMain]);
    expect(unmerged.code).toBe(4);
    expect(codes(unmerged.json)).toEqual(["not_on_main_first_parent"]);

    const development = await preview(["--sha", merge.developmentCommits[0]]);
    expect(codes(development.json)).toEqual(["not_on_main_first_parent"]);

    const unknown = await preview(["--sha", "0".repeat(40)]);
    expect(codes(unknown.json)).toEqual(["unknown_commit"]);

    const abbreviated = await previewMarkdown(["--sha", merge.mergeSha.slice(0, 7)]);
    expect(abbreviated.code).toBe(2);
    expect(abbreviated.stderr).toContain("full 40-character");

    for (const repo of ["freeventures-tz/..", "freeventures-tz/.", "../free-oms-app"]) {
      const bad = await previewMarkdown(["--sha", merge.mergeSha, "--repo", repo]);
      expect(bad.code, repo).toBe(2);
    }
  });

  it("accepts a revert of an earlier commit and records it, and refuses one naming a commit that was never on main", async () => {
    const { repo } = state;
    const feature = repo.mergePullRequest({ number: 64, title: "feat(receipts): a new receipt layout" });
    repo.tag("v0.1.0", feature.mergeSha);
    const revert = repo.mergePullRequest({
      number: 65,
      title: "fix(receipts): restore the previous receipt layout",
      retainedBody: `fix(receipts): restore the previous receipt layout\n\nReverts: ${feature.mergeSha}`,
    });

    const accepted = await preview(["--sha", revert.mergeSha]);
    expect(accepted.code).toBe(0);
    expect(accepted.json).toMatchObject({ version: "0.1.1" });
    expect((accepted.json.merges as PreviewMerge[])[0].reverts).toEqual([
      { sha: feature.mergeSha, url: `https://github.com/${REPOSITORY}/commit/${feature.mergeSha}` },
    ]);
    expect(accepted.json.notes).toContain(`Reverts: [\`${feature.mergeSha}\`]`);

    const elsewhere = repo.unmergedCommit("feat: an experiment");
    const bad = repo.mergePullRequest({
      number: 66,
      title: "fix: undo the experiment",
      retainedBody: `fix: undo the experiment\n\nReverts: ${elsewhere}`,
    });
    const refused = await preview(["--sha", bad.mergeSha]);
    expect(refused.code).toBe(4);
    expect(refused.json.reasons).toEqual([
      expect.objectContaining({ code: "ambiguous_revert", commit: bad.mergeSha, pr: 66 }),
    ]);
  });

  it("keeps hostile retained text as data: nothing runs, nothing is written, the token is not printed", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.6", repo.root);
    const title =
      "fix: $(node -e \"require('fs').writeFileSync('pwned-subshell','x')\") `touch pwned-backtick` ${{ secrets.GITHUB_TOKEN }}";
    const merge = repo.mergePullRequest({ number: 67, title });

    const { code, json, stdout, stderr } = await preview(["--sha", merge.mergeSha]);
    expect(code).toBe(0);
    expect((json.merges as PreviewMerge[])[0].title).toBe(title);
    expect(json.notes).toContain("\\`touch pwned-backtick\\`");
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(`${stdout}${stderr}`).not.toContain(TOKEN);
    expect(github.writes()).toEqual([]);
  });

  it("stops without guessing when GitHub cannot answer", async () => {
    const { repo, github } = state;
    repo.tag("v0.0.6", repo.root);
    const merge = repo.mergePullRequest({ number: 68, title: "fix: an acceptable change" });
    github.failures.set(`/repos/${REPOSITORY}/pulls/`, 502);

    const { code, stdout, stderr } = await previewMarkdown(["--sha", merge.mergeSha]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("github_request_failed");
  });

  it("refuses when no annotated normal release is in the commit's history, ignoring prerelease tags", async () => {
    const { repo } = state;
    const merge = repo.mergePullRequest({ number: 69, title: "fix: an acceptable change" });
    repo.tag("v0.0.7-dev.1", merge.mergeSha);
    const refsBefore = repo.refs();

    const { code, json } = await preview(["--sha", merge.mergeSha]);
    expect(code).toBe(4);
    expect(codes(json)).toEqual(["no_normal_release_base"]);
    expect(repo.refs()).toBe(refsBefore);
  });

  it("refuses a lightweight normal release tag rather than choosing a different base", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    const merge = repo.mergePullRequest({ number: 70, title: "fix: an acceptable change" });
    repo.lightweightTag("v0.0.7", merge.mergeSha);
    const later = repo.mergePullRequest({ number: 71, title: "fix: another" });

    const { json } = await preview(["--sha", later.mergeSha]);
    expect(codes(json)).toEqual(["lightweight_normal_tag"]);
  });

  it("refuses two normal release tags on one commit", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    repo.tag("v0.0.7", repo.root);
    const merge = repo.mergePullRequest({ number: 72, title: "fix: an acceptable change" });

    const { json } = await preview(["--sha", merge.mergeSha]);
    expect(codes(json)).toEqual(["duplicate_normal_tags"]);
  });

  it("refuses normal release tags whose versions run backwards in history", async () => {
    const { repo } = state;
    repo.tag("v0.0.8", repo.root);
    const merge = repo.mergePullRequest({ number: 73, title: "fix: an acceptable change" });
    repo.tag("v0.0.7", merge.mergeSha);
    const later = repo.mergePullRequest({ number: 74, title: "fix: another" });

    const { json } = await preview(["--sha", later.mergeSha]);
    expect(codes(json)).toEqual(["normal_tag_order_conflict"]);
  });
});
