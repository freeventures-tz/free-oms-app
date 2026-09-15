/**
 * Build tags for exact merges: the evaluation every build command starts from, and the single path by
 * which a build tag is written.
 *
 * Evaluation only reads. Before it considers a tag it establishes three things: the checkout's tags
 * are GitHub's, the commit is an exact merge on main's first-parent line, and the run that triggered
 * it is final-merge CI for that commit. Then it calculates the commit's own target from its own
 * ancestral normal release, reads every final-merge CI run and job for the commit, inspects the build
 * tags that already exist, and ends in one decision:
 *
 *   eligible          every gate is satisfied; a provisional tag name is shown
 *   already_tagged    the commit's build tag exists and its provenance matches
 *   not_applicable    the commit is itself a normal release and has no build tag
 *   pending           CI has not finished, or a merge awaits an Owner decision
 *   failed            final-merge CI finished without satisfying a required gate
 *   refused           the identity, the history or an existing tag cannot be trusted
 *
 * `publishCommit` is the only writer; `publishBuild` reaches it with one plan, and a reconciliation
 * (lib/reconcile.mjs) with each commit it finds eligible. It evaluates the commit again — a plan handed to
 * it is compared with that evaluation, never trusted — and writes only when publication is activated. It allocates
 * the ordinal from the tags as they stand, creates the annotated object and then a reference that is
 * never forced, and reports success only after reading both back from GitHub. A name GitHub refuses is
 * read back too: this commit's matching build tag is a no-op, anything else is a refusal, and no other
 * name is ever tried. Later publishers are meant to reach GitHub through this module, from inside the
 * one workflow job that holds the writer lock.
 */

import {
  buildTagName,
  expectedProvenance,
  inspectBuildTags,
  notesDigest,
  parseBuildProvenance,
  provenanceDifferences,
  renderBuildAnnotation,
} from "./build-tags.mjs";
import { FINAL_MERGE_CI, evaluateFinalMergeCi } from "./ci.mjs";
import { highestChange } from "./classification.mjs";
import { FULL_SHA } from "./cli.mjs";
import { ControllerError } from "./errors.mjs";
import { STATUS_CONTEXT } from "./github.mjs";
import { readAcceptedRange } from "./history.mjs";
import { NORMAL_TAG, nextVersion, policyFor } from "./version.mjs";

export const PLAN_SCHEMA = 1;

/** The only value of RELEASE_BUILD_PUBLICATION that lets anything be written. */
export const ACTIVATED = "enabled";

const IDENTITY_CODES = new Set(["unknown_commit", "unknown_main_ref", "not_on_main_first_parent"]);
const PLAN_DECISIONS = new Set(["eligible", "already_tagged", "not_applicable", "pending", "failed", "refused"]);
const STATUS_DESCRIPTION_LIMIT = 140;

const refusal = (code, detail, commit) => ({ kind: "refusal", code, detail, commit, pr: null });

export async function assertCheckoutTagsCurrent(github, tags) {
  const local = new Map(tags.map((tag) => [tag.name, tag.objectName]));
  const remote = new Map(
    (await github.tagReferences()).map((ref) => [ref.ref.slice("refs/tags/".length), ref.object?.sha ?? null]),
  );
  const differing = [];
  for (const [name, object] of remote) if (local.get(name) !== object) differing.push(name);
  for (const name of local.keys()) if (!remote.has(name)) differing.push(name);
  if (differing.length > 0) {
    throw new ControllerError(
      "tag_state_out_of_date",
      `the checkout's tags are not GitHub's (${differing.slice(0, 5).join(", ")}${differing.length > 5 ? ", …" : ""}); fetch every tag and evaluate again`,
    );
  }
}

function describeStatus(text) {
  return text.length <= STATUS_DESCRIPTION_LIMIT ? text : `${text.slice(0, STATUS_DESCRIPTION_LIMIT - 1)}…`;
}

/** The commit status a report calls for, or null when it calls for none. */
export function commitStatusFor(report) {
  const codes = [...new Set(report.reasons.map((r) => r.code))].join(", ");
  const status = (state, text) => ({ context: STATUS_CONTEXT, state, description: describeStatus(text) });
  switch (report.decision) {
    case "tagged":
      return status("success", `Build tag ${report.tag.name}`);
    case "already_tagged":
      return status("success", `Build tag ${report.existingTag.name}`);
    case "eligible":
      return status("pending", `Eligible for a ${report.target.version} build tag; the tag writer has not confirmed one`);
    case "pending":
      return status("pending", `No build tag yet: ${codes}`);
    case "failed":
      return status("failure", `No build tag, a required CI gate is unsatisfied: ${codes}`);
    case "refused":
      return status("failure", `No build tag, refused: ${codes}`);
    default:
      return null;
  }
}

