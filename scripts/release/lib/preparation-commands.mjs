/**
 * `prepare-release`: arguments, the working-tree writes and the output. The decisions are
 * lib/preparation.mjs's.
 *
 * The command writes three files in the working tree it is pointed at, and nothing else anywhere: no
 * commit, no index change, no push, no tag and no GitHub write. Its GitHub client can only send GET
 * requests.
 */

import { closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readMainRef, readRepository, settings } from "./build-commands.mjs";
import { EXIT, FULL_SHA, json, readFormat, readPositiveInteger, UsageError } from "./cli.mjs";
import { ControllerError } from "./errors.mjs";
import { createGitReader } from "./git.mjs";
import { createGitHubReader } from "./github.mjs";
import { renderPreparationReport } from "./preparation-report.mjs";
import { prepareRelease } from "./preparation.mjs";

const STATUS_EXIT = Object.freeze({
  prepared: EXIT.ok,
  would_prepare: EXIT.ok,
  already_prepared: EXIT.ok,
  nothing_to_prepare: EXIT.ok,
  pending_decision: EXIT.pending,
  refused: EXIT.refused,
});

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date, `YYYY-MM-DD`, that exists. */
function readDate(value) {
  const day = typeof value === "string" && DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || !day.toISOString().startsWith(value)) {
    throw new UsageError("--date is required: the planned release date, as YYYY-MM-DD");
  }
  return value;
}

/** The suffix of the file each new text is written to before it replaces its target. */
const TEMPORARY = ".release-preparation.tmp";

/** Decodes UTF-8 and refuses anything else. A byte order mark stays part of the text. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A working-tree file's text, or null when there is no such file. Anything but a regular file, and bytes
 * that are not UTF-8, stop the run: rewriting either would change more than a version.
 */
function readTarget(root, path) {
  const target = join(root, path);
  let bytes;
  try {
    if (!lstatSync(target).isFile()) {
      throw new ControllerError("working_file_unreadable", `${path} is not a regular file`);
    }
    bytes = readFileSync(target);
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    if (error.code === "ENOENT") return null;
    throw new ControllerError("working_file_unreadable", `${path} cannot be read: ${error.message}`);
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new ControllerError("working_file_unreadable", `${path} is not UTF-8 text`);
  }
}

/**
 * Writes every changed file, or none of them. `files` holds all three, changed or not.
 *
 * Any of them that changed since the preparation read it stops the write before anything is created. Each
 * new text then goes to its own temporary file beside its target, created exclusively, so a file left
 * behind by anything else is never overwritten or removed. Only when all of them are written are they
 * renamed over their targets. If a rename fails, the files already replaced get their original text back,
 * and the error says whether that worked.
 */
function writeAll(root, files) {
  for (const file of files) {
    if (readTarget(root, file.path) !== file.before) {
      throw new ControllerError("working_tree_changed", `${file.path} changed while the preparation ran; nothing was written`);
    }
  }
  const writes = files.filter((file) => file.after !== file.before);

  const temporary = (write) => join(root, `${write.path}${TEMPORARY}`);
  const created = [];
  try {
    for (const write of writes) {
      const descriptor = openSync(temporary(write), "wx");
      created.push(write);
      try {
        writeFileSync(descriptor, write.after, "utf8");
      } finally {
        closeSync(descriptor);
      }
    }
  } catch (error) {
    for (const write of created) rmSync(temporary(write), { force: true });
    throw new ControllerError("preparation_not_written", `nothing was written: ${error.message}`);
  }

  const replaced = [];
  try {
    for (const write of writes) {
      renameSync(temporary(write), join(root, write.path));
      replaced.push(write);
    }
  } catch (error) {
    const unrestored = [];
    for (const write of replaced) {
      try {
        writeFileSync(join(root, write.path), write.before, "utf8");
      } catch {
        unrestored.push(write.path);
      }
    }
    for (const write of writes) if (!replaced.includes(write)) rmSync(temporary(write), { force: true });
    throw new ControllerError(
      "preparation_not_written",
      unrestored.length > 0
        ? `a file could not be replaced (${error.message}), and ${unrestored.join(", ")} still hold the prepared text; restore them from Git`
        : `a file could not be replaced (${error.message}); every file holds its original text again`,
    );
  }
}

export async function prepareReleaseCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      pr: { type: "string" },
      date: { type: "string" },
      "dry-run": { type: "boolean" },
      "stable-contract": { type: "boolean" },
      "main-ref": { type: "string" },
      path: { type: "string" },
      format: { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const mainRef = readMainRef(values);
  if (!values.sha || !FULL_SHA.test(values.sha)) {
    throw new UsageError("--sha must be the full 40-character lowercase commit sha of the release candidate");
  }
  const pr = readPositiveInteger(values.pr, "pr");
  const dryRun = values["dry-run"] === true;
  if (pr === null && !dryRun) {
    throw new UsageError("--pr is required: the number of this preparation's pull request. Only --dry-run may leave it out");
  }
  const date = readDate(values.date);
  const root = resolve(values.path ?? process.cwd());
  const { apiUrl, token, serverUrl } = settings(env);

  const { report, files } = await prepareRelease({
    git: createGitReader(root),
    github: createGitHubReader({ apiUrl, token, repository }),
    readWorkingFile: (name) => readTarget(root, name),
    repository,
    sha: values.sha,
    mainRef,
    serverUrl,
    pr,
    date,
    dryRun,
    stableContract: values["stable-contract"] === true,
  });

  if (files.some((file) => file.after !== file.before)) {
    writeAll(root, files);
    for (const file of report.files) file.written = file.changed;
  }
  return {
    code: STATUS_EXIT[report.status],
    output: format === "json" ? json(report) : renderPreparationReport(report),
  };
}
