/**
 * The normal-release commands: arguments, environment and output. The decisions are lib/normal.mjs's.
 *
 *   evaluate-release   read-only; its JSON is the plan the tag writer receives
 *   publish-release    publishes the normal tag through the tag writer, only when RELEASE_NORMAL_PUBLICATION
 *                      is exactly `enabled`
 */

import { parseArgs } from "node:util";

import { readMainRef, readPlan, readRepository, settings } from "./build-commands.mjs";
import { appendOutputs, appendText, EXIT, FULL_SHA, json, readFormat, readPositiveInteger, UsageError } from "./cli.mjs";
import { readReference } from "./evidence.mjs";
import { createGitReader } from "./git.mjs";
import { createGitHubReader, createTagWriter } from "./github.mjs";
import { evaluateRelease, publishRelease } from "./normal.mjs";
import { renderReleaseReport } from "./normal-report.mjs";
import { rememberingGit, rememberingGitHub } from "./reconcile.mjs";
import { NORMAL_VERSION } from "./version.mjs";

/** The variable that activates normal publication. It is separate from build publication's. */
export const NORMAL_ACTIVATION = "RELEASE_NORMAL_PUBLICATION";

const DECISION_EXIT = Object.freeze({
  eligible: EXIT.ok,
  already_published: EXIT.ok,
  published: EXIT.ok,
  pending: EXIT.pending,
  refused: EXIT.refused,
  failed: EXIT.failedGate,
  publication_disabled: EXIT.disabled,
});

const SCOPE_OPTIONS = {
  repo: { type: "string" },
  "repo-id": { type: "string" },
  "main-ref": { type: "string" },
  path: { type: "string" },
  format: { type: "string" },
  outputs: { type: "string" },
  summary: { type: "string" },
  "dispatch-run-id": { type: "string" },
  "dispatch-run-attempt": { type: "string" },
};

function readers(values, env) {
  const { apiUrl, token } = settings(env);
  return {
    git: rememberingGit(createGitReader(values.path ?? process.cwd())),
    github: rememberingGitHub(createGitHubReader({ apiUrl, token, repository: values.repo })),
  };
}

function readDispatch(values, { required }) {
  const runId = readPositiveInteger(values["dispatch-run-id"], "dispatch-run-id");
  const attempt = readPositiveInteger(values["dispatch-run-attempt"], "dispatch-run-attempt");
  if ((runId === null) !== (attempt === null)) {
    throw new UsageError("--dispatch-run-id and --dispatch-run-attempt name the Owner's dispatch; give both or neither");
  }
  if (required && runId === null) {
    throw new UsageError("--dispatch-run-id and --dispatch-run-attempt are required: the run and attempt this writer is part of");
  }
  return runId === null ? null : { runId, attempt };
}

function readRecordReference(values, name, { optional = false } = {}) {
  const value = values[name];
  if (optional && (value === undefined || value === "none")) return null;
  const reference = readReference(value);
  if (!reference) {
    throw new UsageError(
      `--${name} must be a record reference, comment:<id>@sha256:<64 hex digits>${optional ? ", or none" : ""}`,
    );
  }
  return reference;
}

function emit(report, values, format) {
  const tag = report.decision === "published" ? report.tag.name : report.decision === "already_published" ? report.existingTag.name : "";
  if (values.outputs) {
    appendOutputs(values.outputs, { decision: report.decision, sha: report.request?.sha ?? "", tag });
  }
  const markdown = renderReleaseReport(report);
  if (values.summary) appendText(values.summary, markdown);
  return { code: DECISION_EXIT[report.decision], output: format === "json" ? json(report) : markdown };
}

export async function evaluateReleaseCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...SCOPE_OPTIONS,
      sha: { type: "string" },
      version: { type: "string" },
      "preparation-pr": { type: "string" },
      deployment: { type: "string" },
      review: { type: "string" },
      "production-acceptance": { type: "string" },
      "owner-approval": { type: "string" },
      "hosted-migration": { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  if (!values.sha || !FULL_SHA.test(values.sha)) {
    throw new UsageError("--sha must be the full 40-character lowercase commit sha of the preparation's merge");
  }
  if (!values.version || !NORMAL_VERSION.test(values.version)) {
    throw new UsageError("--version must be the normal version to release, X.Y.Z");
  }
  const preparationPr = readPositiveInteger(values["preparation-pr"], "preparation-pr");
  if (preparationPr === null) throw new UsageError("--preparation-pr is required: the preparation pull request's number");
  const deployment = readPositiveInteger(values.deployment, "deployment");
  if (deployment === null) throw new UsageError("--deployment is required: the GitHub deployment id of the production deployment");
  const request = {
    sha: values.sha,
    version: values.version,
    preparationPr,
    deployment,
    review: readRecordReference(values, "review"),
    productionAcceptance: readRecordReference(values, "production-acceptance"),
    ownerApproval: readRecordReference(values, "owner-approval"),
    hostedMigration: readRecordReference(values, "hosted-migration", { optional: true }),
    dispatch: readDispatch(values, { required: false }),
  };

  const report = await evaluateRelease({
    ...readers(values, env),
    repository,
    repositoryId,
    request,
    mainRef,
    serverUrl: settings(env).serverUrl,
  });
  return emit(report, values, format);
}

export async function publishReleaseCommand(args, env) {
  const { values } = parseArgs({ args, strict: true, options: { ...SCOPE_OPTIONS, plan: { type: "string" } } });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  const dispatch = readDispatch(values, { required: true });
  const plan = readPlan(values.plan);
  const { apiUrl, token, serverUrl } = settings(env);

  const report = await publishRelease({
    ...readers(values, env),
    makeTagWriter: () => createTagWriter({ kind: "normal", apiUrl, token, repository }),
    repository,
    repositoryId,
    plan,
    dispatch,
    mainRef,
    serverUrl,
    activation: env[NORMAL_ACTIVATION],
  });
  return emit(report, values, format);
}