function finish(report, decision, reasons = []) {
  report.decision = decision;
  report.reasons = reasons;
  report.status = commitStatusFor(report);
  return report;
}

/**
 * Whether an annotation's CI run and attempt prove that this commit passed final-merge CI. The cited
 * attempt itself must have concluded success with every required gate passing in it. Other attempts do
 * not matter either way: a later failing re-run cannot unprove an attempt that passed, and a later
 * passing one cannot prove an attempt that did not. An attempt that has not finished, or that GitHub
 * cannot describe, proves nothing.
 */
export function ciEvidenceDifferences(fields, report) {
  if (!fields) return [];
  const run = report.ci.runs.find((candidate) => String(candidate.runId) === fields["CI-Run"]);
  if (!run) return [`CI-Run ${fields["CI-Run"]} is not a final-merge CI run of this commit`];
  const attempt = run.attempts.find((candidate) => String(candidate.attempt) === fields["CI-Attempt"]);
  if (!attempt) return [`CI-Attempt ${fields["CI-Attempt"]} is not an attempt of run ${run.runId}`];
  if (!attempt.satisfied) {
    const outcome = [
      attempt.status === "completed" ? `concluded ${attempt.conclusion ?? "without a conclusion"}` : `is ${attempt.status ?? "unavailable"}`,
      ...attempt.gates.filter((gate) => gate.result !== "success").map((gate) => `${gate.name} ${gate.result}`),
    ];
    return [`run ${run.runId} attempt ${attempt.attempt} did not pass final-merge CI (${outcome.join("; ")})`];
  }
  return [];
}

function verifyExistingBuildTag({ git, existing, report, rangeReasons }) {
  if (!report.target) {
    const codes = rangeReasons.map((r) => r.code).join(", ") || "no accepted merge";
    return { ok: false, differences: [`this commit's target cannot be calculated again (${codes})`] };
  }
  const object = git.tagObject(existing.object);
  const differences = [];
  if (object.tag !== existing.name) differences.push(`its tag object is named ${JSON.stringify(object.tag)}`);
  if (object.type !== "commit" || object.object !== report.sha) {
    differences.push(`its tag object tags ${object.type} ${object.object}`);
  }
  differences.push(
    ...provenanceDifferences({
      message: object.message,
      expected: expectedProvenance({
        tag: existing.name,
        repository: report.repository,
        sha: report.sha,
        target: report.target,
        ciWorkflowPath: FINAL_MERGE_CI.workflowPath,
      }),
    }),
  );
  const fields = parseBuildProvenance(object.message);
  differences.push(...ciEvidenceDifferences(fields, report));
  return {
    ok: differences.length === 0,
    differences,
    ciRun: fields?.["CI-Run"] ?? null,
    ciAttempt: fields?.["CI-Attempt"] ?? null,
  };
}

/** Evaluates one exact merge for a build tag. Reads Git and GitHub; writes nothing. */
export async function evaluateBuild(options) {
  await assertCheckoutTagsCurrent(options.github, options.git.tags());
  return evaluateCommit(options);
}

/**
 * The same evaluation, for a caller that has already checked the checkout's tags against GitHub's: a
 * reconciliation checks them once for every commit it evaluates.
 */
