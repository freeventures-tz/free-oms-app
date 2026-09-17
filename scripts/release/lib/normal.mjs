/**
 * Normal releases: whether an Owner's request to publish `vX.Y.Z` at an exact merge is satisfied by
 * authoritative evidence, and the one path that publishes it.
 *
 * `evaluateRelease` only reads. It checks every gate of the evidence contract in scripts/release/README.md
 * and reports each one, so a refusal names what is missing:
 *
 *   dispatch               the Owner started this run, and the Owner started its current attempt
 *   policy                 the release-evidence policy at the release commit
 *   history                the commit is an accepted merge on main, with its own ancestral release
 *   main                   main is still exactly the commit
 *   version                the requested version is the calculated one, and its tag is free or already this release
 *   preparation            the commit is the reviewed preparation's merge, and its metadata agrees
 *   schema-boundary        the migration tree is unchanged, or a hosted migration record is required
 *   hosted-migration       that record, when the tree changed
 *   ci                     final-merge CI passed for the commit
 *   deployment             Vercel's production deployment of the commit
 *   review                 the independent READY for the preparation's reviewed head
 *   production-acceptance  production verification of that deployment
 *   owner-approval         the Owner's written approval of all of the above
 *
 * `publishRelease` evaluates everything again from Git and GitHub inside the tag writer's locked job,
 * refuses a plan the evaluation no longer matches, and writes only when normal publication is activated.
 * It checks main again before the tag object and again before the reference, creates both without force,
 * and reports success only after reading them back. A tag that already is this release is a no-op.
 */

import { ACTIVATED, assertCheckoutTagsCurrent, ciEvidenceDifferences } from "./build.mjs";
import { ciEvidence, notesDigest } from "./build-tags.mjs";
import { evaluateFinalMergeCi, FINAL_MERGE_CI } from "./ci.mjs";
import { FULL_SHA } from "./cli.mjs";
import { ControllerError } from "./errors.mjs";
import {
  AUTHORIZED_ACTIONS,
  formatBoundary,
  isBefore,
  notAfter,
  POLICY_PATH,
  readPolicy,
  readRecord,
  readReference,
  renderBlock,
} from "./evidence.mjs";
import { readAcceptedRange } from "./history.mjs";
import { MAIN_BRANCH, verifyMergedPreparation } from "./preparation.mjs";
import { createAnnotatedTag } from "./tag-write.mjs";
import { compareVersions, NORMAL_TAG, NORMAL_VERSION, policyFor } from "./version.mjs";

export const RELEASE_PLAN_SCHEMA = 1;

/** The workflow the Owner dispatches. Only a run of it, on main, can publish. */
export const NORMAL_RELEASE_WORKFLOW = Object.freeze({
  file: "release-normal-tag.yml",
  path: ".github/workflows/release-normal-tag.yml",
  event: "workflow_dispatch",
  branch: MAIN_BRANCH,
});

/** The directory whose tree is a release's schema boundary. */
export const MIGRATIONS_PATH = "supabase/migrations";

export const GATES = Object.freeze([
  "dispatch",
  "policy",
  "history",
  "main",
  "version",
  "preparation",
  "schema-boundary",
  "hosted-migration",
  "ci",
  "deployment",
  "review",
  "production-acceptance",
  "owner-approval",
]);

const RELEASE_DECISIONS = new Set(["eligible", "already_published", "pending", "failed", "refused"]);
const IDENTITY_CODES = new Set(["unknown_commit", "unknown_main_ref", "not_on_main_first_parent"]);
const IN_PROGRESS = new Set(["pending", "queued", "in_progress"]);
const NORMAL_TAG_WRITE = Object.freeze({ noun: "normal release tag", publication: "a published release" });

const PROVENANCE_FIELDS = Object.freeze([
  "Release-Controller-Schema",
  "Release-Kind",
  "Repository",
  "Commit",
  "Version",
  "Classification",
  "Release-Base",
  "Notes-Digest",
  "Preparation-PR",
  "Reviewed-Head",
  "Release-Date",
  "Schema-Boundary",
  "Deployment",
  "Review-Record",
  "Production-Acceptance-Record",
  "Owner-Approval-Record",
  "Hosted-Migration-Record",
  "Authorized-Actions",
  "Owner",
  "CI-Workflow",
  "CI-Run",
  "CI-Attempt",
  "Dispatch-Run",
]);
/** The fields a retry must reproduce exactly. The CI attempt is proved separately; the dispatch run differs per retry. */
const STABLE_FIELDS = Object.freeze(PROVENANCE_FIELDS.slice(0, 20));

const reason = (kind, gate, code, detail, commit = null, pr = null) => ({ kind, gate, code, detail, commit, pr });
const refusal = (gate, code, detail, commit = null, pr = null) => reason("refusal", gate, code, detail, commit, pr);
const same = (account, expected) => account?.id === expected.id && account?.login === expected.login;
const peeledCommit = (tag) => (tag.objectType === "tag" ? tag.peeledName : tag.objectName);

/** The request as a plan and a report carry it. */
export function describeRequest(request) {
  return {
    sha: request.sha,
    version: request.version,
    preparationPr: request.preparationPr,
    deployment: request.deployment,
    review: request.review.text,
    productionAcceptance: request.productionAcceptance.text,
    ownerApproval: request.ownerApproval.text,
    hostedMigration: request.hostedMigration?.text ?? "none",
    dispatch: request.dispatch,
  };
}

