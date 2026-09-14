/**
 * The build-tag commands: arguments, environment and output. The decisions are lib/build.mjs's.
 *
 *   evaluate-build        read-only; its JSON is the plan the writing jobs receive
 *   publish-build         the only command that can create a tag, and only when activated
 *   write-build-status    the only command that can write a commit status, and only when activated
 *   runtime-dependencies  the lockfile paths the writing jobs need, for the bundle
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ACTIVATED, evaluateBuild, planProblems, publishBuild, statusToWrite } from "./build.mjs";
import { renderBuildReport } from "./build-report.mjs";
import {
  appendOutputs,
  appendText,
  EXIT,
  FULL_SHA,
  json,
  readFormat,
  readPositiveInteger,
  REF,
  REPOSITORY,
  UsageError,
} from "./cli.mjs";
import { CONTROLLER_PACKAGES, runtimeClosure } from "./dependencies.mjs";
import { ControllerError } from "./errors.mjs";
import { createGitReader } from "./git.mjs";
import { createGitHubReader, createStatusWriter, createTagWriter } from "./github.mjs";
import { escapeMarkdown } from "./markdown.mjs";

const DECISION_EXIT = Object.freeze({
  eligible: EXIT.ok,
  already_tagged: EXIT.ok,
  tagged: EXIT.ok,
  not_applicable: EXIT.ok,
  written: EXIT.ok,
  no_status: EXIT.ok,
  pending: EXIT.pending,
  refused: EXIT.refused,
  failed: EXIT.failedGate,
  publication_disabled: EXIT.disabled,
});

export const WRITER_RESULTS = new Set(["", "success", "failure", "cancelled", "skipped"]);

export function settings(env) {
  return {
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    serverUrl: (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, ""),
    activation: env.RELEASE_BUILD_PUBLICATION,
  };
}

export function readRepository(values) {
  if (!values.repo || !REPOSITORY.test(values.repo)) throw new UsageError("--repo owner/name is required");
  return values.repo;
}

export function readMainRef(values) {
  const mainRef = values["main-ref"] ?? "origin/main";
  if (!REF.test(mainRef)) throw new UsageError("--main-ref must be a plain ref name");
  return mainRef;
}

/** A commit status's target URL: null, or a workflow run of this repository. */
export function readTargetUrl(value, { serverUrl, repository }) {
  if (value === undefined) return null;
  const runsPrefix = `${serverUrl}/${repository}/actions/runs/`;
  if (!(value.startsWith(runsPrefix) && /^[1-9]\d*$/.test(value.slice(runsPrefix.length)))) {
    throw new UsageError(`--target-url must be a workflow run of ${repository}`);
  }
  return value;
}

/** The plan file's JSON, or null when it is not JSON. A file that cannot be read is a usage error. */
export function readPlan(path) {
  if (!path) throw new UsageError("--plan is required: the JSON file evaluate-build wrote");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`--plan ${path} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function emit(report, values, format) {
  const tag =
    report.decision === "tagged" ? report.tag.name : report.decision === "already_tagged" ? report.existingTag.name : "";
  if (values.outputs) {
    appendOutputs(values.outputs, {
      decision: report.decision,
      sha: report.sha ?? "",
      tag,
      state: report.status?.state ?? "",
      description: report.status?.description ?? "",
    });
  }
  const markdown = renderBuildReport(report);
  if (values.summary) appendText(values.summary, markdown);
  return { code: DECISION_EXIT[report.decision], output: format === "json" ? json(report) : markdown };
}

const REPORT_OPTIONS = {
  repo: { type: "string" },
  "repo-id": { type: "string" },
  "main-ref": { type: "string" },
  path: { type: "string" },
  format: { type: "string" },
  outputs: { type: "string" },
  summary: { type: "string" },
};

export async function evaluateBuildCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { ...REPORT_OPTIONS, sha: { type: "string" }, "run-id": { type: "string" } },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  if (!values.sha || !FULL_SHA.test(values.sha)) {
    throw new UsageError("--sha must be the full 40-character lowercase commit sha of the exact merge");
  }
  const runId = readPositiveInteger(values["run-id"], "run-id");
  const { apiUrl, token, serverUrl } = settings(env);

  const report = await evaluateBuild({
    git: createGitReader(values.path ?? process.cwd()),
    github: createGitHubReader({ apiUrl, token, repository }),
    repository,
    repositoryId,
    sha: values.sha,
    runId,
    mainRef,
    serverUrl,
  });
  return emit(report, values, format);
}

export async function publishBuildCommand(args, env) {
  const { values } = parseArgs({ args, strict: true, options: { ...REPORT_OPTIONS, plan: { type: "string" } } });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  const plan = readPlan(values.plan);
  const { apiUrl, token, serverUrl, activation } = settings(env);

  const report = await publishBuild({
    git: createGitReader(values.path ?? process.cwd()),
    github: createGitHubReader({ apiUrl, token, repository }),
    makeTagWriter: () => createTagWriter({ apiUrl, token, repository }),
    repository,
    repositoryId,
    plan,
    mainRef,
    serverUrl,
    activation,
  });
  return emit(report, values, format);
}

function renderStatusReport(report) {
  const lines = [`## Build-tag status: ${report.decision.replace("_", " ")}`, "", `Exact merge \`${report.sha ?? "unknown"}\`.`];
  if (report.evaluation) {
    lines.push(
      "",
      `- Evaluated when written: ${report.evaluation.decision}${report.evaluation.tag ? ` · \`${report.evaluation.tag}\`` : ""}`,
    );
  }
  if (report.status) {
    lines.push("", `- Context: \`${report.status.context}\``, `- State: ${report.status.state}`, `- Description: ${escapeMarkdown(report.status.description)}`);
  }
  for (const r of report.reasons) lines.push(`- \`${r.code}\`: ${escapeMarkdown(r.detail)}`);
  return `${lines.join("\n")}\n`;
}