export async function evaluateCommit({ git, github, repository, repositoryId, sha, runId, mainRef, serverUrl }) {
  const report = {
    command: "evaluate-build",
    schema: PLAN_SCHEMA,
    decision: null,
    publication: "none",
    repository,
    repositoryId,
    sha,
    runId,
    mainRef,
    status: null,
    target: null,
    tag: null,
    existingTag: null,
    releasedAs: [],
    ci: null,
    reasons: [],
  };

  const tags = git.tags();
  const range = await readAcceptedRange({ git, github, repository, sha, mainRef, serverUrl, ignoreNormalTagAt: sha });
  const identity = range.reasons.filter((r) => IDENTITY_CODES.has(r.code));
  if (identity.length > 0) return finish(report, "refused", identity);

  report.ci = await evaluateFinalMergeCi({ github, repository, repositoryId, sha, runId });
  const ciIdentity = report.ci.reasons.filter((r) => r.kind === "refusal");
  if (ciIdentity.length > 0) return finish(report, "refused", ciIdentity);

  if (range.base && range.reasons.length === 0 && range.merges.length > 0) {
    const highest = highestChange(range.merges.map((merge) => merge.change));
    const { version } = nextVersion({ baseVersion: range.base.version, highest, stableContractAcceptance: null });
    report.target = {
      version,
      policy: policyFor(range.base.version),
      highestChange: highest,
      base: range.base,
      notesDigest: notesDigest({ repository, sha, version, base: range.base, highestChange: highest, merges: range.merges }),
      merges: range.merges.map((merge) => ({ pr: merge.pr, mergeSha: merge.mergeSha, title: merge.title, change: merge.change })),
    };
  }

  report.releasedAs = tags
    .filter((tag) => NORMAL_TAG.test(tag.name) && (tag.objectType === "tag" ? tag.peeledName : tag.objectName) === sha)
    .map((tag) => tag.name);

  const inventory = inspectBuildTags({
    tags,
    sha,
    version: report.target?.version ?? null,
    repository,
    readMessage: (object) => git.tagObject(object).message,
  });

  // Every build reference on the commit counts — a lightweight or malformed one too — before a valid tag
  // can be confirmed, so an incompatible duplicate is never hidden behind an idempotent success.
  const onCommit = [
    ...inventory.forCommit.map((tag) => tag.name),
    ...inventory.untrustedOnCommit.map((tag) => tag.name),
  ].sort();
  if (onCommit.length > 1) {
    return finish(report, "refused", [
      refusal(
        "duplicate_build_tags",
        `${onCommit.join(" and ")} are all build tags of ${sha}; none is confirmed and no other is allocated`,
        sha,
      ),
      ...inventory.untrustedOnCommit.map((tag) => tag.reason),
    ]);
  }
  if (inventory.forCommit.length === 1) {
    const [existing] = inventory.forCommit;
    const verdict = verifyExistingBuildTag({ git, existing, report, rangeReasons: range.reasons });
    if (!verdict.ok) {
      return finish(report, "refused", [
        refusal("conflicting_build_provenance", `${existing.name} tags ${sha}, but ${verdict.differences.join("; ")}`, sha),
      ]);
    }
    report.existingTag = { name: existing.name, object: existing.object, ciRun: verdict.ciRun, ciAttempt: verdict.ciAttempt };
    return finish(report, "already_tagged");
  }
  if (report.releasedAs.length > 0) return finish(report, "not_applicable");

  const reasons = [...range.reasons, ...report.ci.reasons, ...inventory.problems];
  if (reasons.length === 0 && !report.target) {
    reasons.push(refusal("no_accepted_merge", `${sha} has no accepted merge to build`, sha));
  }
  if (reasons.some((r) => r.kind === "refusal")) return finish(report, "refused", reasons);
  if (reasons.some((r) => r.kind === "failed")) return finish(report, "failed", reasons);
  if (reasons.length > 0) return finish(report, "pending", reasons);

  const ordinal = inventory.highestOrdinal + 1;
  report.tag = { name: buildTagName(report.target.version, ordinal), ordinal, provisional: true };
  return finish(report, "eligible");
}

/** Why a value read from a plan file cannot be a plan for this repository. Empty when it can. */
export function planProblems(plan, { repository, repositoryId }) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["the plan is not a JSON object"];
  const problems = [];
  if (plan.command !== "evaluate-build") problems.push("it was not written by evaluate-build");
  if (plan.schema !== PLAN_SCHEMA) problems.push(`its schema is ${JSON.stringify(plan.schema ?? null)}`);
  if (plan.repository !== repository) problems.push(`it is for ${JSON.stringify(plan.repository ?? null)}, not ${repository}`);
  if ((plan.repositoryId ?? null) !== repositoryId) {
    problems.push(`its repository id is ${JSON.stringify(plan.repositoryId ?? null)}, not ${JSON.stringify(repositoryId)}`);
  }
  if (!FULL_SHA.test(String(plan.sha ?? ""))) problems.push("its sha is not a full commit sha");
  if (plan.runId !== null && !(Number.isSafeInteger(plan.runId) && plan.runId > 0)) problems.push("its run id is not a positive integer");
  if (!PLAN_DECISIONS.has(plan.decision)) {
    problems.push(`its decision ${JSON.stringify(plan.decision ?? null)} is not one evaluate-build reports`);
  }
  if (plan.decision === "eligible" && (!plan.target || typeof plan.target !== "object")) {
    problems.push("it is eligible but has no target");
  }
  if (plan.decision === "already_tagged" && typeof plan.existingTag?.name !== "string") {
    problems.push("it is already tagged but names no tag");
  }
  return problems;
}

