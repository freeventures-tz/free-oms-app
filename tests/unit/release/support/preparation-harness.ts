import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPOSITORY, useBuildFixture, type BuildReason } from "./build-harness";
import { runController, type ControllerRun } from "./run-controller";

export { REPOSITORY };
export const PULL = (n: number) => `https://github.com/${REPOSITORY}/pull/${n}`;
export const COMMIT = (sha: string) => `https://github.com/${REPOSITORY}/commit/${sha}`;
export const BRANCH = "release/v0.0.7";
export const DATE = "2026-09-20";

/** The three files a preparation may change, by their names in the report. */
export const METADATA_FILES = { package: "package.json", lockfile: "package-lock.json", changelog: "CHANGELOG.md" } as const;
export type MetadataFiles = Record<keyof typeof METADATA_FILES, string | null>;

/**
 * package.json as npm writes it. Anything besides `version` must survive a preparation byte for byte,
 * so the fixture carries more than a version.
 */
export const packageJson = (version: string, extra = "") =>
  `{\n  "name": "free-oms-app",\n  "version": "${version}",\n  "private": true,${extra}\n  "scripts": {\n    "build": "next build"\n  }\n}\n`;

/**
 * A lockfile whose root package carries the version twice, beside a dependency that happens to have the
 * same version string. Only the two root fields belong to the application.
 */