/** A request read back from a plan, or null when the plan does not carry a complete one. */
export function requestFromPlan(value) {
  if (!value || typeof value !== "object") return null;
  const positive = (n) => Number.isSafeInteger(n) && n > 0;
  const review = readReference(value.review);
  const productionAcceptance = readReference(value.productionAcceptance);
  const ownerApproval = readReference(value.ownerApproval);
  const hostedMigration = value.hostedMigration === "none" ? null : readReference(value.hostedMigration);
  const dispatch = value.dispatch;
  if (
    !FULL_SHA.test(String(value.sha ?? "")) ||
    !NORMAL_VERSION.test(String(value.version ?? "")) ||
    !positive(value.preparationPr) ||
    !positive(value.deployment) ||
    !review ||
    !productionAcceptance ||
    !ownerApproval ||
    (value.hostedMigration !== "none" && !hostedMigration) ||
    !(dispatch === null || (dispatch && positive(dispatch.runId) && positive(dispatch.attempt)))
  ) {
    return null;
  }
  return {
    sha: value.sha,
    version: value.version,
    preparationPr: value.preparationPr,
    deployment: value.deployment,
    review,
    productionAcceptance,
    ownerApproval,
    hostedMigration,
    dispatch: dispatch === null ? null : { runId: dispatch.runId, attempt: dispatch.attempt },
  };
}

/** The first line and stable fields a normal tag of this release carries. */
export function expectedReleaseProvenance(report) {
  const { release, request } = report;
  return {
    firstLine: `Release v${release.version} of ${report.repository}`,
    fields: {
      "Release-Controller-Schema": String(RELEASE_PLAN_SCHEMA),
      "Release-Kind": "normal",
      Repository: report.repository,
      Commit: request.sha,
      Version: release.version,
      Classification: release.highestChange,
      "Release-Base": `${release.base.tag} ${release.base.tagObject} ${release.base.commit}`,
      "Notes-Digest": release.notesDigest,
      "Preparation-PR": String(request.preparationPr),
      "Reviewed-Head": release.reviewedHead,
      "Release-Date": release.releaseDate,
      "Schema-Boundary": report.schemaBoundary.value,
      Deployment: String(request.deployment),
      "Review-Record": request.review,
      "Production-Acceptance-Record": request.productionAcceptance,
      "Owner-Approval-Record": request.ownerApproval,
      "Hosted-Migration-Record": request.hostedMigration,
      "Authorized-Actions": AUTHORIZED_ACTIONS,
      Owner: `${report.owner.login} ${report.owner.id}`,
      "CI-Workflow": FINAL_MERGE_CI.workflowPath,
    },
  };
}

/** The provenance fields of a normal tag's annotation, or null unless each appears exactly once. */
export function parseReleaseProvenance(message) {
  const fields = {};
  for (const line of String(message).split("\n")) {
    const match = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (!match || !PROVENANCE_FIELDS.includes(match[1])) continue;
    if (Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2];
  }
  return PROVENANCE_FIELDS.every((field) => Object.hasOwn(fields, field)) ? fields : null;
}

/**
 * How an annotation differs from this release's provenance, read against Git and GitHub: its stable fields, the
 * CI attempt it cites, and the dispatch it cites. Empty is a match.
 */
async function releaseProvenanceDifferences(github, message, report) {
  const expected = expectedReleaseProvenance(report);
  const differences = [];
  const firstLine = String(message).split("\n")[0];
  if (firstLine !== expected.firstLine) differences.push(`its annotation begins ${JSON.stringify(firstLine)}, not ${JSON.stringify(expected.firstLine)}`);
  const fields = parseReleaseProvenance(message);
  if (!fields) return [...differences, "its annotation carries no complete release provenance"];
  for (const field of STABLE_FIELDS) {
    if (fields[field] !== expected.fields[field]) {
      differences.push(`${field} is ${JSON.stringify(fields[field])}, not ${JSON.stringify(expected.fields[field])}`);
    }
  }
  if (!/^[1-9]\d* [1-9]\d*$/.test(fields["Dispatch-Run"])) {
    differences.push("its Dispatch-Run is not a run id and an attempt");
  } else {
    differences.push(...(await citedDispatchDifferences(github, fields["Dispatch-Run"], report)));
  }
  if (!/^[1-9]\d*$/.test(fields["CI-Run"]) || !/^[1-9]\d*$/.test(fields["CI-Attempt"])) {
    differences.push("its CI run or attempt is not a positive integer");
  } else {
    differences.push(...ciEvidenceDifferences(fields, report));
  }
  return differences;
}

