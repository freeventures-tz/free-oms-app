// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  BRANCH,
  CHANGELOG_PREAMBLE,
  DATE,
  lockfile,
  merged,
  occurrences,
  packageJson,
  PATCH_SUMMARY,
  preparationEntry,
  PULL,
  RELEASED_SECTIONS,
  section,
  usePreparationFixture,
} from "./support/preparation-harness";

describe("prepare-release: consistent normal-release metadata for review", { timeout: 300_000 }, () => {
  const prep = usePreparationFixture();
  const { state } = prep;

  it("prepares 0.0.7 from v0.0.6 on a preparation branch: package, lockfile, changelog and notes agree, and nothing is committed or published", async () => {
    const { github } = state;
    const { pr32, pr33, pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    const before = prep.snapshot();

    const { code, json, stderr } = await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE]);

    expect(code, stderr).toBe(0);
    expect(json).toMatchObject({
      command: "prepare-release",
      status: "prepared",
      mode: "write",
      publication: "none",
      sha: pr42.mergeSha,
      main: pr42.mergeSha,
      branch: BRANCH,
      lastNormalRelease: { tag: "v0.0.6", version: "0.0.6" },
      candidateMetadata: {
        packageVersion: "0.0.6",
        lockfileVersion: "0.0.6",
        lockfileRootVersion: "0.0.6",
        changelogVersion: "0.0.6",
        relation: "last_normal_release",
      },
      version: "0.0.7",
      policy: "0.x",
      highestChange: "patch",
      preparation: { pr: 43, url: PULL(43), title: "chore(release): prepare 0.0.7", date: DATE },
      reasons: [],
    });
    expect(json.merges.map((m) => m.pr)).toEqual([32, 33, 42]);

    const expectedSection = section({
      version: "0.0.7",
      base: "v0.0.6",
      pr: 43,
      summary: PATCH_SUMMARY,
      entries: [
        merged(1, 32, "test(settlement): prove the walk-in sale landed", pr32.mergeSha, "test"),
        merged(2, 33, "test: set the yard as well as the ledger", pr33.mergeSha, "test"),
        merged(3, 42, "ci(release): preview releases, tag exact merges and recover missed build tags", pr42.mergeSha, "ci"),
        preparationEntry(4, 43, "0.0.7"),
      ],
    });
    expect(prep.workingFiles()).toEqual({
      package: packageJson("0.0.7"),
      lockfile: lockfile("0.0.7"),
      changelog: `${CHANGELOG_PREAMBLE}${expectedSection}${RELEASED_SECTIONS}`,
    });
    expect(json.changelogSection).toBe(expectedSection);
    expect(json.files).toEqual([
      { path: "package.json", before: { version: "0.0.6" }, after: { version: "0.0.7" }, changed: true, written: true },
      {
        path: "package-lock.json",
        before: { version: "0.0.6", rootVersion: "0.0.6" },
        after: { version: "0.0.7", rootVersion: "0.0.7" },
        changed: true,
        written: true,
      },
      { path: "CHANGELOG.md", before: { version: "0.0.6" }, after: { version: "0.0.7" }, changed: true, written: true },
    ]);

    // The notes carry the same version and every merge once, the preparation included.
    const notes = json.notes!;
    expect(notes.startsWith("## 0.0.7 — release notes preview")).toBe(true);
    for (const pr of [32, 33, 42, 43]) expect(occurrences(notes, `[#${pr}](${PULL(pr)})`), `#${pr}`).toBe(1);
    expect(notes).toContain("chore(release): prepare 0.0.7");
    expect(notes).not.toContain(PULL(30));

    // Only the three files changed in the working tree. Nothing was staged, committed, tagged or sent.
    expect(prep.status()).toEqual({ modified: "CHANGELOG.md\npackage-lock.json\npackage.json", staged: "", untracked: "" });
    expect(prep.snapshot()).toEqual(before);
    expect(github.writes()).toEqual([]);
    expect(github.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("shows the same preparation as a dry run on main, before any pull request exists, and writes nothing", async () => {
    const { github } = state;
    const { pr42 } = prep.history();
    state.checkout.sync();
    prep.inCheckout("merge", "-q", "--ff-only", "origin/main");
    const before = { ...prep.snapshot(), files: prep.workingFiles() };

    const { code, json, stderr } = await prep.prepare(["--sha", pr42.mergeSha, "--date", DATE, "--dry-run"]);

    expect(code, stderr).toBe(0);
    expect(json).toMatchObject({
      status: "would_prepare",
      mode: "dry_run",
      branch: "main",
      version: "0.0.7",
      preparation: { pr: null, url: null, title: "chore(release): prepare 0.0.7", date: DATE },
    });
    expect(json.files.map((f) => [f.path, f.after, f.changed, f.written])).toEqual([
      ["package.json", { version: "0.0.7" }, true, false],
      ["package-lock.json", { version: "0.0.7", rootVersion: "0.0.7" }, true, false],
      ["CHANGELOG.md", { version: "0.0.7" }, true, false],
    ]);
    expect(json.changelogSection).toContain("<!-- release-controller:begin version=0.0.7 base=v0.0.6 preparation=none -->");
    expect(json.changelogSection).toContain(
      "4. **chore(release): prepare 0.0.7** — pull request not named yet · this release's preparation · `chore` → patch",
    );
    expect({ ...prep.snapshot(), files: prep.workingFiles() }).toEqual(before);
    expect(github.writes()).toEqual([]);

    const markdown = await prep.prepareMarkdown(["--sha", pr42.mergeSha, "--date", DATE, "--dry-run"]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toContain("## Release preparation: dry run");
    expect(markdown.stdout).toContain("| Last normal release | `0.0.6`, tag `v0.0.6`");
    expect(markdown.stdout).toContain("| Package version at the candidate | `0.0.6`, the last normal release |");
    expect(markdown.stdout).toContain("| Calculated version | **0.0.7**, from `v0.0.6`");
    expect(markdown.stdout).toContain("| package-lock.json | version `0.0.6`, root package `0.0.6` | version `0.0.7`, root package `0.0.7` | would be written |");
    expect(markdown.stdout).toContain("## 0.0.7 — release notes preview");
    expect({ ...prep.snapshot(), files: prep.workingFiles() }).toEqual(before);

    // Writing needs the pull request and a real date; a dry run needs the date.
    for (const args of [
      ["--sha", pr42.mergeSha, "--date", DATE],
      ["--sha", pr42.mergeSha, "--pr", "43"],
      ["--sha", pr42.mergeSha, "--pr", "43", "--date", "2026-02-30"],
      ["--sha", pr42.mergeSha, "--pr", "0", "--date", DATE],
      ["--sha", pr42.mergeSha.slice(0, 7), "--dry-run", "--date", DATE],
      ["--sha", pr42.mergeSha, "--dry-run", "--date", DATE, "--accept-stable-contract", "a reference"],
    ]) {
      const usage = await prep.prepareMarkdown(args);
      expect(usage.code, args.join(" ")).toBe(2);
      expect(usage.stdout).toBe("");
    }
    expect({ ...prep.snapshot(), files: prep.workingFiles() }).toEqual(before);
  });

  it("repeats a preparation without duplicating it: unchanged when nothing moved, and replaced in place, prose kept, after main moves", async () => {
    const { repo, github } = state;
    const { pr32, pr33, pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    const prepare = (sha: string) => prep.prepare(["--sha", sha, "--pr", "43", "--date", DATE]);
    expect((await prepare(pr42.mergeSha)).json.status).toBe("prepared");

    // The Implementer writes the plain-language summary above the generated block, and commits.
    const prose = "**Two test corrections and the release controller.** Nothing a person sees changes.\n\n";
    const heading = `## [0.0.7] — ${DATE}\n\n`;
    prep.writeWorkingFile("CHANGELOG.md", prep.readWorkingFile("CHANGELOG.md").replace(heading, `${heading}${prose}`));
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch();
    const committed = prep.workingFiles();

    const again = await prepare(pr42.mergeSha);
    expect(again.code, again.stderr).toBe(0);
    expect(again.json.status).toBe("prepared");
    expect(again.json.files.map((f) => [f.changed, f.written])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(prep.workingFiles()).toEqual(committed);
    expect(prep.status()).toEqual({ modified: "", staged: "", untracked: "" });

    // Main moves. The branch is refused until it contains main as it stands, and nothing is touched.
    const hostile = "fix(receipts): keep <!-- release-controller:end --> and ## [9.9.9] out of the notes";
    const pr44 = repo.mergePullRequest({ number: 44, title: hostile });
    const stale = await prepare(pr42.mergeSha);
    expect(stale.code).toBe(4);
    expect(stale.json.reasons.map((r) => r.code)).toEqual(["candidate_not_main_tip"]);
    const behind = await prepare(pr44.mergeSha);
    expect(behind.code).toBe(4);
    expect(behind.json.reasons.map((r) => r.code)).toEqual(["branch_not_based_on_candidate"]);
    expect(prep.workingFiles()).toEqual(committed);

    prep.updateBranchFromMain();
    const moved = await prepare(pr44.mergeSha);
    expect(moved.code, moved.stderr).toBe(0);
    expect(moved.json).toMatchObject({ status: "prepared", version: "0.0.7" });
    const escaped = "fix(receipts): keep &lt;!-- release-controller:end --&gt; and \\#\\# \\[9.9.9\\] out of the notes";
    const expectedSection = section({
      version: "0.0.7",
      base: "v0.0.6",
      pr: 43,
      summary: PATCH_SUMMARY,
      between: [prose.trimEnd(), ""],
      entries: [
        merged(1, 32, "test(settlement): prove the walk-in sale landed", pr32.mergeSha, "test"),
        merged(2, 33, "test: set the yard as well as the ledger", pr33.mergeSha, "test"),
        merged(3, 42, "ci(release): preview releases, tag exact merges and recover missed build tags", pr42.mergeSha, "ci"),
        merged(4, 44, escaped, pr44.mergeSha, "fix"),
        preparationEntry(5, 43, "0.0.7"),
      ],
    });
    const changelogText = prep.readWorkingFile("CHANGELOG.md");
    expect(changelogText).toBe(`${CHANGELOG_PREAMBLE}${expectedSection}${RELEASED_SECTIONS}`);
    expect(moved.json.changelogSection).toBe(expectedSection);
    for (const pr of [32, 33, 42, 43, 44]) expect(occurrences(changelogText, `[#${pr}](${PULL(pr)})`), `#${pr}`).toBe(1);
    // Only the changelog had anything to change.
    expect(moved.json.files.map((f) => [f.path, f.changed])).toEqual([
      ["package.json", false],
      ["package-lock.json", false],
      ["CHANGELOG.md", true],
    ]);

    // The hostile title is data: the file still parses as one generated section, so the next run changes nothing.
    const third = await prepare(pr44.mergeSha);
    expect(third.code, third.stderr).toBe(0);
    expect(third.json.files.every((f) => !f.changed)).toBe(true);
    expect(prep.readWorkingFile("CHANGELOG.md")).toBe(changelogText);
    expect(github.writes()).toEqual([]);
  });

  it("escalates a pending 0.0.7 to 0.1.0 when a feature and a breaking change merge, then checks the merged preparation without another commit", async () => {
    const { repo, github } = state;
    const { pr32, pr33, pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    expect((await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE])).json.version).toBe("0.0.7");
    const prose = "**What this release changes.**\n\n";
    const heading07 = `## [0.0.7] — ${DATE}\n\n`;
    prep.writeWorkingFile("CHANGELOG.md", prep.readWorkingFile("CHANGELOG.md").replace(heading07, `${heading07}${prose}`));
    prep.commitPreparation("chore(release): prepare 0.0.7");

    const featureTitle = "feat(catalogue): price by counting unit";
    const pr44 = repo.mergePullRequest({
      number: 44,
      title: featureTitle,
      retainedBody: `${featureTitle}\n\nDEPRECATED: the per-unit price field; read the counting-unit price`,
    });
    const breakingTitle = "feat(api)!: rename the dispatch command";
    const pr45 = repo.mergePullRequest({
      number: 45,
      title: breakingTitle,
      retainedBody: `${breakingTitle}\n\nBREAKING CHANGE: api.staff_sign_dispatch is now api.staff_confirm_dispatch`,
    });
    prep.updateBranchFromMain();
    const committed = prep.workingFiles();

    // The pull request still carries the old title, which its merge would keep: refused, nothing written.
    const retitle = await prep.prepare(["--sha", pr45.mergeSha, "--pr", "43", "--date", DATE]);
    expect(retitle.code).toBe(4);
    expect(retitle.json).toMatchObject({ status: "refused", version: "0.1.0" });
    expect(retitle.json.reasons).toEqual([
      expect.objectContaining({ code: "preparation_title_mismatch", pr: 43 }),
    ]);
    expect(retitle.json.reasons[0].detail).toContain('"chore(release): prepare 0.1.0"');
    expect(prep.workingFiles()).toEqual(committed);

    github.pulls.get(43)!.title = "chore(release): prepare 0.1.0";
    const escalated = await prep.prepare(["--sha", pr45.mergeSha, "--pr", "43", "--date", DATE]);
    expect(escalated.code, escalated.stderr).toBe(0);
    expect(escalated.json).toMatchObject({
      status: "prepared",
      version: "0.1.0",
      highestChange: "breaking",
      lastNormalRelease: { tag: "v0.0.6" },
      candidateMetadata: { packageVersion: "0.0.6", relation: "last_normal_release" },
    });
    expect(escalated.json.files.map((f) => [f.path, f.before, f.after])).toEqual([
      ["package.json", { version: "0.0.7" }, { version: "0.1.0" }],
      ["package-lock.json", { version: "0.0.7", rootVersion: "0.0.7" }, { version: "0.1.0", rootVersion: "0.1.0" }],
      ["CHANGELOG.md", { version: "0.0.7" }, { version: "0.1.0" }],
    ]);
    const escalatedSection = [
      `## [0.1.0] — ${DATE}`,
      "",
      prose.trimEnd(),
      "",
      "<!-- release-controller:begin version=0.1.0 base=v0.0.6 preparation=43 -->",
      "Generated from every accepted merge after `v0.0.6`. Each preparation replaces the lines between these markers; write prose above or below them.",
      "",
      "Version policy 0.x. Highest change: breaking.",
      "",
      "### Breaking changes",
      "",
      `- **${breakingTitle}** ([#45](${PULL(45)})): api.staff\\_sign\\_dispatch is now api.staff\\_confirm\\_dispatch`,
      "",
      "### Deprecations",
      "",
      `- **${featureTitle}** ([#44](${PULL(44)})): the per-unit price field; read the counting-unit price`,
      "",
      "### Accepted merges (6)",
      "",
      merged(1, 32, "test(settlement): prove the walk-in sale landed", pr32.mergeSha, "test"),
      merged(2, 33, "test: set the yard as well as the ledger", pr33.mergeSha, "test"),
      merged(3, 42, "ci(release): preview releases, tag exact merges and recover missed build tags", pr42.mergeSha, "ci"),
      merged(4, 44, featureTitle, pr44.mergeSha, "feat", "minor"),
      merged(5, 45, breakingTitle, pr45.mergeSha, "feat", "breaking"),
      preparationEntry(6, 43, "0.1.0"),
      "<!-- release-controller:end -->",
      "",
      "",
    ].join("\n");
    expect(prep.workingFiles()).toEqual({
      package: packageJson("0.1.0"),
      lockfile: lockfile("0.1.0"),
      changelog: `${CHANGELOG_PREAMBLE}${escalatedSection}${RELEASED_SECTIONS}`,
    });
    expect(prep.readWorkingFile("CHANGELOG.md")).not.toContain("[0.0.7]");

    // The reviewed preparation merges. Its own merge is checked from history; nothing else is committed.
    prep.commitPreparation("chore(release): prepare 0.1.0");
    prep.pushBranch();
    const preparation = prep.mergePreparation(43, "chore(release): prepare 0.1.0");
    const refsAfterMerge = state.repo.refs();
    const checkoutFiles = prep.workingFiles();

    let finalNotes = "";
    for (const extra of [["--dry-run"], ["--pr", "43"], ["--pr", "43", "--dry-run"]]) {
      const check = await prep.prepare(["--sha", preparation.mergeSha, "--date", DATE, ...extra]);
      expect(check.code, `${extra.join(" ")} ${check.stderr}`).toBe(0);
      expect(check.json).toMatchObject({
        status: "already_prepared",
        version: "0.1.0",
        lastNormalRelease: { tag: "v0.0.6", version: "0.0.6" },
        candidateMetadata: {
          packageVersion: "0.1.0",
          lockfileVersion: "0.1.0",
          lockfileRootVersion: "0.1.0",
          changelogVersion: "0.1.0",
          relation: "ahead_of_last_normal_release",
        },
        preparation: { pr: 43, title: "chore(release): prepare 0.1.0", date: DATE },
        files: [],
        reasons: [],
      });
      expect(check.json.changelogSection).toBe(escalatedSection);
      expect(check.json.final!.merges).toEqual([
        { pr: 32, mergeSha: pr32.mergeSha, title: "test(settlement): prove the walk-in sale landed" },
        { pr: 33, mergeSha: pr33.mergeSha, title: "test: set the yard as well as the ledger" },
        { pr: 42, mergeSha: pr42.mergeSha, title: "ci(release): preview releases, tag exact merges and recover missed build tags" },
        { pr: 44, mergeSha: pr44.mergeSha, title: featureTitle },
        { pr: 45, mergeSha: pr45.mergeSha, title: breakingTitle },
        { pr: 43, mergeSha: preparation.mergeSha, title: "chore(release): prepare 0.1.0" },
      ]);
      finalNotes = check.json.final!.notes;
      expect(finalNotes.startsWith("## 0.1.0 — release notes preview")).toBe(true);
      expect(occurrences(finalNotes, `[#43](${PULL(43)})`)).toBe(1);
      expect(finalNotes).toContain(`merge [\`${preparation.mergeSha}\`]`);
      expect(finalNotes).not.toContain("history records its merge when it merges");
    }
    expect(state.repo.refs()).toBe(refsAfterMerge);
    expect(prep.workingFiles()).toEqual(checkoutFiles);

    // A changed release date is a different release, and is refused.
    const otherDate = await prep.prepare(["--sha", preparation.mergeSha, "--date", "2026-09-21", "--dry-run"]);
    expect(otherDate.code).toBe(4);
    expect(otherDate.json.reasons.map((r) => r.code)).toEqual(["prepared_changelog_mismatch"]);

    // The preview labels both versions and calculates from the tag, never from the pending 0.1.0.
    const preview = await prep.preview(preparation.mergeSha);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.json).toMatchObject({
      version: "0.1.0",
      base: { tag: "v0.0.6" },
      candidateMetadata: { packageVersion: "0.1.0", relation: "ahead_of_last_normal_release" },
    });
    expect(preview.json.notes).toContain(
      "| Package version at this merge | `0.1.0`, ahead of the last normal release `v0.0.6`: prepared and not yet released. The version above is calculated from `v0.0.6` |",
    );
    expect(preview.json.notes).toBe(finalNotes);

    // Its build is a 0.1.0 prerelease too, and the ordinal stays in the tag.
    const run = prep.fixture.ci(preparation.mergeSha);
    const build = await prep.fixture.evaluate(preparation.mergeSha, run);
    expect(build.code, build.stderr).toBe(0);
    expect(build.json).toMatchObject({ decision: "eligible", tag: { name: "v0.1.0-dev.1" }, target: { version: "0.1.0" } });
    expect(state.repo.git("show", `${preparation.mergeSha}:package.json`)).toBe(packageJson("0.1.0").trimEnd());
    expect(github.writes()).toEqual([]);
  });
});
