#!/usr/bin/env node
/**
 * Free Ventures OMS release controller — the public command boundary for issue #36.
 *
 * This slice is read-only. It classifies pull-request titles and previews the next version and the
 * release notes for an exact accepted merge. It publishes nothing: no tag, no ref, no status, no
 * release, no push. Its GitHub client can only send GET requests, and its Git client runs only
 * reading commands against the local clone it is pointed at.
 *
 *   check-pr-title   Classify a PR title and its description before merge.
 *   preview          Calculate the version and notes for one exact accepted merge on main.
 *
 * Exit status is part of the interface:
 *
 *   0  classified, calculated, or nothing to release
 *   1  the controller could not finish (Git or GitHub failed); nothing was guessed
 *   2  usage error
 *   3  pending decision: an unsupported merge shape or a missing association, for the Owner
 *   4  refused: the input is malformed, conflicting or ambiguous
 *
 * Usage and the scope of what the tests prove: scripts/release/README.md.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { classifyChange, highestChange } from "./lib/classification.mjs";
import { ControllerError } from "./lib/errors.mjs";
import { createGitReader } from "./lib/git.mjs";
import { createGitHubReader } from "./lib/github.mjs";
import { readAcceptedRange } from "./lib/history.mjs";
import { escapeMarkdown } from "./lib/markdown.mjs";
import { renderPreviewReport, renderReleaseNotes } from "./lib/notes.mjs";
import { nextVersion, policyFor } from "./lib/version.mjs";

export const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2, pending: 3, refused: 4 });

const REPOSITORY = /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!-)[A-Za-z0-9._/-]+$/;

class UsageError extends Error {}

function readFormat(value) {
  const format = value ?? "markdown";
  if (format !== "json" && format !== "markdown") {
    throw new UsageError("--format must be json or markdown");
  }
  return format;
}

/** A string option that may be given directly or named as an environment variable. */
function readText(values, env, name, { required }) {
  const direct = values[name];
  const fromEnv = values[`${name}-env`];
  if (direct !== undefined && fromEnv !== undefined) {
    throw new UsageError(`give --${name} or --${name}-env, not both`);
  }
  if (fromEnv !== undefined) {
    const value = env[fromEnv];
    if (value === undefined) {
      if (required) throw new UsageError(`environment variable ${fromEnv} is not set`);
      return "";
    }
    return value;
  }
  if (direct !== undefined) return direct;
  if (required) throw new UsageError(`--${name} or --${name}-env is required`);
  return "";
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checkPrTitle(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      title: { type: "string" },
      "title-env": { type: "string" },
      body: { type: "string" },
      "body-env": { type: "string" },
      format: { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const title = readText(values, env, "title", { required: true });
  const body = readText(values, env, "body", { required: false });

  const result = classifyChange({ title, description: body });
  const report = result.ok
    ? {
        command: "check-pr-title",
        status: "valid",
        title,
        classification: result.classification,
        footersToRetain: result.footersToRetain,
        reasons: [],
      }
    : {
        command: "check-pr-title",
        status: "refused",
        title,
        classification: null,
        footersToRetain: [],
        reasons: result.reasons,
      };

  return {
    code: result.ok ? EXIT.ok : EXIT.refused,
    output: format === "json" ? json(report) : renderTitleCheck(report),
  };
}

function renderTitleCheck(report) {
  const lines = [`## Release classification: ${report.status}`, "", `Title: ${escapeMarkdown(report.title)}`, ""];
  if (report.classification) {
    const c = report.classification;
    lines.push(
      `- Type: \`${c.type}\`${c.scope ? ` · scope \`${escapeMarkdown(c.scope)}\`` : ""}`,
      `- Change: **${c.change}**`,
      `- Breaking: ${c.breaking ? `yes — ${escapeMarkdown(c.breakingExplanation)}` : "no"}`,
    );
    if (c.deprecation) lines.push(`- Deprecation: ${escapeMarkdown(c.deprecation)}`);
    for (const sha of c.reverts) lines.push(`- Reverts: \`${sha}\``);
    if (report.footersToRetain.length > 0) {
      lines.push(
        "",
        "The merge body keeps only the PR title by default. Copy these lines into the merge body when merging, or the merge will be refused at integration:",
        "",
        ...report.footersToRetain.map((line) => `    ${line}`),
      );
    }
  } else {
    for (const r of report.reasons) lines.push(`- \`${r.code}\`: ${escapeMarkdown(r.detail)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function preview(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      "main-ref": { type: "string" },
      path: { type: "string" },
      "proposed-title": { type: "string", multiple: true },
      "accept-stable-contract": { type: "string" },
      format: { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const repository = values.repo;
  const sha = values.sha;
  const mainRef = values["main-ref"] ?? "origin/main";
  const proposedTitles = values["proposed-title"] ?? [];
  const acceptance = values["accept-stable-contract"];

  if (!repository || !REPOSITORY.test(repository)) {
    throw new UsageError("--repo owner/name is required");
  }
  if (!sha || !FULL_SHA.test(sha)) {
    throw new UsageError("--sha must be the full 40-character lowercase commit sha of the exact merge");
  }
  if (!REF.test(mainRef)) throw new UsageError("--main-ref must be a plain ref name");
  if (acceptance !== undefined && !acceptance.trim()) {
    throw new UsageError("--accept-stable-contract needs the reference to the Owner's acceptance");
  }

  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
  const git = createGitReader(values.path ?? process.cwd());
  const github = createGitHubReader({
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    repository,
  });

  const range = await readAcceptedRange({ git, github, repository, sha, mainRef, serverUrl });
  const reasons = [...range.reasons];

  const proposed = [];
  for (const title of proposedTitles) {
    const result = classifyChange({ title });
    if (result.ok) {
      const { type, scope, change, breaking } = result.classification;
      proposed.push({ title, type, scope, change, breaking });
    } else {
      reasons.push(
        ...result.reasons.map((r) => ({
          kind: "refusal",
          code: r.code,
          detail: `proposed title ${JSON.stringify(title)}: ${r.detail}`,
          commit: null,
          pr: null,
        })),
      );
    }
  }

  // Stability is accepted once, during 0.x. Asking at 1.x is refused whether or not anything merged.
  if (acceptance && range.base && policyFor(range.base.version) !== "0.x") {
    reasons.push({
      kind: "refusal",
      code: "stability_acceptance_not_applicable",
      detail: `${range.base.version} is already a stable version; stable-contract acceptance applies only during 0.x`,
      commit: null,
      pr: null,
    });
  }

  const report = {
    command: "preview",
    status: "calculated",
    publication: "none",
    repository,
    sha,
    mainRef,
    base: range.base,
    policy: range.base ? policyFor(range.base.version) : null,
    highestChange: null,
    version: null,
    stableContractAcceptance: acceptance ? { reference: acceptance, validated: false } : null,
    merges: [],
    proposed,
    versionIncludingProposed: null,
    reasons: [],
    notes: null,
  };

  if (reasons.length === 0 && range.base) {
    const calculate = (changes) =>
      nextVersion({
        baseVersion: range.base.version,
        highest: highestChange(changes),
        stableContractAcceptance: acceptance,
      });

    if (range.merges.length > 0) {
      const accepted = calculate(range.merges.map((m) => m.change));
      if (accepted.ok) {
        report.highestChange = highestChange(range.merges.map((m) => m.change));
        report.version = accepted.version;
        report.merges = range.merges;
      } else {
        reasons.push({ kind: "refusal", ...accepted.reason, commit: null, pr: null });
      }
    }
    if (reasons.length === 0 && proposed.length > 0) {
      const changes = [...range.merges, ...proposed].map((m) => m.change);
      const withProposed = calculate(changes);
      if (withProposed.ok) report.versionIncludingProposed = withProposed.version;
    }
  }

  report.reasons = reasons;
  if (reasons.some((r) => r.kind === "refusal")) {
    report.status = "refused";
  } else if (reasons.length > 0) {
    report.status = "pending_decision";
  } else if (range.merges.length === 0) {
    report.status = "no_accepted_changes";
  } else {
    report.notes = renderReleaseNotes(report);
  }
  if (report.status !== "calculated") {
    report.highestChange = null;
    report.version = null;
    report.merges = [];
    if (report.status !== "no_accepted_changes") report.versionIncludingProposed = null;
  }

  const code =
    report.status === "refused" ? EXIT.refused : report.status === "pending_decision" ? EXIT.pending : EXIT.ok;
  return { code, output: format === "json" ? json(report) : renderPreviewReport(report) };
}

const COMMANDS = {
  "check-pr-title": checkPrTitle,
  preview,
};

/**
 * Runs one command. Returns the exit status; writes the report to stdout and diagnostics to
 * stderr. Never throws.
 */
export async function main(argv, env, io) {
  const [command, ...args] = argv;
  const run = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command] : null;
  if (!run) {
    io.stderr(
      `release-controller: unknown command ${JSON.stringify(command ?? "")}; expected one of ${Object.keys(COMMANDS).join(", ")}\n`,
    );
    return EXIT.usage;
  }
  try {
    const { code, output } = await run(args, env);
    io.stdout(output);
    return code;
  } catch (error) {
    if (error instanceof UsageError || String(error?.code ?? "").startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`release-controller: ${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof ControllerError) {
      io.stderr(`release-controller: ${error.code}: ${error.message}\n`);
      return EXIT.failure;
    }
    io.stderr(`release-controller: unexpected failure: ${error?.stack ?? error}\n`);
    return EXIT.failure;
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