/** The annotation of a new normal tag. Pull-request titles are deliberately not in it; the notes digest binds them. */
export function renderReleaseAnnotation(report) {
  const expected = expectedReleaseProvenance(report);
  const { release, ci, request } = report;
  const lines = [
    expected.firstLine,
    "",
    "An Owner-approved normal release of an exact merge on main, published by the release controller after it verified the evidence below.",
    "",
    ...STABLE_FIELDS.map((field) => `${field}: ${expected.fields[field]}`),
    `CI-Run: ${ci.satisfiedBy.runId}`,
    `CI-Attempt: ${ci.satisfiedBy.attempt}`,
    `Dispatch-Run: ${request.dispatch.runId} ${request.dispatch.attempt}`,
    "",
    "Final-merge CI evidence:",
    ...ciEvidence(ci).map((line) => `- ${line}`),
    "",
    `Accepted merges (${release.merges.length}):`,
    ...release.merges.map((merge) => `- #${merge.pr} ${merge.mergeSha} ${merge.type} ${merge.change}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Every way a run differs from a run of the normal-release workflow, dispatched on main for `sha`. */
function dispatchIdentityMismatches(run, { repository, repositoryId, workflowId, sha }) {
  const mismatches = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(`its ${label} is ${JSON.stringify(actual ?? null)}, not ${JSON.stringify(expected)}`);
  };
  expect("repository", run.repository?.full_name, repository);
  if (repositoryId !== null) expect("repository id", run.repository?.id, repositoryId);
  expect("head repository", run.head_repository?.full_name, repository);
  expect("workflow id", run.workflow_id, workflowId);
  expect("workflow path", run.path, NORMAL_RELEASE_WORKFLOW.path);
  expect("event", run.event, NORMAL_RELEASE_WORKFLOW.event);
  expect("branch", run.head_branch, NORMAL_RELEASE_WORKFLOW.branch);
  expect("head commit", run.head_sha, sha);
  return mismatches;
}

/**
 * Why the dispatch an existing tag cites, `Dispatch-Run: <run> <attempt>`, is not the Owner's dispatch of this
 * release, read from GitHub. Empty when it is.
 *
 * The cited run must be this repository's normal-release workflow, dispatched on main for the tag's commit, and
 * started by the Owner, and the cited attempt must exist and have been started by the Owner. Unlike the current
 * invocation's dispatch, it need not be running or be the run's latest attempt: the run that wrote a tag may
 * have finished, failed after writing, or been re-run since, and none of that unmakes its tag.
 */
async function citedDispatchDifferences(github, cited, report) {
  const [runId, attempt] = cited.split(" ").map(Number);
  const owner = report.owner;
  const sha = report.request.sha;
  const unverified = (detail) => [`its Dispatch-Run ${cited} is not the Owner's dispatch of ${sha}: ${detail}`];
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt)) return unverified("it is not a run id and an attempt");

  const workflow = await github.workflow(NORMAL_RELEASE_WORKFLOW.file);
  if (!workflow || workflow.path !== NORMAL_RELEASE_WORKFLOW.path || !Number.isSafeInteger(workflow.id)) {
    return unverified(`${NORMAL_RELEASE_WORKFLOW.path} is not a workflow of ${report.repository}`);
  }
  const run = await github.workflowRun(runId);
  if (!run) return unverified(`${report.repository} has no workflow run ${runId}`);
  const mismatches = dispatchIdentityMismatches(run, {
    repository: report.repository,
    repositoryId: report.repositoryId,
    workflowId: workflow.id,
    sha,
  });
  if (!same(run.actor, owner)) mismatches.push(`it was started by ${JSON.stringify(run.actor?.login ?? null)}, not the Owner ${owner.login}`);
  if (!Number.isSafeInteger(run.run_attempt) || attempt > run.run_attempt) {
    mismatches.push(`the run has no attempt ${attempt}`);
  } else {
    const view = await github.workflowRunAttempt(runId, attempt);
    if (!view || view.id !== runId || view.run_attempt !== attempt) {
      mismatches.push(`GitHub has no attempt ${attempt} of run ${runId}`);
    } else if (!same(view.triggering_actor, owner)) {
      mismatches.push(`attempt ${attempt} was started by ${JSON.stringify(view.triggering_actor?.login ?? null)}, not the Owner ${owner.login}`);
    }
  }
  return mismatches.length > 0 ? unverified(mismatches.join("; ")) : [];
}

async function checkDispatch({ github, repository, repositoryId, sha, dispatch, owner }) {
  const reasons = [];
  const summary = { runId: dispatch.runId, attempt: dispatch.attempt, actor: null, triggeringActor: null };
  const invalid = (detail) => reasons.push(refusal("dispatch", "dispatch_run_invalid", detail, sha));

  const workflow = await github.workflow(NORMAL_RELEASE_WORKFLOW.file);
  if (!workflow || workflow.path !== NORMAL_RELEASE_WORKFLOW.path || !Number.isSafeInteger(workflow.id)) {
    invalid(`${NORMAL_RELEASE_WORKFLOW.path} is not a workflow of ${repository}`);
    return { summary, reasons };
  }
  const run = await github.workflowRun(dispatch.runId);
  if (!run) {
    invalid(`${repository} has no workflow run ${dispatch.runId}`);
    return { summary, reasons };
  }
  const mismatches = dispatchIdentityMismatches(run, { repository, repositoryId, workflowId: workflow.id, sha });
  const expect = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(`its ${label} is ${JSON.stringify(actual ?? null)}, not ${JSON.stringify(expected)}`);
  };
  expect("latest attempt", run.run_attempt, dispatch.attempt);
  // A dispatch authorises only the run it started, while that run is running.
  expect("status", run.status, "in_progress");
  if (mismatches.length > 0) invalid(`run ${dispatch.runId} is not the Owner's dispatch of ${sha}: ${mismatches.join("; ")}`);

  const attempt = await github.workflowRunAttempt(dispatch.runId, dispatch.attempt);
  summary.actor = run.actor ? { login: run.actor.login ?? null, id: run.actor.id ?? null } : null;
  summary.triggeringActor = attempt?.triggering_actor
    ? { login: attempt.triggering_actor.login ?? null, id: attempt.triggering_actor.id ?? null }
    : null;
  if (!same(run.actor, owner)) {
    reasons.push(
      refusal("dispatch", "dispatch_actor_not_owner", `run ${dispatch.runId} was started by ${JSON.stringify(summary.actor?.login ?? null)}, not the Owner ${owner.login}`, sha),
    );
  }
  if (!attempt || !same(attempt.triggering_actor, owner)) {
    reasons.push(
      refusal(
        "dispatch",
        "dispatch_triggering_actor_not_owner",
        `attempt ${dispatch.attempt} of run ${dispatch.runId} was started by ${JSON.stringify(summary.triggeringActor?.login ?? null)}, not the Owner ${owner.login}`,
        sha,
      ),
    );
  }
  return { summary, reasons };
}

