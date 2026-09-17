/**
 * The Git the controller reads. Reading commands only: nothing here fetches, writes an object, moves a
 * ref, touches the index or takes an optional lock. Arguments go to `git` as an array, never through a
 * shell.
 */

import { spawnSync } from "node:child_process";

import { ControllerError } from "./errors.mjs";

export function createGitReader(cwd) {
  const run = (args, { exitOneIsAnswer = false } = {}) => {
    const result = spawnSync("git", ["--no-pager", "-c", "core.quotepath=off", "-c", "log.showSignature=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.error) {
      throw new ControllerError("git_unavailable", `could not run git: ${result.error.message}`);
    }
    if (exitOneIsAnswer && result.status === 1) return null;
    if (result.status !== 0) {
      throw new ControllerError(
        "git_failed",
        `git ${args[0]} exited ${result.status}: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  };

  return {
    /** The commit a revision names, or null when it names none. */
    commit(revision) {
      const out = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], {
        exitOneIsAnswer: true,
      });
      return out ? out.trim() : null;
    },

    /** The first-parent line from a commit back to the root: `[{ sha, parents }]`, newest first. */
    firstParentLine(commit) {
      return run(["rev-list", "--first-parent", "--parents", "--end-of-options", commit])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...parents] = line.split(" ");
          return { sha, parents };
        });
    },

    isAncestor(ancestor, descendant) {
      return run(["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant], {
        exitOneIsAnswer: true,
      }) !== null;
    },

    /** The raw message of one commit, line endings normalised. */
    message(commit) {
      return run(["log", "-1", "--format=%B", "--end-of-options", commit]).replace(/\r\n?/g, "\n");
    },

    /** Commits reachable from `to` and not from `from`, oldest first: `[{ sha, subject }]`. */
    commitsBetween(from, to) {
      return run(["log", "--reverse", "--format=%H%x00%s", "--end-of-options", `${from}..${to}`])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, subject] = line.split("\u0000");
          return { sha, subject };
        });
    },

    /** A file's contents in a commit, exactly as stored, or null when the commit has no such file. */
    fileAt(commit, path) {
      const entry = run(["ls-tree", "-z", "--full-tree", "--end-of-options", commit, path]).split("\u0000")[0];
      if (!entry) return null;
      const [mode, type, object] = entry.slice(0, entry.indexOf("\t")).split(" ");
      if (type !== "blob" || mode === "120000") return null;
      return run(["cat-file", "blob", object]);
    },

    /** Paths whose contents differ between two commits. */
    changedPaths(from, to) {
      return run(["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--end-of-options", from, to, "--"])
        .split("\u0000")
        .filter(Boolean);
    },

    /** The branch HEAD names, or null when HEAD is detached. */
    currentBranch() {
      const out = run(["symbolic-ref", "--quiet", "--short", "HEAD"], { exitOneIsAnswer: true });
      return out ? out.trim() : null;
    },

    /** Whether the directory this reader was given is the top level of a working tree. */
    isWorkTreeRoot() {
      if (run(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return false;
      return run(["rev-parse", "--show-cdup"]).trim() === "";
    },

    /** An annotated tag object's `object`, `type` and `tag` headers and its message, exactly as stored. */
    tagObject(objectName) {
      const raw = run(["cat-file", "tag", objectName]);
      const split = raw.indexOf("\n\n");
      const header = split < 0 ? raw : raw.slice(0, split);
      const fields = {};
      for (const line of header.split("\n")) {
        const space = line.indexOf(" ");
        if (space > 0 && !Object.hasOwn(fields, line.slice(0, space))) {
          fields[line.slice(0, space)] = line.slice(space + 1);
        }
      }
      return {
        object: fields.object ?? null,
        type: fields.type ?? null,
        tag: fields.tag ?? null,
        message: split < 0 ? "" : raw.slice(split + 2),
      };
    },

    /** Every tag: its name, what the ref points at, and what that peels to. */
    tags() {
      return run([
        "for-each-ref",
        "--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)",
        "refs/tags",
      ])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, objectType, objectName, peeledType, peeledName] = line.split("\u0000");
          return { name, objectType, objectName, peeledType, peeledName };
        });
    },
  };
}
