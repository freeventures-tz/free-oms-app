// @vitest-environment node
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BRANCH,
  changelog,
  DATE,
  lockfile,
  merged,
  METADATA_FILES,
  packageJson,
  PATCH_SUMMARY,
  preparationEntry,
  section,
  usePreparationFixture,
  type PreparationRun,
} from "./support/preparation-harness";
import { TOKEN } from "./support/build-harness";

/**
 * What `prepare-release` refuses, and what it keeps. A refusal or a failed write leaves the working tree,
 * the index, every ref and GitHub exactly as they were; a preparation keeps everything it does not own.
 */
describe("prepare-release: refusals and supplied content", { timeout: 300_000 }, () => {
  const prep = usePreparationFixture();
  const { state } = prep;
  const codes = (run: PreparationRun) => run.json.reasons.map((r) => r.code);
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const extraField = '\n  "description": "a local edit, not committed",';
  const temporaryFiles = () => readdirSync(state.checkout.dir).filter((name) => name.endsWith(".release-preparation.tmp"));

  it("keeps line endings, unrelated fields and unrelated files exactly as supplied", async () => {
    const { pr32, pr33, pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    prep.writeWorkingFile("package.json", crlf(packageJson("0.0.6", extraField)));
    prep.writeWorkingFile("package-lock.json", crlf(lockfile("0.0.6")));
    prep.writeWorkingFile("CHANGELOG.md", crlf(changelog()));
    prep.writeWorkingFile("notes.txt", "scratch notes, not part of the release\n");

    const run = await prep.prepare(["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.json.status).toBe("prepared");
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
      package: crlf(packageJson("0.0.7", extraField)),
      lockfile: crlf(lockfile("0.0.7")),
      changelog: crlf(changelog(expectedSection)),
    });
    // The report shows the section as text, whatever the file's line endings.
    expect(run.json.changelogSection).toBe(expectedSection);
    expect(prep.readWorkingFile("notes.txt")).toBe("scratch notes, not part of the release\n");
    expect(prep.status().untracked).toBe("notes.txt");
    expect(temporaryFiles()).toEqual([]);
  });

  it("refuses every precondition it cannot satisfy, and a refused or failed run changes nothing", async () => {
    const { repo, github } = state;
    const { pr42 } = prep.history();
    prep.startBranch();
    prep.openPullRequest(43, "chore(release): prepare 0.0.7");
    prep.writeWorkingFile("notes.txt", "scratch notes\n");
    const pull = github.pulls.get(43)!;
    const write = (extra: string[] = []) => ["--sha", pr42.mergeSha, "--pr", "43", "--date", DATE, ...extra];

    /** Runs a command and requires that nothing it can reach changed. */
    const unchanged = async (run: () => Promise<PreparationRun>) => {
      const capture = () => ({
        ...prep.snapshot(),
        files: prep.workingFiles(),
        notes: prep.readWorkingFile("notes.txt"),
        status: prep.status(),
        temporary: temporaryFiles(),
        writes: github.writes().length,
      });
      const before = capture();
      const result = await run();
      expect(capture()).toEqual(before);
      expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
      return result;
    };
    const refused = async (args: string[], expected: string[], options: { path?: string } = {}) => {
      const run = await unchanged(() => prep.prepare(args, options));
      expect(run.code, `${args.join(" ")}\n${run.stderr}`).toBe(4);
      expect(run.json.status).toBe("refused");
      expect(codes(run), args.join(" ")).toEqual(expected);
      expect(run.json.files).toEqual([]);
      return run;
    };

    // The pull request must be this branch's open preparation for main, titled for the version.
    await refused(write().map((a) => (a === "43" ? "99" : a)), ["preparation_pr_missing"]);
    await refused(write().map((a) => (a === "43" ? "42" : a)), ["preparation_pr_merged"]);
    pull.state = "closed";
    expect((await refused(write(), ["preparation_pr_mismatch"])).json.reasons[0].detail).toContain("it is closed, not open");
    pull.state = "open";
    pull.base.ref = "develop";
    expect((await refused(write(), ["preparation_pr_mismatch"])).json.reasons[0].detail).toContain("its base is");
    pull.base.ref = "main";
    pull.head.ref = "someone-elses-branch";
    expect((await refused(write(), ["preparation_pr_mismatch"])).json.reasons[0].detail).toContain(
      `its head branch is someone-elses-branch, not the checkout's ${BRANCH}`,
    );
    pull.head.ref = BRANCH;
    pull.head.repo = { full_name: "someone/fork" };
    expect((await refused(write(), ["preparation_pr_mismatch"])).json.reasons[0].detail).toContain("its head is in someone/fork");
    pull.head.repo = { full_name: "freeventures-tz/free-oms-app" };
    pull.title = "chore: prepare the release";
    await refused(write(), ["preparation_title_mismatch"]);
    pull.title = "chore(release): prepare 0.0.7";

    // It writes on its own branch, which holds the candidate and nothing but release metadata.
    prep.inCheckout("switch", "-q", "--detach");
    await refused(write(), ["preparation_branch_required"]);
    prep.inCheckout("switch", "-q", "main");
    prep.inCheckout("merge", "-q", "--ff-only", "origin/main");
    await refused(write(), ["preparation_on_main", "preparation_pr_mismatch"]);
    prep.inCheckout("switch", "-q", BRANCH);
    const stray = join(state.checkout.dir, "stray.txt");
    prep.writeWorkingFile("stray.txt", "not release metadata\n");
    prep.inCheckout("add", "stray.txt");
    prep.inCheckout("commit", "-q", "-m", "chore: slip something in");
    expect((await refused(write(), ["branch_has_other_changes"])).json.reasons[0].detail).toContain("stray.txt");
    prep.inCheckout("reset", "-q", "--hard", "HEAD~1");
    expect(existsSync(stray)).toBe(false);
    mkdirSync(join(state.checkout.dir, "sub"));
    prep.writeWorkingFile("sub/placeholder.txt", "x\n");
    await refused(write(), ["working_tree_required"], { path: join(state.checkout.dir, "sub") });
    rmSync(join(state.checkout.dir, "sub"), { recursive: true });

    // The working metadata must be the candidate's, or a preparation this branch already made.
    const original = prep.workingFiles();
    const workingCases = [
      { key: "package", text: packageJson("0.0.9"), code: "working_metadata_inconsistent" },
      { key: "lockfile", text: lockfile("0.0.7"), code: "working_metadata_inconsistent" },
      { key: "changelog", text: changelog("## [0.0.7] — 2026-09-20\n\nWritten by hand.\n\n"), code: "working_metadata_inconsistent" },
      { key: "package", text: "{", code: "working_metadata_unreadable" },
    ] as const;
    for (const { key, text, code } of workingCases) {
      prep.writeWorkingFile(METADATA_FILES[key], text);
      await refused(write(), [code]);
      prep.writeWorkingFile(METADATA_FILES[key], original[key]!);
    }
    rmSync(join(state.checkout.dir, "package-lock.json"));
    await refused(write(), ["working_metadata_unreadable"]);
    prep.writeWorkingFile("package-lock.json", original.lockfile!);

    // Three files that agree on a version history does not explain are not overwritten either.
    prep.writeWorkingFile("package.json", packageJson("0.0.9"));
    prep.writeWorkingFile("package-lock.json", lockfile("0.0.9"));
    prep.writeWorkingFile(
      "CHANGELOG.md",
      changelog(section({ version: "0.0.9", base: "v0.0.6", pr: 43, summary: PATCH_SUMMARY, entries: [preparationEntry(1, 43, "0.0.9")] })),
    );
    expect((await refused(write(), ["working_metadata_inconsistent"])).json.reasons[0].detail).toBe(
      "in the working tree, package.json says 0.0.9, which is neither the candidate's 0.0.6 nor a preparation from v0.0.6 no higher than 0.0.7",
    );
    prep.writeWorkingFile("package.json", original.package!);
    prep.writeWorkingFile("package-lock.json", original.lockfile!);
    prep.writeWorkingFile("CHANGELOG.md", original.changelog!);

    // A file in the way of a write stops it before any file is replaced, and is left where it was.
    prep.writeWorkingFile("CHANGELOG.md.release-preparation.tmp", "someone else's file\n");
    const blocked = await unchanged(() => prep.prepare(write()));
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe("");
    expect(blocked.stderr).toContain("preparation_not_written");
    expect(blocked.stderr).toContain("nothing was written");
    expect(prep.readWorkingFile("CHANGELOG.md.release-preparation.tmp")).toBe("someone else's file\n");
    rmSync(join(state.checkout.dir, "CHANGELOG.md.release-preparation.tmp"));

    // Bytes that are not UTF-8, or a directory where a file belongs, stop the run before anything is written.
    const changelogPath = join(state.checkout.dir, "CHANGELOG.md");
    appendFileSync(changelogPath, Buffer.from([0xff, 0x0a]));
    const bytes = await unchanged(() => prep.prepare(write()));
    expect([bytes.code, bytes.stdout]).toEqual([1, ""]);
    expect(bytes.stderr).toContain("working_file_unreadable: CHANGELOG.md is not UTF-8 text");
    prep.writeWorkingFile("CHANGELOG.md", original.changelog!);
    renameSync(changelogPath, `${changelogPath}.aside`);
    mkdirSync(changelogPath);
    const directory = await unchanged(() => prep.prepare(write()));
    expect([directory.code, directory.stdout]).toEqual([1, ""]);
    expect(directory.stderr).toContain("working_file_unreadable: CHANGELOG.md is not a regular file");
    rmSync(changelogPath, { recursive: true });
    renameSync(`${changelogPath}.aside`, changelogPath);

    // With nothing in the way, the same preparation succeeds: every refusal above was its own.
    const prepared = await prep.prepare(write());
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(prepared.json.status).toBe("prepared");
    prep.commitPreparation("chore(release): prepare 0.0.7");

    // Stale views of GitHub stop the run before anything is decided.
    repo.lightweightTag("unrelated", repo.root);
    const tags = await unchanged(() => prep.prepare(write(), { sync: false }));
    expect(tags.code).toBe(1);
    expect(tags.stdout).toBe("");
    expect(tags.stderr).toContain("tag_state_out_of_date");
    state.checkout.sync();
    const pr44 = repo.mergePullRequest({ number: 44, title: "fix: moves main on GitHub" });
    const main = await unchanged(() => prep.prepare(write(), { sync: false }));
    expect(main.code).toBe(1);
    expect(main.stdout).toBe("");
    expect(main.stderr).toContain("main_out_of_date");

    // A version already released elsewhere is not prepared again.
    repo.tag("v0.0.7", repo.unmergedCommit("docs: a release made somewhere else"));
    prep.updateBranchFromMain();
    await refused(["--sha", pr44.mergeSha, "--pr", "43", "--date", DATE], ["target_already_released"]);
    repo.git("tag", "-d", "v0.0.7");
    state.checkout.sync();

    // A direct push on main is an Owner decision, not something to prepare around.
    const pushed = repo.commit("fix: pushed straight to main");
    const pending = await unchanged(() => prep.prepare(["--sha", pushed, "--pr", "43", "--date", DATE]));
    expect(pending.code).toBe(3);
    expect(pending.json.status).toBe("pending_decision");
    expect(codes(pending)).toEqual(["direct_push"]);
    expect(github.writes()).toEqual([]);
  });
});
