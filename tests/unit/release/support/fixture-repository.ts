import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GitHubSimulator, SimulatedPull } from "./github-simulator";

/**
 * A disposable Git repository whose history is built the way this repository's is: pull requests
 * merged into `main` as two-parent merge commits whose body keeps the PR title.
 *
 * Every merge helper registers the matching pull request with the GitHub simulator, so a fixture
 * and its API answers cannot drift apart. Git runs with an empty global configuration and fixed
 * dates, so a developer's signing or line-ending settings cannot change what is built.
 */
export function createFixtureRepository(repository: string, github: GitHubSimulator) {
  const dir = mkdtempSync(join(tmpdir(), "release-fixture-"));
  const configDir = mkdtempSync(join(tmpdir(), "release-fixture-config-"));
  const globalConfig = join(configDir, "gitconfig");
  writeFileSync(
    globalConfig,
    "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n",
  );

  let tick = 0;
  let files = 0;

  const env = (): NodeJS.ProcessEnv => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(clean)) {
      if (/^(GIT_|GITHUB_|GH_)/i.test(key)) delete clean[key];
    }
    tick += 1;
    const date = `${1_780_000_000 + tick * 60} +0300`;
    return {
      ...clean,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  };

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: env(), encoding: "utf8" }).trim();

  /** Git with standard input and untrimmed output, quiet on failure: what the GitHub simulator serves Git data with. */
  const gitRaw = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, env: env(), encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

  const commit = (message: string) => {
    files += 1;
    writeFileSync(join(dir, `change-${files}.txt`), `${message}\n${files}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "-q", "-b", "main");
  const root = commit("chore: start the fixture");

  const pullFor = (number: number, headSha: string, title: string, body: string | null): SimulatedPull => ({
    number,
    state: "closed",
    merged: true,
    merged_at: "2026-09-13T09:00:00Z",
    merge_commit_sha: null,
    title,
    body,
    labels: [],
    head: { sha: headSha, ref: `pr-${number}`, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  });

  const fixture = {
    dir,
    root,
    git,
    gitRaw,
    commit,

    /** Commits one file with exact contents. */
    commitFile(name: string, contents: string, message: string) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), contents);
      git("add", "--", name);
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },

    /** Commits several files with exact contents, in one commit. */
    commitFiles(contents: Record<string, string>, message: string) {
      for (const [name, text] of Object.entries(contents)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      git("add", "--", ...Object.keys(contents));
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },

    /**
     * A separate clone, standing in for a workflow's checkout: its own object store, and only what
     * `sync` fetched. Tags created in this repository afterwards are not in it until the next sync.
     */
    clone() {
      const checkoutDir = mkdtempSync(join(tmpdir(), "release-checkout-"));
      git("clone", "-q", dir, checkoutDir);
      const inCheckout = (...args: string[]) => git("-C", checkoutDir, ...args);
      return {
        dir: checkoutDir,
        git: inCheckout,
        /** What a full-history checkout sees: every branch as origin/*, and every tag exactly as GitHub has it. */
        sync() {
          inCheckout(
            "fetch",
            "-q",
            "--prune",
            "--prune-tags",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
            "+refs/tags/*:refs/tags/*",
          );
        },
        cleanup() {
          rmSync(checkoutDir, { recursive: true, force: true });
        },
      };
    },

    /**
     * Merges a pull request the way `gh pr merge --merge` does on this repository: a two-parent merge
     * whose subject is GitHub's and whose body is the retained message — the PR title unless the
     * merger supplied more.
     */
    mergePullRequest(options: {
      number: number;
      title: string;
      description?: string;
      retainedBody?: string;
      commits?: string[];
    }) {
      const branch = `pr-${options.number}`;
      git("checkout", "-q", "-b", branch, "main");
      const developmentCommits = (options.commits ?? [options.title]).map((message) => commit(message));
      git("checkout", "-q", "main");
      const body = options.retainedBody ?? options.title;
      git(
        "merge",
        "--no-ff",
        "-q",
        "-m",
        `Merge pull request #${options.number} from fixture/${branch}\n\n${body}`,
        branch,
      );
      const mergeSha = git("rev-parse", "HEAD");
      const headSha = developmentCommits[developmentCommits.length - 1];
      const pull = pullFor(options.number, headSha, options.title, options.description ?? null);
      pull.merge_commit_sha = mergeSha;
      github.pulls.set(options.number, pull);
      return { number: options.number, mergeSha, headSha, developmentCommits, pull };
    },

    /**
     * Merges a branch that already exists here, as `gh pr merge --merge` would merge its pull request.
     * The pull request is recorded as merged, whatever the simulator held for it before.
     */
    mergeExistingBranch(options: { number: number; branch: string; title: string; retainedBody?: string }) {
      const developmentCommits = git("rev-list", "--reverse", `main..${options.branch}`).split("\n").filter(Boolean);
      const headSha = git("rev-parse", options.branch);
      git(
        "merge",
        "--no-ff",
        "-q",
        "-m",
        `Merge pull request #${options.number} from fixture/${options.branch}\n\n${options.retainedBody ?? options.title}`,
        options.branch,
      );
      const mergeSha = git("rev-parse", "HEAD");
      const pull = pullFor(options.number, headSha, options.title, null);
      pull.head.ref = options.branch;
      pull.merge_commit_sha = mergeSha;
      github.pulls.set(options.number, pull);
      return { number: options.number, mergeSha, headSha, developmentCommits, pull };
    },

    /** A squash merge: one ordinary commit on main that GitHub still associates with the PR. */
    squashPullRequest(options: { number: number; title: string }) {
      const branch = `pr-${options.number}`;
      git("checkout", "-q", "-b", branch, "main");
      const headSha = commit(options.title);
      git("checkout", "-q", "main");
      const sha = commit(`${options.title} (#${options.number})`);
      const pull = pullFor(options.number, headSha, options.title, null);
      pull.merge_commit_sha = sha;
      github.pulls.set(options.number, pull);
      github.commitPulls.set(sha, [options.number]);
      return { sha, headSha };
    },

    /** A merge made locally rather than through a pull request. */
    mergeBranchLocally(branchCommits: string[], message: string) {
      files += 1;
      const branch = `local-${files}`;
      git("checkout", "-q", "-b", branch, "main");
      for (const m of branchCommits) commit(m);
      git("checkout", "-q", "main");
      git("merge", "--no-ff", "-q", "-m", message, branch);
      return git("rev-parse", "HEAD");
    },

    /** A three-parent merge. */
    octopusMerge(message: string) {
      files += 1;
      const one = `octopus-a-${files}`;
      const two = `octopus-b-${files}`;
      git("checkout", "-q", "-b", one, "main");
      commit("docs: one side");
      git("checkout", "-q", "-b", two, "main");
      commit("docs: other side");
      git("checkout", "-q", "main");
      git("merge", "--no-ff", "-q", "-m", message, one, two);
      return git("rev-parse", "HEAD");
    },

    /** A commit on a branch that never reaches main. */
    unmergedCommit(message: string) {
      files += 1;
      git("checkout", "-q", "-b", `unmerged-${files}`, "main");
      const sha = commit(message);
      git("checkout", "-q", "main");
      return sha;
    },

    tag(name: string, target: string, message = `${name}\n\nFixture release.`) {
      git("tag", "-a", name, "-m", message, target);
    },

    lightweightTag(name: string, target: string) {
      git("tag", name, target);
    },

    head() {
      return git("rev-parse", "HEAD");
    },

    /** Every ref with its object and peeled object: the inventory a run must leave untouched. */
    refs() {
      return git("for-each-ref", "--format=%(refname) %(objecttype) %(objectname) %(*objectname)");
    },

    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    },
  };

  return fixture;
}

export type FixtureRepository = ReturnType<typeof createFixtureRepository>;
export type FixtureCheckout = ReturnType<FixtureRepository["clone"]>;