export async function writeBuildStatusCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      "repo-id": { type: "string" },
      "main-ref": { type: "string" },
      path: { type: "string" },
      plan: { type: "string" },
      "writer-result": { type: "string" },
      "writer-decision": { type: "string" },
      "target-url": { type: "string" },
      format: { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  const { apiUrl, token, serverUrl, activation } = settings(env);

  const writer = { result: values["writer-result"] ?? "", decision: values["writer-decision"] ?? "" };
  if (!WRITER_RESULTS.has(writer.result)) {
    throw new UsageError("--writer-result must be success, failure, cancelled, skipped or empty");
  }
  if (writer.decision && !Object.hasOwn(DECISION_EXIT, writer.decision)) {
    throw new UsageError("--writer-decision must be a decision the controller reports");
  }

  const targetUrl = readTargetUrl(values["target-url"], { serverUrl, repository });

  const plan = readPlan(values.plan);
  const report = {
    command: "write-build-status",
    decision: null,
    sha: null,
    evaluation: null,
    status: null,
    written: false,
    reasons: [],
  };
  const problems = planProblems(plan, { repository, repositoryId });
  const finishStatus = (decision) => {
    report.decision = decision;
    return { code: DECISION_EXIT[decision], output: format === "json" ? json(report) : renderStatusReport(report) };
  };

  if (problems.length > 0) {
    report.reasons.push({ kind: "refusal", code: "plan_invalid", detail: `the plan cannot be used: ${problems.join("; ")}`, commit: null, pr: null });
    return finishStatus("refused");
  }
  report.sha = plan.sha;
  if (activation !== ACTIVATED) return finishStatus("publication_disabled");

  // Decide from what exists now, not from the plan alone. The workflow runs this under the tag writer's
  // lock, so no build tag can be created between this evaluation and the status it decides.
  const fresh = await evaluateBuild({
    git: createGitReader(values.path ?? process.cwd()),
    github: createGitHubReader({ apiUrl, token, repository }),
    repository,
    repositoryId,
    sha: plan.sha,
    runId: plan.runId,
    mainRef,
    serverUrl,
  });
  report.evaluation = {
    decision: fresh.decision,
    tag: fresh.existingTag?.name ?? null,
    reasons: fresh.reasons.map((r) => r.code),
  };

  const status = statusToWrite({ plan, fresh, writer });
  if (!status) return finishStatus("no_status");

  await createStatusWriter({ apiUrl, token, repository }).createStatus({
    sha: plan.sha,
    state: status.state,
    description: status.description,
    targetUrl,
  });
  report.status = status;
  report.written = true;
  return finishStatus("written");
}

export async function runtimeDependenciesCommand(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { lockfile: { type: "string" }, format: { type: "string" } },
  });
  const format = readFormat(values.format, ["lines", "json"]);
  const path = values.lockfile ?? "package-lock.json";
  let lockfile;
  try {
    lockfile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ControllerError("lockfile_unreadable", `${path} cannot be read as JSON: ${error.message}`);
  }
  const paths = runtimeClosure(lockfile);
  return {
    code: EXIT.ok,
    output:
      format === "json" ? json({ command: "runtime-dependencies", roots: CONTROLLER_PACKAGES, paths }) : `${paths.join("\n")}\n`,
  };
}