function planDrift(plan, fresh) {
  const drift = [];
  const compare = (label, planned, actual) => {
    if (planned !== actual) drift.push(`${label} was ${JSON.stringify(planned ?? null)} and is ${JSON.stringify(actual ?? null)}`);
  };
  compare("the target version", plan.target?.version, fresh.target?.version);
  compare("the classification", plan.target?.highestChange, fresh.target?.highestChange);
  compare("the normal-release base", plan.target?.base?.tag, fresh.target?.base?.tag);
  compare("the base tag object", plan.target?.base?.tagObject, fresh.target?.base?.tagObject);
  compare("the notes digest", plan.target?.notesDigest, fresh.target?.notesDigest);
  return drift;
}

/** Reads a build tag back from GitHub and says whether it is this commit's build tag. */
async function readBack(github, { name, report }) {
  const reference = await github.tagReference(name);
  if (!reference) return { state: "missing", differences: [] };

  const differences = [];
  if (reference.ref !== `refs/tags/${name}`) differences.push(`GitHub answered for ${JSON.stringify(reference.ref)}`);
  if (reference.object?.type !== "tag" || !FULL_SHA.test(String(reference.object?.sha ?? ""))) {
    differences.push(`refs/tags/${name} points at ${reference.object?.type ?? "nothing"} ${reference.object?.sha ?? ""}, not an annotated tag object`);
    return { state: "conflict", object: reference.object?.sha ?? null, differences };
  }

  const object = await github.tagObject(reference.object.sha);
  if (!object) {
    return { state: "conflict", object: reference.object.sha, differences: [...differences, "its tag object cannot be read"] };
  }
  if (object.sha !== reference.object.sha) differences.push(`GitHub answered with tag object ${object.sha}`);
  if (object.tag !== name) differences.push(`its tag object is named ${JSON.stringify(object.tag)}`);
  if (object.object?.type !== "commit" || object.object?.sha !== report.sha) {
    differences.push(`it peels to ${object.object?.type ?? "nothing"} ${object.object?.sha ?? ""}, not commit ${report.sha}`);
  }
  differences.push(
    ...provenanceDifferences({
      message: object.message ?? "",
      expected: expectedProvenance({
        tag: name,
        repository: report.repository,
        sha: report.sha,
        target: report.target,
        ciWorkflowPath: FINAL_MERGE_CI.workflowPath,
      }),
    }),
  );
  const fields = parseBuildProvenance(object.message ?? "");
  differences.push(...ciEvidenceDifferences(fields, report));
  return {
    state: differences.length === 0 ? "matches" : "conflict",
    object: reference.object.sha,
    peeled: object.object?.sha ?? null,
    ciRun: fields?.["CI-Run"] ?? null,
    ciAttempt: fields?.["CI-Attempt"] ?? null,
    differences,
  };
}

function publicationOf(report, decision, reasons = []) {
  report.command = "publish-build";
  return finish(report, decision, reasons);
}

/**
 * Publishes the build tag an eligible plan describes, if the commit is still eligible and publication
 * is activated. `makeTagWriter` is called only once both are true.
 */
export async function publishBuild({ git, github, makeTagWriter, repository, repositoryId, plan, mainRef, serverUrl, activation }) {
  // A plan that cannot be published is refused before anything is read.
  const problems = planProblems(plan, { repository, repositoryId });
  const notEligible = problems.length === 0 && plan.decision !== "eligible";
  if (problems.length > 0 || notEligible) {
    const sha = FULL_SHA.test(String(plan?.sha ?? "")) ? plan.sha : null;
    const report = {
      command: "publish-build",
      schema: PLAN_SCHEMA,
      decision: null,
      publication: "none",
      repository,
      repositoryId,
      sha,
      runId: notEligible ? plan.runId : null,
      mainRef,
      status: null,
      target: null,
      tag: null,
      existingTag: null,
      releasedAs: [],
      ci: null,
      reasons: [],
    };
    return publicationOf(report, "refused", [
      notEligible
        ? refusal("plan_not_eligible", `the plan's decision is ${plan.decision}; only an eligible plan is published`, sha)
        : refusal("plan_invalid", `the plan cannot be used: ${problems.join("; ")}`, sha),
    ]);
  }

  return publishCommit({
    git,
    github,
    makeTagWriter,
    repository,
    repositoryId,
    sha: plan.sha,
    runId: plan.runId,
    planned: plan,
    mainRef,
    serverUrl,
    activation,
  });
}

/**
 * The one path that writes a build tag, for one commit. It evaluates the commit again, refuses when the
 * target `planned` carries no longer matches that evaluation, and writes only when the commit is eligible
 * and publication is activated. A reconciliation publishes each eligible commit through here in turn.
 */
