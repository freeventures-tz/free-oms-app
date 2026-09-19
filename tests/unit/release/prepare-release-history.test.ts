// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CHANGELOG_PREAMBLE,
  changelog,
  DATE,
  lockfile,
  merged,
  occurrences,
  packageJson,
  PATCH_SUMMARY,
  preparationEntry,
  PULL,
  section,
  usePreparationFixture,
} from "./support/preparation-harness";

/**
 * `prepare-release` against the histories a release can meet: a merged preparation that missed a later
 * merge, a normal release between two preparations, and candidate metadata that history cannot explain.
 */
describe("prepare-release: history", { timeout: 300_000 }, () => {
  const prep = usePreparationFixture();
  const { state } = prep;
  const codes = (reasons: Array<{ code: string }>) => reasons.map((r) => r.code);

  it("refuses a merged preparation that missed a later merge, and a new preparation lists that merge and the first preparation once each", async () => {
    const { repo, github } = state;
    const { pr32, pr33, pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    expect((await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE])).json.status).toBe("prepared");
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch();

    // #44 merges while the preparation is in review, and the preparation merges without being updated.
    const pr44 = repo.mergePullRequest({ number: 44, title: "fix(invoices): show the settled amount" });
    const first = prep.mergePreparation(43, "chore(release): prepare 0.0.7");

    const stale = await prep.prepare(["--sha", first.mergeSha, "--date", DATE, "--dry-run"]);
    expect(stale.code).toBe(4);
    expect(stale.json).toMatchObject({
      status: "refused",
      version: "0.0.7",
      candidateMetadata: { packageVersion: "0.0.7", relation: "ahead_of_last_normal_release" },
      final: null,
    });
    expect(codes(stale.json.reasons)).toEqual(["prepared_changelog_stale"]);
    expect(stale.json.reasons[0]).toMatchObject({ commit: first.mergeSha, pr: 43 });
    expect(stale.json.reasons[0].detail).toContain("it leaves out #44");

    // A new preparation pull request, from main as it stands, replaces the generated block.
    prep.startBranch("release/v0.0.7-again");
    prep.openPullRequest(46, "chore(release): prepare 0.0.7", "release/v0.0.7-again");
    const again = await prep.prepare(["--sha", first.mergeSha, "--pr", "46", "--date", DATE]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.json).toMatchObject({ status: "prepared", version: "0.0.7" });
    expect(again.json.files.map((f) => [f.path, f.changed])).toEqual([
      ["package.json", false],
      ["package-lock.json", false],
      ["CHANGELOG.md", true],
    ]);
    const expectedSection = section({
      version: "0.0.7",
      base: "v0.0.6",
      pr: 46,
      summary: PATCH_SUMMARY,
      entries: [
        merged(1, 32, "test(settlement): prove the walk-in sale landed", pr32.mergeSha, "test"),
        merged(2, 33, "test: set the yard as well as the ledger", pr33.mergeSha, "test"),
        merged(3, 42, "ci(release): preview releases, tag exact merges and recover missed build tags", pr42.mergeSha, "ci"),
        merged(4, 44, "fix(invoices): show the settled amount", pr44.mergeSha, "fix"),
        merged(5, 43, "chore(release): prepare 0.0.7", first.mergeSha, "chore"),
        preparationEntry(6, 46, "0.0.7"),
      ],
    });
    const text = prep.readWorkingFile("CHANGELOG.md");
    expect(text).toBe(changelog(expectedSection));
    for (const pr of [32, 33, 42, 43, 44, 46]) expect(occurrences(text, `[#${pr}](${PULL(pr)})`), `#${pr}`).toBe(1);

    // Once it merges, the second preparation checks out, and the final notes carry both preparations.
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch("release/v0.0.7-again");
    const second = prep.mergePreparation(46, "chore(release): prepare 0.0.7", "release/v0.0.7-again");
    const check = await prep.prepare(["--sha", second.mergeSha, "--pr", "46", "--date", DATE, "--dry-run"]);
    expect(check.code, check.stderr).toBe(0);
    expect(check.json.status).toBe("already_prepared");
    expect(check.json.final!.merges.map((m) => [m.pr, m.mergeSha])).toEqual([
      [32, pr32.mergeSha],
      [33, pr33.mergeSha],
      [42, pr42.mergeSha],
      [44, pr44.mergeSha],
      [43, first.mergeSha],
      [46, second.mergeSha],
    ]);

    // Naming the first, already merged, preparation for new work is refused.
    prep.updateBranchFromMain();
    const reused = await prep.prepare(["--sha", second.mergeSha, "--pr", "43", "--date", DATE, "--dry-run"]);
    expect(reused.code).toBe(4);
    expect(codes(reused.json.reasons)).toEqual(["preparation_pr_merged"]);
    expect(github.writes()).toEqual([]);
  });

  it("refuses a merged preparation whose version, heading and block a feature merged during review made stale", async () => {
    const { repo } = state;
    const { pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    expect((await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE])).json.status).toBe("prepared");
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch();
    repo.mergePullRequest({ number: 44, title: "feat(invoices): show the settled amount" });
    const stale = prep.mergePreparation(43, "chore(release): prepare 0.0.7");

    const check = await prep.prepare(["--sha", stale.mergeSha, "--date", DATE, "--dry-run"]);
    expect(check.code).toBe(4);
    expect(check.json).toMatchObject({
      version: "0.1.0",
      candidateMetadata: { packageVersion: "0.0.7", relation: "ahead_of_last_normal_release" },
      final: null,
    });
    expect(codes(check.json.reasons)).toEqual([
      "preparation_title_mismatch",
      "prepared_version_stale",
      "prepared_changelog_mismatch",
      "prepared_changelog_stale",
    ]);
    expect(check.json.reasons[1].detail).toBe(
      "preparation #43 set 0.0.7, but the accepted merges through it calculate 0.1.0 from v0.0.6",
    );
  });

  it("refuses a merged preparation that kept another title, and one that is the only change since the release", async () => {
    const { repo } = state;
    const { pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    expect((await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE])).json.status).toBe("prepared");
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch();
    const retitled = prep.mergePreparation(43, "chore: ship the release");
    const titled = await prep.prepare(["--sha", retitled.mergeSha, "--date", DATE, "--dry-run"]);
    expect(titled.code).toBe(4);
    expect(codes(titled.json.reasons)).toEqual(["preparation_title_mismatch"]);
    expect(titled.json.reasons[0].detail).toBe(
      'preparation #43 merged as "chore: ship the release", not "chore(release): prepare 0.0.7"',
    );

    // Released, then a preparation made by hand with nothing else in it.
    repo.tag("v0.0.7", retitled.mergeSha);
    const empty = section({ version: "0.0.8", base: "v0.0.7", pr: 45, summary: PATCH_SUMMARY, entries: [preparationEntry(1, 45, "0.0.8")] });
    const released = repo.gitRaw(["show", `${retitled.mergeSha}:CHANGELOG.md`]);
    const alone = prep.mergeFileChange(45, "chore(release): prepare 0.0.8", {
      "package.json": packageJson("0.0.8"),
      "package-lock.json": lockfile("0.0.8"),
      "CHANGELOG.md": `${CHANGELOG_PREAMBLE}${empty}${released.slice(CHANGELOG_PREAMBLE.length)}`,
    });
    const nothing = await prep.prepare(["--sha", alone.mergeSha, "--date", DATE, "--dry-run"]);
    expect(nothing.code).toBe(4);
    expect(nothing.json.version).toBe("0.0.8");
    expect(codes(nothing.json.reasons)).toEqual(["preparation_without_changes"]);
  });

  it("prepares a later patch from an intervening normal release, leaving the released section, the build tag and every tag as they were", async () => {
    const { repo } = state;
    const { pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    expect((await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE])).json.status).toBe("prepared");
    prep.commitPreparation("chore(release): prepare 0.0.7");
    prep.pushBranch();
    const prepared = prep.mergePreparation(43, "chore(release): prepare 0.0.7");
    // The normal release is published at the preparation's merge, as issue #41 will publish it.
    repo.tag("v0.0.7", prepared.mergeSha);
    const released = repo.gitRaw(["show", `${prepared.mergeSha}:CHANGELOG.md`]);

    // A released merge has nothing left to prepare, and its metadata is the last normal release.
    const done = await prep.prepare(["--sha", prepared.mergeSha, "--date", DATE, "--dry-run"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.json).toMatchObject({
      status: "nothing_to_prepare",
      version: null,
      lastNormalRelease: { tag: "v0.0.7", commit: prepared.mergeSha },
      candidateMetadata: { packageVersion: "0.0.7", relation: "last_normal_release" },
    });

    // A patch merges and earns its build tag. The ordinal stays in the tag.
    const pr45 = repo.mergePullRequest({ number: 45, title: "fix(invoices): show the settled amount" });
    const run = prep.fixture.ci(pr45.mergeSha);
    const built = await prep.fixture.tagBuild(pr45.mergeSha, run);
    expect(built.publication.json).toMatchObject({ decision: "tagged", tag: { name: "v0.0.8-dev.1" } });
    const tagsBefore = prep.fixture.remoteTags();
    expect(tagsBefore).toContain("v0.0.6 tag");
    expect(tagsBefore).toContain("v0.0.7 tag");

    prep.startBranch("release/v0.0.8");
    prep.openPullRequest(46, "chore(release): prepare 0.0.8", "release/v0.0.8");
    const later = await prep.prepare(["--sha", pr45.mergeSha, "--pr", "46", "--date", "2026-10-01"]);
    expect(later.code, later.stderr).toBe(0);
    expect(later.json).toMatchObject({
      status: "prepared",
      version: "0.0.8",
      lastNormalRelease: { tag: "v0.0.7", commit: prepared.mergeSha, version: "0.0.7" },
      candidateMetadata: { packageVersion: "0.0.7", relation: "last_normal_release" },
    });
    expect(later.json.merges.map((m) => m.pr)).toEqual([45]);

    const patchSection = section({
      version: "0.0.8",
      base: "v0.0.7",
      pr: 46,
      date: "2026-10-01",
      summary: PATCH_SUMMARY,
      entries: [merged(1, 45, "fix(invoices): show the settled amount", pr45.mergeSha, "fix"), preparationEntry(2, 46, "0.0.8")],
    });
    const files = prep.workingFiles();
    expect(files).toEqual({
      package: packageJson("0.0.8"),
      lockfile: lockfile("0.0.8"),
      changelog: `${CHANGELOG_PREAMBLE}${patchSection}${released.slice(CHANGELOG_PREAMBLE.length)}`,
    });
    expect(`${files.package}${files.lockfile}`).not.toContain("-dev");
    // Every accepted merge is in exactly one release's section.
    for (const pr of [32, 33, 42, 43, 45, 46]) expect(occurrences(files.changelog!, `[#${pr}](${PULL(pr)})`), `#${pr}`).toBe(1);

    expect(prep.fixture.remoteTags()).toBe(tagsBefore);
    expect(prep.inCheckout("for-each-ref", "--format=%(refname:strip=2) %(objecttype) %(objectname) %(*objectname)", "refs/tags")).toBe(tagsBefore);
  });

  it("refuses candidate metadata that history cannot explain, and leaves the working tree as it was", async () => {
    const { github } = state;
    prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    const before = { ...prep.snapshot(), files: prep.workingFiles(), status: prep.status() };
    const rootOnly = lockfile("0.0.6").replace('"version": "0.0.6",\n      "dependencies"', '"version": "0.0.7",\n      "dependencies"');
    const handWritten = "## [0.0.7] — 2026-09-20\n\nWritten by hand.\n\n";

    const cases: Array<{ pr: number; files: Record<string, string>; code: string; detail: string }> = [
      {
        pr: 44,
        files: { "package.json": packageJson("0.0.9") },
        code: "candidate_metadata_inconsistent",
        detail: "package.json says 0.0.9, but package-lock.json says 0.0.6 and its root package 0.0.6",
      },
      {
        pr: 45,
        files: { "package.json": packageJson("0.0.6"), "package-lock.json": rootOnly },
        code: "candidate_metadata_inconsistent",
        detail: "package-lock.json says 0.0.6 and its root package 0.0.7",
      },
      {
        pr: 46,
        files: { "package.json": packageJson("0.0.9"), "package-lock.json": lockfile("0.0.9") },
        code: "candidate_metadata_inconsistent",
        detail: "0.0.9 is neither the last normal release 0.0.6 nor an unreleased preparation from v0.0.6 no higher than 0.0.7",
      },
      {
        pr: 47,
        files: { "package.json": packageJson("0.0.7-dev.1"), "package-lock.json": lockfile("0.0.7-dev.1") },
        code: "candidate_version_not_normal",
        detail: "build tags and their ordinals never enter package metadata",
      },
      {
        pr: 48,
        files: { "package.json": packageJson("0.1.0"), "package-lock.json": lockfile("0.1.0") },
        code: "candidate_metadata_inconsistent",
        detail: "0.1.0 is neither the last normal release 0.0.6 nor an unreleased preparation from v0.0.6 no higher than 0.0.7",
      },
      {
        pr: 49,
        files: { "package.json": packageJson("0.0.7"), "package-lock.json": lockfile("0.0.7") },
        code: "candidate_metadata_inconsistent",
        detail: "CHANGELOG.md has 0.0.6 as its newest release, but the package version is 0.0.7",
      },
      {
        pr: 50,
        files: { "CHANGELOG.md": changelog(handWritten) },
        code: "candidate_metadata_inconsistent",
        detail: "CHANGELOG.md has a 0.0.7 section that is not a preparation's from v0.0.6",
      },
      {
        pr: 51,
        files: { "package.json": packageJson("0.0.6"), "package-lock.json": lockfile("0.0.6") },
        code: "candidate_metadata_inconsistent",
        detail: "CHANGELOG.md has 0.0.7 as its newest release, but the package version is the last normal release, 0.0.6",
      },
      {
        pr: 52,
        files: { "CHANGELOG.md": changelog("## [0.0.5] — 2026-09-30\n\nOut of order.\n\n") },
        code: "candidate_metadata_inconsistent",
        detail: "CHANGELOG.md lists 0.0.5 above 0.0.6",
      },
      {
        pr: 53,
        files: { "package.json": "{ not json" },
        code: "candidate_metadata_unreadable",
        detail: "package.json is not JSON",
      },
      {
        pr: 54,
        files: {
          "package.json": packageJson("0.0.7"),
          "package-lock.json": lockfile("0.0.7"),
          "CHANGELOG.md": changelog(section({ version: "0.0.7", base: "v0.0.5", pr: 43, summary: PATCH_SUMMARY, entries: [] })),
        },
        code: "candidate_metadata_inconsistent",
        detail: "CHANGELOG.md has a 0.0.7 section that is not a preparation's from v0.0.6",
      },
    ];

    for (const { pr, files, code, detail } of cases) {
      const merge = prep.mergeFileChange(pr, `fix: change the metadata (${pr})`, files);
      for (const extra of [["--pr", "43"], ["--dry-run"]]) {
        const run = await prep.prepare(["--sha", merge.mergeSha, "--date", DATE, ...extra]);
        expect(run.code, `#${pr} ${run.stderr}`).toBe(4);
        expect(run.json.status, `#${pr}`).toBe("refused");
        expect(codes(run.json.reasons), `#${pr}`).toContain(code);
        expect(run.json.reasons.map((r) => r.detail).join("\n"), `#${pr}`).toContain(detail);
        expect(run.json.reasons.every((r) => r.commit === merge.mergeSha), `#${pr}`).toBe(true);
        expect(run.json.files, `#${pr}`).toEqual([]);
        expect(run.json.changelogSection, `#${pr}`).toBeNull();
      }
      expect({ ...prep.snapshot(), remoteRefs: before.remoteRefs, files: prep.workingFiles(), status: prep.status() }, `#${pr}`).toEqual(
        before,
      );
    }
    expect(github.writes()).toEqual([]);
  });
});