async function checkDeployment({ github, vercel, sha, id }) {
  const reasons = [];
  const refuse = (code, detail) => reasons.push(refusal("deployment", code, `deployment ${id}: ${detail}`, sha));
  const summary = { id, sha: null, environment: null, creator: null, state: null, environmentUrl: null, succeededAt: null };

  const deployment = await github.deployment(id);
  if (!deployment) {
    refuse("deployment_missing", "GitHub has no such deployment in this repository");
    return { summary, reasons };
  }
  Object.assign(summary, {
    sha: deployment.sha ?? null,
    environment: deployment.environment ?? null,
    creator: { login: deployment.creator?.login ?? null, id: deployment.creator?.id ?? null },
  });
  if (!same(deployment.creator, vercel.creator)) {
    refuse("deployment_wrong_creator", `it was created by ${JSON.stringify(summary.creator.login)}, not ${vercel.creator.login}`);
  }
  if (deployment.environment !== vercel.environment) {
    refuse("deployment_wrong_environment", `its environment is ${JSON.stringify(deployment.environment ?? null)}, not ${vercel.environment}`);
  }
  if (deployment.sha !== sha) refuse("deployment_wrong_commit", `it deploys ${deployment.sha ?? "nothing"}, not ${sha}`);

  const statuses = await github.deploymentStatuses(id);
  const latest = statuses.reduce((newest, status) => (Number(status?.id) > Number(newest?.id ?? 0) ? status : newest), null);
  summary.state = latest?.state ?? null;
  summary.environmentUrl = latest?.environment_url ?? null;
  if (latest && !same(latest.creator, vercel.creator)) {
    refuse("deployment_wrong_creator", `its latest status was written by ${JSON.stringify(latest.creator?.login ?? null)}, not ${vercel.creator.login}`);
  }
  if (!latest || IN_PROGRESS.has(latest.state)) {
    reasons.push(reason("pending", "deployment", "deployment_in_progress", `deployment ${id} has not finished: ${latest?.state ?? "no status yet"}`, sha));
  } else if (latest.state !== "success") {
    refuse("deployment_not_successful", `its latest status is ${latest.state}`);
  } else {
    summary.succeededAt = latest.created_at ?? null;
    let host = null;
    try {
      const url = new URL(String(latest.environment_url));
      host = url.protocol === "https:" ? url.host : null;
    } catch {
      host = null;
    }
    const expectedHost = new RegExp(`^${vercel.project}-[a-z0-9]+-${vercel.team}\\.vercel\\.app$`);
    if (!host || !expectedHost.test(host)) {
      refuse(
        "deployment_wrong_project",
        `its URL ${JSON.stringify(latest.environment_url ?? null)} is not a deployment of Vercel project ${vercel.project} of team ${vercel.team}`,
      );
    }
  }

  const newest = (await github.deploymentsFor(vercel.environment))
    .filter((candidate) => same(candidate?.creator, vercel.creator))
    .reduce((top, candidate) => (Number(candidate.id) > Number(top?.id ?? 0) ? candidate : top), null);
  if (newest?.id !== id) {
    refuse("deployment_superseded", `the newest ${vercel.environment} deployment by ${vercel.creator.login} is ${newest?.id ?? "none"}, for ${newest?.sha ?? "no commit"}`);
  }
  return { summary, reasons };
}