export const lockfile = (version: string) =>
  [
    "{",
    '  "name": "free-oms-app",',
    `  "version": "${version}",`,
    '  "lockfileVersion": 3,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {',
    '      "name": "free-oms-app",',
    `      "version": "${version}",`,
    '      "dependencies": {',
    '        "left-pad": "0.0.6"',
    "      }",
    "    },",
    '    "node_modules/left-pad": {',
    '      "version": "0.0.6",',
    '      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-0.0.6.tgz",',
    '      "integrity": "sha512-fixture"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

export const CHANGELOG_PREAMBLE = "# Changelog\n\nWhat each release of Free Ventures OMS adds, in plain language.\n\n";

/** The released sections, written by hand, as this repository's changelog is. */
export const RELEASED_SECTIONS = [
  "## [0.0.6] — 2026-09-09",
  "",
  "**Stock that has been sold stays sold.** A batch cannot consume what a customer has paid for.",
  "",
  "### Fixed",
  "",
  "- A downward stock correction is refused on the same rule.",
  "",
  "## [0.0.5] — 2026-09-02",
  "",
  "**Making bricks.**",
  "",
].join("\n");

export const changelog = (pending = "") => `${CHANGELOG_PREAMBLE}${pending}${RELEASED_SECTIONS}`;

/**
 * One accepted merge as the changelog lists it. These builders are written out from the format issue #40
 * reviews, not generated the way the controller generates it.
 */
export const merged = (n: number, pr: number, title: string, sha: string, type: string, change = "patch") =>
  `${n}. **${title}** — [#${pr}](${PULL(pr)}) · merge [\`${sha.slice(0, 7)}\`](${COMMIT(sha)}) · \`${type}\` → ${change}`;

export const preparationEntry = (n: number, pr: number, version: string) =>
  `${n}. **chore(release): prepare ${version}** — [#${pr}](${PULL(pr)}) · this release's preparation · \`chore\` → patch`;

/** A generated changelog section, heading to end marker, and the blank line after it. */
export const section = (options: {
  version: string;
  base: string;
  pr: number;
  date?: string;
  summary: string;
  entries: string[];
  between?: string[];
}) =>
  [
    `## [${options.version}] — ${options.date ?? DATE}`,
    "",
    ...(options.between ?? []),
    `<!-- release-controller:begin version=${options.version} base=${options.base} preparation=${options.pr} -->`,
    `Generated from every accepted merge after \`${options.base}\`. Each preparation replaces the lines between these markers; write prose above or below them.`,
    "",
    options.summary,
    "",
    `### Accepted merges (${options.entries.length})`,
    "",
    ...options.entries,
    "<!-- release-controller:end -->",
    "",
    "",
  ].join("\n");

export const PATCH_SUMMARY = "Version policy 0.x. Highest change: patch. No breaking change and no deprecation.";

export type PreparationFile = {
  path: string;
  before: Record<string, string | null> | null;
  after: Record<string, string | null> | null;
  changed: boolean;
  written: boolean;
};

export type PreparationMerge = { pr: number; mergeSha: string; title: string; change: string };

export type PreparationReport = {
  command: string;
  status: string;
  mode: string;
  publication: string;
  repository: string;
  sha: string;
  mainRef: string;
  main: string | null;
  branch: string | null;
  lastNormalRelease: { tag: string; tagObject: string; commit: string; version: string } | null;
  candidateMetadata: {
    packageVersion: string | null;
    lockfileVersion: string | null;
    lockfileRootVersion: string | null;
    changelogVersion: string | null;
    relation: string;
  } | null;
  version: string | null;
  policy: string | null;
  highestChange: string | null;
  notesDigest: string | null;
  preparation: { pr: number | null; url: string | null; title: string; date: string } | null;
  merges: PreparationMerge[];
  files: PreparationFile[];
  changelogSection: string | null;
  notes: string | null;
  final: {
    sha: string;
    version: string;
    notesDigest: string;
    merges: Array<{ pr: number; mergeSha: string; title: string }>;
    notes: string;
  } | null;
  reasons: BuildReason[];
};

export type PreparationRun = ControllerRun & { json: PreparationReport };

/** How many times a string occurs in another. */
export function occurrences(text: string, fragment: string) {
  return text.split(fragment).length - 1;
}

/**
 * The build fixture — GitHub's copy, a separate checkout and the simulator — plus what a release
 * preparation needs: application metadata in history, a preparation branch in the checkout, and the
 * preparation pull request on GitHub. Call inside a `describe`.
 */
export function usePreparationFixture() {
  const fixture = useBuildFixture();
  const { state } = fixture;

  const inCheckout = (...args: string[]) => state.checkout.git(...args);

  const toJson = async (run: Promise<ControllerRun>): Promise<PreparationRun> => {
    const result = await run;
    let json: PreparationReport | null = null;
    try {
      json = JSON.parse(result.stdout) as PreparationReport;
    } catch {
      json = null;
    }
    return { ...result, json: json as PreparationReport };
  };

  const args = (extra: string[], path = state.checkout.dir) => [
    "prepare-release",
    "--repo",
    REPOSITORY,
    "--main-ref",
    "origin/main",
    "--path",
    path,
    ...extra,
  ];

  return {
    fixture,
    state,
    inCheckout,

    /** Metadata at 0.0.6, v0.0.6 at merge #30, then #32, #33 and #42: main as it stands since the last release. */
    history() {
      const { repo } = state;
      repo.commitFiles(
        { "package.json": packageJson("0.0.6"), "package-lock.json": lockfile("0.0.6"), "CHANGELOG.md": changelog() },
        "chore: add release metadata",
      );
      const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
      repo.tag("v0.0.6", released.mergeSha);
      const pr32 = repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
      const pr33 = repo.mergePullRequest({ number: 33, title: "test: set the yard as well as the ledger" });
      const pr42 = repo.mergePullRequest({
        number: 42,
        title: "ci(release): preview releases, tag exact merges and recover missed build tags",
      });
      return { released, pr32, pr33, pr42 };
    },

    /** A pull request that changes files on main, merged the way this repository merges. */
    mergeFileChange(number: number, title: string, files: Record<string, string>) {
      const { repo } = state;
      const branch = `pr-${number}`;
      repo.git("checkout", "-q", "-b", branch, "main");
      repo.commitFiles(files, title);
      repo.git("checkout", "-q", "main");
      return repo.mergeExistingBranch({ number, branch, title });
    },

    /** A preparation branch in the checkout, started from origin/main as it is on GitHub now. */
    startBranch(name = BRANCH, from = "origin/main") {
      state.checkout.sync();
      inCheckout("switch", "-q", "-c", name, from);
    },

    /** Commits the three metadata files in the checkout. */
    commitPreparation(message = "chore(release): prepare the release") {
      inCheckout("add", "--", ...Object.values(METADATA_FILES));
      inCheckout("commit", "-q", "--allow-empty", "-m", message);
      return inCheckout("rev-parse", "HEAD");
    },

    /** Brings the current preparation branch up to date with main, as `git merge origin/main` does. */
    updateBranchFromMain() {
      state.checkout.sync();
      inCheckout("merge", "-q", "--no-edit", "origin/main");
    },

    /** Pushes the preparation branch to GitHub's copy. */
    pushBranch(name = BRANCH) {
      inCheckout("push", "-q", "origin", `${name}:${name}`);
    },

    /** An open pull request for a branch, as GitHub reports it before merge. */
    openPullRequest(number: number, title: string, branch = BRANCH) {
      state.github.pulls.set(number, {
        number,
        state: "open",
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        title,
        body: null,
        labels: [],
        head: { sha: inCheckout("rev-parse", "HEAD"), ref: branch, repo: { full_name: REPOSITORY } },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
      });
    },

    /** Merges the pushed preparation branch on GitHub's copy. */
    mergePreparation(number: number, title: string, branch = BRANCH) {
      return state.repo.mergeExistingBranch({ number, branch, title });
    },

    /** The three files in the checkout; one that is missing or not a file is null. */
    workingFiles(): MetadataFiles {
      const read = (name: string) => {
        const path = join(state.checkout.dir, name);
        return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null;
      };
      return {
        package: read(METADATA_FILES.package),
        lockfile: read(METADATA_FILES.lockfile),
        changelog: read(METADATA_FILES.changelog),
      };
    },

    writeWorkingFile(name: string, text: string) {
      writeFileSync(join(state.checkout.dir, name), text);
    },

    readWorkingFile(name: string) {
      return readFileSync(join(state.checkout.dir, name), "utf8");
    },

    /**
     * Everything a preparation must not change: GitHub's refs, the checkout's branches and tags, its HEAD
     * and its index. The checkout's remote-tracking refs are left out; fetching moves them, not the command.
     */
    snapshot() {
      return {
        remoteRefs: state.repo.refs(),
        checkoutRefs: inCheckout("for-each-ref", "--format=%(refname) %(objectname) %(*objectname)", "refs/heads", "refs/tags"),
        head: inCheckout("rev-parse", "HEAD"),
        index: inCheckout("ls-files", "--stage"),
      };
    },

    /** What the checkout's working tree and index hold beyond HEAD. */
    status() {
      return {
        modified: inCheckout("diff", "--name-only"),
        staged: inCheckout("diff", "--cached", "--name-only"),
        untracked: inCheckout("ls-files", "--others", "--exclude-standard"),
      };
    },

    /** Runs `prepare-release` against the checkout, after fetching what GitHub has. */
    prepare(extra: string[], options: { sync?: boolean; path?: string } = {}) {
      if (options.sync !== false) state.checkout.sync();
      return toJson(runController([...args(extra, options.path), "--format", "json"], { env: fixture.environment(null) }));
    },

    prepareMarkdown(extra: string[], options: { sync?: boolean } = {}) {
      if (options.sync !== false) state.checkout.sync();
      return runController(args(extra), { env: fixture.environment(null) });
    },

    /** `preview` against the checkout. */
    preview(sha: string) {
      state.checkout.sync();
      return toJson(
        runController(
          ["preview", "--repo", REPOSITORY, "--main-ref", "origin/main", "--path", state.checkout.dir, "--sha", sha, "--format", "json"],
          { env: fixture.environment(null) },
        ),
      ) as unknown as Promise<ControllerRun & { json: Record<string, unknown> }>;
    },
  };
}