export async function publishCommit({ git, github, makeTagWriter, repository, repositoryId, sha, runId, planned, mainRef, serverUrl, activation }) {
  const report = await evaluateBuild({ git, github, repository, repositoryId, sha, runId, mainRef, serverUrl });
  report.command = "publish-build";

  if (report.decision === "eligible" || report.decision === "already_tagged") {
    const drift = planDrift(planned, report);
    if (drift.length > 0) {
      return publicationOf(report, "refused", [
        refusal("plan_drift", `the plan no longer matches Git and GitHub: ${drift.join("; ")}`, sha),
      ]);
    }
  }
  if (report.decision === "already_tagged") {
    const confirmed = await readBack(github, { name: report.existingTag.name, report });
    if (confirmed.state !== "matches") {
      throw new ControllerError(
        "tag_state_out_of_date",
        `${report.existingTag.name} does not read back from GitHub as it reads locally: ${confirmed.differences.join("; ") || "it is missing"}`,
      );
    }
    return report;
  }
  if (report.decision !== "eligible") return report;
  if (activation !== ACTIVATED) return publicationOf(report, "publication_disabled");

  const writer = makeTagWriter();
  const { name, ordinal } = report.tag;
  const message = renderBuildAnnotation({ tag: name, repository, sha, target: report.target, ci: report.ci });

  let object;
  try {
    object = await writer.createTagObject({ tag: name, message, commit: sha });
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError("tag_object_not_created", `no build tag was published for ${sha}: ${error.message}`);
  }

  let reference;
  try {
    reference = await writer.createTagReference({ tag: name, object: object.sha });
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError(
      "tag_reference_unconfirmed",
      `tag object ${object.sha} for ${name} exists, but its reference was not confirmed (${error.message}). An unreferenced tag object is not a published build; a retry reads the references again`,
    );
  }

  let confirmed;
  try {
    confirmed = await readBack(github, { name, report });
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError(
      "tag_readback_failed",
      `${name} could not be read back (${error.message}); nothing is reported as published, and a retry confirms it from GitHub`,
    );
  }

  if (!reference.created) {
    if (confirmed.state === "missing") {
      throw new ControllerError(
        "tag_reference_unconfirmed",
        `GitHub refused refs/tags/${name} and no such reference exists; tag object ${object.sha} is unreferenced and nothing is published`,
      );
    }
    if (confirmed.state === "matches") {
      report.tag = null;
      report.existingTag = { name, object: confirmed.object, ciRun: confirmed.ciRun, ciAttempt: confirmed.ciAttempt };
      return publicationOf(report, "already_tagged");
    }
    return publicationOf(report, "refused", [
      refusal(
        "build_tag_name_collision",
        `${name} already exists and is not this commit's build tag: ${confirmed.differences.join("; ")}. No other name is tried`,
        sha,
      ),
    ]);
  }

  const expectedRun = String(report.ci.satisfiedBy.runId);
  const expectedAttempt = String(report.ci.satisfiedBy.attempt);
  if (
    confirmed.state !== "matches" ||
    confirmed.object !== object.sha ||
    confirmed.ciRun !== expectedRun ||
    confirmed.ciAttempt !== expectedAttempt
  ) {
    throw new ControllerError(
      "tag_readback_mismatch",
      `refs/tags/${name} was created but does not read back as tag object ${object.sha} of ${sha} with run ${expectedRun} attempt ${expectedAttempt}${confirmed.differences?.length ? `: ${confirmed.differences.join("; ")}` : ""}`,
    );
  }

  report.publication = "created";
  report.tag = { name, ordinal, provisional: false, object: object.sha, commit: confirmed.peeled };
  return publicationOf(report, "tagged");
}

/**
 * The status to write on the commit, decided from `fresh`, an evaluation made when the status is
 * written. A plan is an older evaluation: CI may have been retried and the build tag published since,
 * so an old failed or pending plan must not report "no build tag" over a tag that exists. What exists
 * now decides. The plan and the writer's result only explain a commit that is still eligible and still
 * has no tag: if its own plan was eligible, the writer ran and did not tag it.
 */
export function statusToWrite({ plan, fresh, writer }) {
  if (fresh.decision === "eligible" && plan.decision === "eligible") {
    const detail = [writer.result || "no result", writer.decision].filter(Boolean).join(", ");
    return {
      context: STATUS_CONTEXT,
      state: "failure",
      description: describeStatus(`No build tag: the tag writer did not confirm one (${detail})`),
    };
  }
  return commitStatusFor(fresh);
}