/** Evaluates a normal-release request against every gate. Reads Git and GitHub; writes nothing. */
export async function evaluateRelease({ git, github, repository, repositoryId, request, mainRef, serverUrl }) {
  const { sha } = request;
  const tagName = `v${request.version}`;
  const report = {
    command: "evaluate-release",
    schema: RELEASE_PLAN_SCHEMA,
    decision: null,
    publication: "none",
    repository,
    repositoryId,
    mainRef,
    request: describeRequest(request),
    owner: null,
    main: null,
    tag: { name: tagName, provisional: true },
    existingTag: null,
    release: null,
    schemaBoundary: null,
    dispatch: null,
    ci: null,
    deployment: null,
    records: { review: null, productionAcceptance: null, ownerApproval: null, hostedMigration: null },
    gates: GATES.map((gate) => ({ gate, state: "not_checked", reasons: [] })),
    reasons: [],
    approvalTemplate: null,
    notes: null,
  };
  const gate = (name) => report.gates.find((entry) => entry.gate === name);
  const settle = (name, reasons) => {
    const entry = gate(name);
    entry.reasons.push(...reasons);
    entry.state = entry.reasons.some((r) => r.kind === "refusal")
      ? "refused"
      : entry.reasons.some((r) => r.kind === "failed")
        ? "failed"
        : entry.reasons.length > 0
          ? "pending"
          : "satisfied";
  };
  const finish = () => {
    // Only a refused, failed or pending gate leaves another unchecked. Should any gate be unchecked otherwise,
    // it refuses: nothing is published on a gate nobody checked. A local evaluation names no dispatch.
    const refusing = report.gates.some((entry) => ["refused", "failed", "pending"].includes(entry.state));
    const unchecked = report.gates.filter((entry) => entry.state === "not_checked" && !(entry.gate === "dispatch" && request.dispatch === null));
    if (!refusing && unchecked.length > 0) {
      for (const entry of unchecked) settle(entry.gate, [refusal(entry.gate, "gate_not_checked", `the ${entry.gate} gate could not be checked`, sha)]);
    }
    report.reasons = report.gates.flatMap((entry) => entry.reasons);
    const states = new Set(report.gates.map((entry) => entry.state));
    if (states.has("refused")) report.decision = "refused";
    else if (states.has("failed")) report.decision = "failed";
    else if (states.has("pending")) report.decision = "pending";
    else if (report.existingTag) report.decision = "already_published";
    else report.decision = "eligible";
    if (report.decision === "already_published") report.tag = null;
    return report;
  };

  const tags = git.tags();
  await assertCheckoutTagsCurrent(github, tags);

  // History first: nothing else can be read about a commit this clone does not have on main.
  const range = await readAcceptedRange({ git, github, repository, sha, mainRef, serverUrl, ignoreNormalTagAt: sha });
  const identity = range.reasons.filter((r) => IDENTITY_CODES.has(r.code));
  if (identity.length > 0) {
    settle("history", identity.map((r) => ({ ...r, gate: "history" })));
    return finish();
  }
  settle("history", range.reasons.map((r) => ({ ...r, kind: r.kind === "pending_decision" ? "pending" : r.kind, gate: "history" })));

  const { policy, reasons: policyReasons } = readPolicy(git.fileAt(sha, POLICY_PATH), repository);
  settle("policy", policyReasons);
  report.owner = policy?.owner ?? null;

  if (policy && request.dispatch) {
    const dispatch = await checkDispatch({ github, repository, repositoryId, sha, dispatch: request.dispatch, owner: policy.owner });
    report.dispatch = dispatch.summary;
    settle("dispatch", dispatch.reasons);
  }

  const localMain = git.commit(mainRef);
  const remoteMain = (await github.branchReference(MAIN_BRANCH))?.object?.sha ?? null;
  report.main = remoteMain;
  const mainReasons = [];
  if (localMain !== sha || remoteMain !== sha) {
    mainReasons.push(
      refusal("main", "main_moved", `${sha} was approved, but ${mainRef} is ${localMain ?? "missing"} and GitHub's ${MAIN_BRANCH} is ${remoteMain ?? "missing"}`, sha),
    );
  }

  report.ci = await evaluateFinalMergeCi({ github, repository, repositoryId, sha, runId: null });
  settle("ci", report.ci.reasons.map((r) => ({ ...r, gate: "ci" })));

  if (!range.base || range.reasons.length > 0) {
    settle("main", mainReasons);
    return finish();
  }
  const { base, merges } = range;

  // The version, and whether its tag is free or already this release.
  const policyName = policyFor(base.version);
  const prepared = verifyMergedPreparation({ git, repository, sha, base, merges, pr: request.preparationPr });
  const versionReasons = [];
  if (request.version === "1.0.0" && policyName === "0.x") {
    versionReasons.push(
      refusal("version", "stable_contract_acceptance_undecided", `1.0.0 needs the Owner's stable-contract acceptance, and no reviewed way to record and check it exists yet`, sha),
    );
  } else if (prepared.version !== request.version) {
    versionReasons.push(
      refusal("version", "version_mismatch", `${tagName} was requested, but the accepted merges after ${base.tag} calculate ${prepared.version ?? "nothing"}`, sha),
    );
  }
  const normalTags = tags.filter((tag) => NORMAL_TAG.test(tag.name));
  const existing = normalTags.find((tag) => tag.name === tagName) ?? null;
  const otherAtSha = normalTags.filter((tag) => tag.name !== tagName && peeledCommit(tag) === sha).map((tag) => tag.name);
  if (otherAtSha.length > 0) {
    versionReasons.push(refusal("version", "target_already_released", `${sha} is already released as ${otherAtSha.join(", ")}`, sha));
  }
  if (!existing) {
    const newer = normalTags.filter((tag) => compareVersions(tag.name.slice(1), request.version) >= 0).map((tag) => tag.name);
    if (newer.length > 0) {
      versionReasons.push(refusal("version", "normal_version_not_newest", `${newer.join(", ")} already exist, so ${tagName} would not be the newest release`, sha));
    }
  } else if (existing.objectType !== "tag" || existing.peeledType !== "commit" || existing.peeledName !== sha) {
    versionReasons.push(refusal("version", "normal_tag_conflict", `${tagName} exists and is not an annotated tag of ${sha}`, sha));
  }

  const preparationGate = prepared.reasons.map((r) => ({ ...r, gate: "preparation" }));
  settle("preparation", preparationGate);
  const preparedHere = prepared.preparation?.mergeSha === sha && prepared.preparation?.pr === request.preparationPr;
  if (prepared.version) {
    report.release = {
      version: prepared.version,
      policy: policyName,
      highestChange: prepared.highestChange,
      base,
      notesDigest: notesDigest({ repository, sha, version: prepared.version, base, highestChange: prepared.highestChange, merges }),
      preparationPr: request.preparationPr,
      reviewedHead: preparedHere ? prepared.preparation.reviewedHead : null,
      releaseDate: prepared.releaseDate,
      candidateMetadata: prepared.candidateMetadata,
      merges: merges.map(({ pr, mergeSha, headSha, title, type, change }) => ({ pr, mergeSha, headSha, title, type, change })),
    };
    report.notes = prepared.notes;
  }

  // The schema boundary: the migration tree at the base release and at the commit.
  const boundary = { before: git.objectAt(base.commit, MIGRATIONS_PATH), after: git.objectAt(sha, MIGRATIONS_PATH) };
  const changed = boundary.before !== boundary.after;
  const changedBy = changed
    ? merges.filter((merge) => git.objectAt(`${merge.mergeSha}^1`, MIGRATIONS_PATH) !== git.objectAt(merge.mergeSha, MIGRATIONS_PATH)).map((merge) => merge.pr)
    : [];
  report.schemaBoundary = { state: changed ? "changed" : "unchanged", ...boundary, value: formatBoundary(boundary), changedBy };
  if (!changed) {
    settle("schema-boundary", request.hostedMigration ? [refusal("schema-boundary", "hosted_migration_record_unexpected", `the migration tree is unchanged since ${base.tag}, so no hosted migration record belongs to this release`, sha)] : []);
    gate("hosted-migration").state = request.hostedMigration ? "not_checked" : "not_required";
  } else if (!request.hostedMigration) {
    settle("schema-boundary", [
      refusal("schema-boundary", "hosted_migration_record_required", `the migration tree changed since ${base.tag} (${report.schemaBoundary.value}), in ${changedBy.map((pr) => `#${pr}`).join(", ")}; a hosted migration record is required`, sha),
    ]);
  } else {
    settle("schema-boundary", []);
    if (policy) {
      const hosted = await readRecord({
        github,
        gate: "hosted-migration",
        kind: "hosted-migration",
        reference: request.hostedMigration,
        issuer: policy.issuers["hosted-migration"],
        owner: policy.owner,
        repository,
        pullRequest: null,
        expected: { "schema-boundary": report.schemaBoundary.value, "migration-first": "applied-before-merge", "hosted-preservation": "verified" },
      });
      report.records.hostedMigration = hosted.record;
      for (const merge of merges.filter((m) => changedBy.includes(m.pr))) {
        const mergedAt = (await github.pullRequest(merge.pr))?.merged_at ?? null;
        if (isBefore(hosted.createdAt, mergedAt) !== true) {
          hosted.reasons.push(
            refusal("hosted-migration", "evidence_out_of_order", `hosted-migration record ${request.hostedMigration.text} was created at ${hosted.createdAt ?? "an unknown time"}, not before #${merge.pr} merged at ${mergedAt ?? "an unknown time"}; migrations must reach hosted Supabase first`, sha),
          );
        }
      }
      settle("hosted-migration", hosted.reasons);
    }
  }

  // An existing tag is this release only if it carries this release's provenance. Its evidence is checked below
  // like any request's.
  if (existing && versionReasons.length === 0) {
    const differences = [];
    if (!policy || !report.release || gate("preparation").state !== "satisfied" || report.ci.satisfiedBy === null) {
      differences.push("this release's policy, preparation and CI cannot all be verified");
    } else {
      const object = git.tagObject(existing.objectName);
      if (object.tag !== tagName) differences.push(`its tag object is named ${JSON.stringify(object.tag)}`);
      if (object.type !== "commit" || object.object !== sha) differences.push(`its tag object tags ${object.type} ${object.object}`);
      differences.push(...(await releaseProvenanceDifferences(github, object.message, report)));
    }
    if (differences.length > 0) {
      versionReasons.push(refusal("version", "normal_tag_conflict", `${tagName} tags ${sha}, but ${differences.join("; ")}`, sha));
    } else {
      report.existingTag = { name: tagName, object: existing.objectName, commit: sha };
    }
  }
  settle("version", versionReasons);
  // Once this release is published, main and production may move on; neither gates it any more.
  if (report.existingTag) gate("main").state = "not_required";
  else settle("main", mainReasons);

  let deployment = null;
  if (policy) {
    deployment = await checkDeployment({ github, vercel: policy.vercel, sha, id: request.deployment });
    report.deployment = deployment.summary;
    settle("deployment", report.existingTag ? deployment.reasons.filter((r) => r.code !== "deployment_superseded") : deployment.reasons);
  }

  if (policy && preparedHere) {
    const pull = await github.pullRequest(request.preparationPr);
    const review = await readRecord({
      github,
      gate: "review",
      kind: "independent-review",
      reference: request.review,
      issuer: policy.issuers["independent-review"],
      owner: policy.owner,
      repository,
      pullRequest: request.preparationPr,
      expected: { "pull-request": String(request.preparationPr), "reviewed-head": report.release.reviewedHead, version: request.version },
      verdict: "READY",
    });
    report.records.review = review.record;
    if (review.createdAt && notAfter(review.createdAt, pull?.merged_at) !== true) {
      review.reasons.push(
        refusal("review", "evidence_out_of_order", `independent-review record ${request.review.text} was created at ${review.createdAt}, after #${request.preparationPr} merged at ${pull?.merged_at ?? "an unknown time"}`, sha),
      );
    }
    settle("review", review.reasons);
  }

  let acceptance = null;
  if (policy) {
    acceptance = await readRecord({
      github,
      gate: "production-acceptance",
      kind: "production-acceptance",
      reference: request.productionAcceptance,
      issuer: policy.issuers["production-acceptance"],
      owner: policy.owner,
      repository,
      pullRequest: request.preparationPr,
      expected: { version: request.version, commit: sha, deployment: String(request.deployment) },
      verdict: "ACCEPTED",
    });
    report.records.productionAcceptance = acceptance.record;
    const succeededAt = deployment?.summary.succeededAt ?? null;
    if (acceptance.createdAt && succeededAt && notAfter(succeededAt, acceptance.createdAt) !== true) {
      acceptance.reasons.push(
        refusal("production-acceptance", "evidence_out_of_order", `production-acceptance record ${request.productionAcceptance.text} was created at ${acceptance.createdAt}, before deployment ${request.deployment} succeeded at ${succeededAt}`, sha),
      );
    }
    settle("production-acceptance", acceptance.reasons);
  }

  if (policy && preparedHere && prepared.releaseDate) {
    const expectedApproval = {
      repository,
      version: request.version,
      tag: tagName,
      commit: sha,
      "pull-request": String(request.preparationPr),
      "reviewed-head": report.release.reviewedHead,
      "release-date": prepared.releaseDate,
      "schema-boundary": report.schemaBoundary.value,
      deployment: String(request.deployment),
      review: request.review.text,
      "production-acceptance": request.productionAcceptance.text,
      "hosted-migration": request.hostedMigration?.text ?? "none",
      "authorized-actions": AUTHORIZED_ACTIONS,
    };
    const approval = await readRecord({
      github,
      gate: "owner-approval",
      kind: "owner-release-approval",
      reference: request.ownerApproval,
      issuer: policy.owner,
      owner: policy.owner,
      repository,
      pullRequest: request.preparationPr,
      expected: expectedApproval,
    });
    report.records.ownerApproval = approval.record;
    if (approval.createdAt && acceptance?.createdAt && notAfter(acceptance.createdAt, approval.createdAt) !== true) {
      approval.reasons.push(
        refusal("owner-approval", "evidence_out_of_order", `owner-release-approval record ${request.ownerApproval.text} was created at ${approval.createdAt}, before the production acceptance at ${acceptance.createdAt}`, sha),
      );
    }
    settle("owner-approval", approval.reasons);
    const others = report.gates.filter((entry) => entry.gate !== "owner-approval" && entry.gate !== "dispatch");
    if (others.every((entry) => entry.state === "satisfied" || entry.state === "not_required")) {
      report.approvalTemplate = renderBlock("owner-release-approval", expectedApproval);
    }
  }
  return finish();
}

/** Why a value read from a plan file cannot be an evaluate-release plan for this repository. Empty when it can. */
export function releasePlanProblems(plan, { repository, repositoryId }) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["the plan is not a JSON object"];
  const problems = [];
  if (plan.command !== "evaluate-release") problems.push("it was not written by evaluate-release");
  if (plan.schema !== RELEASE_PLAN_SCHEMA) problems.push(`its schema is ${JSON.stringify(plan.schema ?? null)}`);
  if (plan.repository !== repository) problems.push(`it is for ${JSON.stringify(plan.repository ?? null)}, not ${repository}`);
  if ((plan.repositoryId ?? null) !== repositoryId) {
    problems.push(`its repository id is ${JSON.stringify(plan.repositoryId ?? null)}, not ${JSON.stringify(repositoryId)}`);
  }
  if (!RELEASE_DECISIONS.has(plan.decision)) problems.push(`its decision ${JSON.stringify(plan.decision ?? null)} is not one evaluate-release reports`);
  if (!requestFromPlan(plan.request)) problems.push("it does not carry a complete release request");
  if (plan.decision === "eligible" && (!plan.release || typeof plan.release !== "object" || !plan.schemaBoundary)) {
    problems.push("it is eligible but has no release");
  }
  return problems;
}

