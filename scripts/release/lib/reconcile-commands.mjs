/**
 * The reconciliation commands: arguments, environment and output. The decisions are lib/reconcile.mjs's.
 *
 *   reconcile-builds            read-only; its JSON is the plan the writing jobs receive
 *   publish-reconciled-builds   publishes every eligible commit through the one build-tag writer, when activated
 *   write-reconciled-statuses   writes the statuses a reconciliation's run is answerable for, when activated
 */

import { parseArgs } from "node:util";

import { readMainRef, readPlan, readRepository, readTargetUrl, settings, WRITER_RESULTS } from "./build-commands.mjs";
import { appendOutputs, appendText, EXIT, FULL_SHA, json, readFormat, readPositiveInteger, UsageError } from "./cli.mjs";
import { createGitReader } from "./git.mjs";
import { createGitHubReader, createStatusWriter, createTagWriter } from "./github.mjs";
import {
  BUILD_TAGS_OWED_AFTER,
  publishReconciledBuilds,
  reconcileBuilds,
  rememberingGit,
  rememberingGitHub,
  writeReconciledStatuses,
} from "./reconcile.mjs";
import { renderPublicationReport, renderReconciliationReport, renderStatusesReport } from "./reconcile-report.mjs";
import { NORMAL_TAG } from "./version.mjs";

const DECISION_EXIT = Object.freeze({
  eligible: EXIT.ok,
  nothing_to_publish: EXIT.ok,
  published: EXIT.ok,
  reported: EXIT.ok,
  refused: EXIT.refused,
  publication_disabled: EXIT.disabled,
  interrupted: EXIT.failure,
});

const PUBLICATION_DECISIONS = new Set(["published", "nothing_to_publish", "refused", "publication_disabled", "interrupted"]);

const SCOPE_OPTIONS = {
  repo: { type: "string" },
  "repo-id": { type: "string" },
  "main-ref": { type: "string" },
  path: { type: "string" },
  format: { type: "string" },
};

/** The Git and GitHub readers every reconciliation command uses, each asking a question once. */
function readers(values, env) {
  const { apiUrl, token } = settings(env);
  return {
    git: rememberingGit(createGitReader(values.path ?? process.cwd())),
    github: rememberingGitHub(createGitHubReader({ apiUrl, token, repository: values.repo })),
  };
}

export async function reconcileBuildsCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...SCOPE_OPTIONS,
      since: { type: "string" },
      sha: { type: "string" },
      "run-id": { type: "string" },
      outputs: { type: "string" },
      summary: { type: "string" },
    },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  const since = values.since ?? BUILD_TAGS_OWED_AFTER;
  if (!NORMAL_TAG.test(since)) throw new UsageError("--since must name a normal release tag, vX.Y.Z");
  if ((values.sha === undefined) !== (values["run-id"] === undefined)) {
    throw new UsageError("--sha and --run-id name the CI completion that started the reconciliation; give both or neither");
  }
  if (values.sha !== undefined && !FULL_SHA.test(values.sha)) {
    throw new UsageError("--sha must be the full 40-character lowercase commit sha of the exact merge");
  }
  const runId = readPositiveInteger(values["run-id"], "run-id");
  const trigger = values.sha === undefined ? null : { sha: values.sha, runId };

  const report = await reconcileBuilds({
    ...readers(values, env),
    repository,
    repositoryId,
    mainRef,
    serverUrl: settings(env).serverUrl,
    since,
    trigger,
  });

  if (values.outputs) {
    appendOutputs(values.outputs, {
      decision: report.decision,
      eligible: report.counts.eligible,
      blocked: report.counts.blocked,
      recorded: report.counts.recorded,
      main: report.main ?? "",
    });
  }
  const markdown = renderReconciliationReport(report);
  if (values.summary) appendText(values.summary, markdown);
  return { code: DECISION_EXIT[report.decision], output: format === "json" ? json(report) : markdown };
}

export async function publishReconciledBuildsCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { ...SCOPE_OPTIONS, plan: { type: "string" }, outputs: { type: "string" }, summary: { type: "string" } },
  });
  const format = readFormat(values.format);
  const repository = readRepository(values);
  const repositoryId = readPositiveInteger(values["repo-id"], "repo-id");
  const mainRef = readMainRef(values);
  const plan = readPlan(values.plan);
  const { apiUrl, token, serverUrl, activation } = settings(env);

  const report = await publishReconciledBuilds({
    ...readers(values, env),
    makeTagWriter: () => createTagWriter({ apiUrl, token, repository }),
    repository,
    repositoryId,
    plan,
    mainRef,
    serverUrl,
    activation,
  });

  if (values.outputs) {
    appendOutputs(values.outputs, {
      decision: report.decision,
      tags: report.commits.filter((commit) => commit.decision === "tagged").map((commit) => commit.tag.name).join(" "),
    });
  }
  const markdown = renderPublicationReport(report);
  if (values.summary) appendText(values.summary, markdown);
  return { code: DECISION_EXIT[report.decision], output: format === "json" ? json(report) : markdown };
}

export async function writeReconciledStatusesCommand(args, env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...SCOPE_OPTIONS,
      plan: { type: "string" },
      "writer-result": { type: "string" },
      "writer-decision": { type: "string" },
      "target-url": { type: "string" },
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
  if (writer.decision && !PUBLICATION_DECISIONS.has(writer.decision)) {
    throw new UsageError("--writer-decision must be a decision publish-reconciled-builds reports");
  }
  const targetUrl = readTargetUrl(values["target-url"], { serverUrl, repository });
  const plan = readPlan(values.plan);

  const report = await writeReconciledStatuses({
    ...readers(values, env),
    makeStatusWriter: () => createStatusWriter({ apiUrl, token, repository }),
    repository,
    repositoryId,
    plan,
    mainRef,
    serverUrl,
    activation,
    writer,
    targetUrl,
  });
  return {
    code: DECISION_EXIT[report.decision],
    output: format === "json" ? json(report) : renderStatusesReport(report),
  };
}