function releaseDrift(plan, fresh) {
  const drift = [];
  const compare = (label, planned, actual) => {
    if (planned !== actual) drift.push(`${label} was ${JSON.stringify(planned ?? null)} and is ${JSON.stringify(actual ?? null)}`);
  };
  compare("the version", plan.release?.version, fresh.release?.version);
  compare("the classification", plan.release?.highestChange, fresh.release?.highestChange);
  compare("the base tag object", plan.release?.base?.tagObject, fresh.release?.base?.tagObject);
  compare("the notes digest", plan.release?.notesDigest, fresh.release?.notesDigest);
  compare("the reviewed head", plan.release?.reviewedHead, fresh.release?.reviewedHead);
  compare("the release date", plan.release?.releaseDate, fresh.release?.releaseDate);
  compare("the schema boundary", plan.schemaBoundary?.value, fresh.schemaBoundary?.value);
  for (const key of ["review", "productionAcceptance", "ownerApproval", "hostedMigration"]) {
    compare(`the ${key} record digest`, plan.records?.[key]?.digest, fresh.records?.[key]?.digest);
  }
  return drift;
}

/** Reads a normal tag back from GitHub and says whether it is this release. */
async function readBackRelease(github, { name, report }) {
  const reference = await github.tagReference(name);
  if (!reference) return { state: "missing", differences: [] };
  const differences = [];
  if (reference.ref !== `refs/tags/${name}`) differences.push(`GitHub answered for ${JSON.stringify(reference.ref)}`);
  if (reference.object?.type !== "tag" || !FULL_SHA.test(String(reference.object?.sha ?? ""))) {
    differences.push(`refs/tags/${name} points at ${reference.object?.type ?? "nothing"} ${reference.object?.sha ?? ""}, not an annotated tag object`);
    return { state: "conflict", object: reference.object?.sha ?? null, differences };
  }
  const object = await github.tagObject(reference.object.sha);
  if (!object) return { state: "conflict", object: reference.object.sha, differences: [...differences, "its tag object cannot be read"] };
  if (object.sha !== reference.object.sha) differences.push(`GitHub answered with tag object ${object.sha}`);
  if (object.tag !== name) differences.push(`its tag object is named ${JSON.stringify(object.tag)}`);
  if (object.object?.type !== "commit" || object.object?.sha !== report.request.sha) {
    differences.push(`it peels to ${object.object?.type ?? "nothing"} ${object.object?.sha ?? ""}, not commit ${report.request.sha}`);
  }
  differences.push(...(await releaseProvenanceDifferences(github, object.message ?? "", report)));
  const fields = parseReleaseProvenance(object.message ?? "");
  return {
    state: differences.length === 0 ? "matches" : "conflict",
    object: reference.object.sha,
    peeled: object.object?.sha ?? null,
    fields,
    differences,
  };
}

/** The report of a publication stopped by `reasons`, each also shown on its gate when it has one. */
function refusedPublication(report, reasons) {
  for (const reason of reasons) {
    const entry = report.gates.find((candidate) => candidate.gate === reason.gate);
    if (!entry) continue;
    entry.reasons.push(reason);
    entry.state = "refused";
  }
  report.decision = "refused";
  report.reasons = [...report.reasons, ...reasons];
  return report;
}

/**
 * Publishes the normal tag an eligible plan describes, if every gate still holds and normal publication is
 * activated. `dispatch` is the run and attempt the writer is part of, from the runner. `makeTagWriter` is
 * called only when everything is satisfied.
 */
export async function publishRelease({ git, github, makeTagWriter, repository, repositoryId, plan, dispatch, mainRef, serverUrl, activation }) {
  const problems = releasePlanProblems(plan, { repository, repositoryId });
  if (problems.length === 0 && plan.request.dispatch?.runId !== dispatch.runId) {
    problems.push(`it was made in run ${plan.request.dispatch?.runId ?? "none"}, not in this run ${dispatch.runId}`);
  }
  const notEligible = problems.length === 0 && plan.decision !== "eligible";
  if (problems.length > 0 || notEligible) {
    const request = problems.length === 0 ? plan.request : null;
    return {
      command: "publish-release",
      schema: RELEASE_PLAN_SCHEMA,
      decision: "refused",
      publication: "none",
      repository,
      repositoryId,
      mainRef,
      request,
      tag: null,
      existingTag: null,
      gates: [],
      reasons: [
        notEligible
          ? refusal("plan", "plan_not_eligible", `the plan's decision is ${plan.decision}; only an eligible plan is published`, plan.request.sha)
          : refusal("plan", "plan_invalid", `the plan cannot be used: ${problems.join("; ")}`),
      ],
    };
  }

  const request = { ...requestFromPlan(plan.request), dispatch };
  const report = await evaluateRelease({ git, github, repository, repositoryId, request, mainRef, serverUrl });
  report.command = "publish-release";

  if (report.decision === "already_published") {
    const confirmed = await readBackRelease(github, { name: report.existingTag.name, report });
    if (confirmed.state !== "matches") {
      throw new ControllerError(
        "tag_state_out_of_date",
        `${report.existingTag.name} does not read back from GitHub as it reads locally: ${confirmed.differences.join("; ") || "it is missing"}`,
      );
    }
    return report;
  }
  if (report.decision !== "eligible") return report;

  const drift = releaseDrift(plan, report);
  if (drift.length > 0) {
    return refusedPublication(report, [refusal("plan", "plan_drift", `the plan no longer matches Git and GitHub: ${drift.join("; ")}`, request.sha)]);
  }
  if (activation !== ACTIVATED) {
    report.decision = "publication_disabled";
    return report;
  }

  const name = report.tag.name;
  const mainMoved = (now, when) =>
    refusal("main", "main_moved", `${request.sha} was approved, but GitHub's ${MAIN_BRANCH} is ${now ?? "missing"} ${when}`, request.sha);
  const mainNow = async () => (await github.branchReference(MAIN_BRANCH))?.object?.sha ?? null;
  const before = await mainNow();
  if (before !== request.sha) return refusedPublication(report, [mainMoved(before, "before the tag object was created; nothing was written")]);

  const writer = makeTagWriter();
  let written;
  try {
    written = await createAnnotatedTag({
      writer,
      name,
      message: renderReleaseAnnotation(report),
      sha: request.sha,
      readBack: (tag) => readBackRelease(github, { name: tag, report }),
      beforeReference: async (object) => {
        const now = await mainNow();
        if (now !== request.sha) {
          throw Object.assign(new ControllerError("main_moved", `tag object ${object.sha} is unreferenced and nothing is published`), { main: now });
        }
      },
      what: NORMAL_TAG_WRITE,
    });
  } catch (error) {
    if (error instanceof ControllerError && error.code === "main_moved" && Object.hasOwn(error, "main")) {
      return refusedPublication(report, [mainMoved(error.main, `before its reference was created; ${error.message}`)]);
    }
    throw error;
  }

  const { created, object, confirmed } = written;
  if (!created) {
    if (confirmed.state === "matches") {
      report.decision = "already_published";
      report.tag = null;
      report.existingTag = { name, object: confirmed.object, commit: confirmed.peeled };
      return report;
    }
    return refusedPublication(report, [
      refusal("version", "normal_tag_name_collision", `${name} already exists and is not this release: ${confirmed.differences.join("; ")}. Nothing was moved`, request.sha),
    ]);
  }

  const expectedRun = String(report.ci.satisfiedBy.runId);
  const expectedAttempt = String(report.ci.satisfiedBy.attempt);
  if (
    confirmed.state !== "matches" ||
    confirmed.object !== object.sha ||
    confirmed.fields?.["CI-Run"] !== expectedRun ||
    confirmed.fields?.["CI-Attempt"] !== expectedAttempt ||
    confirmed.fields?.["Dispatch-Run"] !== `${dispatch.runId} ${dispatch.attempt}`
  ) {
    throw new ControllerError(
      "tag_readback_mismatch",
      `refs/tags/${name} was created but does not read back as tag object ${object.sha} of ${request.sha} from this run${confirmed.differences?.length ? `: ${confirmed.differences.join("; ")}` : ""}`,
    );
  }
  report.decision = "published";
  report.publication = "created";
  report.tag = { name, provisional: false, object: object.sha, commit: confirmed.peeled };
  return report;
}
