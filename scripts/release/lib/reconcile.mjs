/**
 * Reconciliation: which accepted merges on main are owed a build tag, and publishing each one that has
 * earned it. Every invocation derives this again from durable state — main's first-parent history, the
 * tags GitHub holds and each commit's own final-merge CI — never from which events arrived, in what order,
 * or which workflow runs survived. A CI completion and a recovery dispatch run the same reconciliation, so
 * a dropped, duplicated, late or replaced event can delay a build tag but cannot lose one.
 *
 * The window is main's first-parent line after the normal release BUILD_TAGS_OWED_AFTER. Each commit in it
 * is one of:
 *
 *   recorded                  its build tag is verified: in full, or from Git once a normal release contains it
 *   eligible                  its own evaluation, exactly as evaluate-build makes it, is eligible
 *   pending, failed, refused  blocked, with that evaluation's reasons and CI gates
 *   not_applicable            it is itself a normal release and has no build tag
 *
 * A commit stays in the window after later normal releases. A merge whose CI failed stays blocked until its
 * own gates pass, and is then calculated from its own ancestral release like any other.
 *
 * Publication goes through `publishCommit`, the one build-tag writer, oldest commit first, inside the job
 * that holds the writer lock. Each tag it confirms is added to what the next commit's evaluation sees, so
 * ordinals are allocated one at a time from the tags GitHub holds.
 */

import { ACTIVATED, assertCheckoutTagsCurrent, evaluateCommit, publishCommit, statusToWrite } from "./build.mjs";
import {
  BUILD_TAG_LIKE,
  buildTagName,
  expectedProvenance,
  GIT_CHECKED_FIELDS,
  parseBuildProvenance,
  provenanceDifferences,
  recordedPullRequest,
} from "./build-tags.mjs";
import { FINAL_MERGE_CI, verifyTriggerRun } from "./ci.mjs";
import { FULL_SHA } from "./cli.mjs";
import { ControllerError } from "./errors.mjs";
import { releaseBaseFor } from "./history.mjs";
import { BUILD_TAG, NORMAL_TAG } from "./version.mjs";

/**
 * Build tags are owed to every accepted merge on main's first-parent line after this normal release, the
 * last one before build tags existed. The merges it contains are released and are never tagged again.
 * Moving it is a reviewed change to this line, not an option: the writing commands refuse a plan whose
 * window starts anywhere else.
 */
export const BUILD_TAGS_OWED_AFTER = "v0.0.6";

export const RECONCILIATION_SCHEMA = 1;

const RECONCILIATION_DECISIONS = new Set(["eligible", "nothing_to_publish", "refused"]);

const refusal = (code, detail, commit = null) => ({ kind: "refusal", code, detail, commit, pr: null });
const peeledCommit = (tag) => (tag.objectType === "tag" ? tag.peeledName : tag.objectName);

/** A Git reader that asks each question once. No command changes the checkout it reads. */
export function rememberingGit(git) {
  const answers = new Map();
  const once = (question, read) => {
    const key = JSON.stringify(question);
    if (!answers.has(key)) answers.set(key, read());
    return answers.get(key);
  };
  return {
    commit: (revision) => once(["commit", revision], () => git.commit(revision)),
    firstParentLine: (commit) => once(["line", commit], () => git.firstParentLine(commit)),
    isAncestor: (ancestor, descendant) => once(["ancestor", ancestor, descendant], () => git.isAncestor(ancestor, descendant)),
    message: (commit) => once(["message", commit], () => git.message(commit)),
    commitsBetween: (from, to) => once(["between", from, to], () => git.commitsBetween(from, to)),
    tagObject: (object) => once(["tag", object], () => git.tagObject(object)),
    tags: () => once(["tags"], () => git.tags()),
  };
}

/**
 * A GitHub reader that reads each pull request and the CI workflow once per command: a reconciliation
 * evaluates many commits whose ranges share merges. Tag references, runs, jobs and statuses are always
 * read again.
 */
export function rememberingGitHub(github) {
  const answers = new Map();
  const once = async (question, read) => {
    const key = JSON.stringify(question);
    if (!answers.has(key)) answers.set(key, await read());
    return answers.get(key);
  };
  return {
    ...github,
    pullRequest: (number) => once(["pull", number], () => github.pullRequest(number)),
    pullRequestsForCommit: (sha) => once(["pulls", sha], () => github.pullRequestsForCommit(sha)),
    workflow: (file) => once(["workflow", file], () => github.workflow(file)),
  };
}

/** The checkout's tags, plus each build tag this command has since confirmed on GitHub. */
function withConfirmedTags(git, confirmed) {
  const created = () => [...confirmed.values()];
  return {
    ...git,
    tags: () => [
      ...git.tags(),
      ...created().map((tag) => ({
        name: tag.name,
        objectType: "tag",
        objectName: tag.object,
        peeledType: "commit",
        peeledName: tag.commit,
      })),
    ],
    tagObject: (object) => {
      const tag = created().find((candidate) => candidate.object === object);
      return tag ? { object: tag.commit, type: "commit", tag: tag.name, message: tag.message } : git.tagObject(object);
    },
  };
}

/** A build tag as GitHub holds it, so the next commit's evaluation counts it. */
async function readConfirmedTag(github, name, sha) {
  const reference = await github.tagReference(name);
  const object = reference?.object?.type === "tag" ? await github.tagObject(reference.object.sha) : null;
  if (!object || object.tag !== name || object.object?.type !== "commit" || object.object?.sha !== sha) {
    throw new ControllerError(
      "tag_readback_mismatch",
      `${name} was confirmed for ${sha} but no longer reads back from GitHub as its annotated tag`,
    );
  }
  return { name, object: object.sha, commit: sha, message: object.message ?? "" };
}

/** Where the window starts: the commit an annotated `since` tag marks on main's first-parent line. */
function windowStart({ tags, line, since }) {
  const tag = tags.find((candidate) => candidate.name === since);
  if (!tag) return { reason: refusal("since_release_missing", `${since} is not a tag in this clone; fetch every tag`) };
  if (tag.objectType !== "tag" || tag.peeledType !== "commit") {
    return { reason: refusal("since_release_not_annotated", `${since} is not an annotated tag of a commit`) };
  }
  const index = line.findIndex((commit) => commit.sha === tag.peeledName);
  if (index < 0) {
    return {
      reason: refusal(
        "since_release_off_first_parent",
        `${since} tags ${tag.peeledName}, which is not on main's first-parent line`,
      ),
    };
  }
  return { since: { tag: since, tagObject: tag.objectName, commit: tag.peeledName }, index };
}

/**
 * The build tag a commit already has, checked from Git alone, or null. It must be the commit's only build
 * reference: an annotated tag whose object names the commit, and whose provenance names this repository,
 * the commit, the version in the tag's own name, the commit's own ancestral release and the CI workflow.
 * When anything else is on the commit, it is evaluated in full and a conflict is refused there.
 *
 * Only a merge that a normal release already contains is checked this way. Every other merge's tag is
 * verified in full by `evaluateCommit`, the cited CI attempt included, so a run's GitHub reads follow the
 * merges since the last normal release rather than the whole window.
 */
function recordedBuildTag({ git, tags, sha, line, repository }) {
  const references = tags.filter((tag) => BUILD_TAG_LIKE.test(tag.name) && peeledCommit(tag) === sha);
  if (references.length !== 1) return null;
  const [tag] = references;
  const name = BUILD_TAG.exec(tag.name);
  if (!name || tag.objectType !== "tag" || tag.peeledType !== "commit") return null;
  const object = git.tagObject(tag.objectName);
  if (object.tag !== tag.name || object.type !== "commit" || object.object !== sha) return null;
  const { base } = releaseBaseFor({ git, sha, line, ignoreNormalTagAt: sha });
  if (!base) return null;

  const expected = expectedProvenance({
    tag: tag.name,
    repository,
    sha,
    target: { version: `${name[1]}.${name[2]}.${name[3]}`, highestChange: null, notesDigest: null, base },
    ciWorkflowPath: FINAL_MERGE_CI.workflowPath,
  });
  if (provenanceDifferences({ message: object.message, expected, fields: GIT_CHECKED_FIELDS }).length > 0) return null;
  const fields = parseBuildProvenance(object.message);
  return {
    pr: recordedPullRequest(object.message, sha),
    tag: { name: tag.name, object: tag.objectName, ciRun: fields["CI-Run"], ciAttempt: fields["CI-Attempt"] },
  };
}

async function reconcileCommit({ git, github, tags, sha, line, released, repository, repositoryId, mainRef, serverUrl, allocated }) {
  const entry = {
    sha,
    pr: null,
    decision: null,
    tag: null,
    recordedTag: null,
    releasedAs: [],
    target: null,
    ci: null,
    reasons: [],
  };

  // A normal release contains this merge, so its build tag, or its being that release, is settled from Git.
  if (released) {
    const recorded = recordedBuildTag({ git, tags, sha, line, repository });
    if (recorded) {
      return { ...entry, pr: recorded.pr, decision: "recorded", recordedTag: { ...recorded.tag, verification: "git" } };
    }
    const releasedAs = tags.filter((tag) => NORMAL_TAG.test(tag.name) && peeledCommit(tag) === sha).map((tag) => tag.name);
    const buildReferenced = tags.some((tag) => BUILD_TAG_LIKE.test(tag.name) && peeledCommit(tag) === sha);
    if (releasedAs.length > 0 && !buildReferenced) return { ...entry, decision: "not_applicable", releasedAs };
  }

  const evaluation = await evaluateCommit({ git, github, repository, repositoryId, sha, runId: null, mainRef, serverUrl });
  const evaluated = {
    ...entry,
    pr:
      evaluation.target?.merges.find((merge) => merge.mergeSha === sha)?.pr ??
      evaluation.reasons.find((reason) => reason.commit === sha && reason.pr)?.pr ??
      null,
    releasedAs: evaluation.releasedAs,
    target: evaluation.target,
    ci: evaluation.ci,
    reasons: evaluation.reasons,
  };

  if (evaluation.decision === "eligible") {
    // Provisional, like evaluate-build's: counting the names this scan has already offered, so two eligible
    // commits of one target are shown the names the writer will allocate them, oldest first.
    const { version } = evaluation.target;
    const ordinal = Math.max(evaluation.tag.ordinal, (allocated.get(version) ?? 0) + 1);
    allocated.set(version, ordinal);
    return { ...evaluated, decision: "eligible", tag: { name: buildTagName(version, ordinal), ordinal, provisional: true } };
  }
  if (evaluation.decision === "already_tagged") {
    return { ...evaluated, decision: "recorded", recordedTag: { ...evaluation.existingTag, verification: "full" } };
  }
  return { ...evaluated, decision: evaluation.decision };
}

/**
 * Reconciles the window ending at `mainRef`. Reads Git and GitHub; writes nothing. `trigger`, when given,
 * is the CI completion that started it; it must be final-merge CI for a commit on main, or nothing is
 * scanned. It never narrows the scan.
 */
export async function reconcileBuilds({ git, github, repository, repositoryId, mainRef, serverUrl, since, trigger }) {
  const report = {
    command: "reconcile-builds",
    schema: RECONCILIATION_SCHEMA,
    decision: null,
    publication: "none",
    repository,
    repositoryId,
    mainRef,
    main: null,
    since: null,
    trigger: trigger ? { sha: trigger.sha, runId: trigger.runId, inWindow: null } : null,
    counts: { recorded: 0, eligible: 0, blocked: 0, notApplicable: 0 },
    commits: [],
    reasons: [],
  };
  const refuse = (reasons) => Object.assign(report, { decision: "refused", reasons });

  const tags = git.tags();
  await assertCheckoutTagsCurrent(github, tags);

  const main = git.commit(mainRef);
  if (!main) return refuse([refusal("unknown_main_ref", `${mainRef} does not name a commit in this clone`)]);
  report.main = main;
  const line = git.firstParentLine(main);
  const start = windowStart({ tags, line, since });
  if (start.reason) return refuse([start.reason]);
  report.since = start.since;

  if (trigger) {
    const position = line.findIndex((commit) => commit.sha === trigger.sha);
    if (position < 0) {
      return git.commit(trigger.sha) === trigger.sha
        ? refuse([refusal("not_on_main_first_parent", `${trigger.sha} is not on the first-parent line of ${mainRef}`, trigger.sha)])
        : refuse([refusal("unknown_commit", `${trigger.sha} is not a commit in this clone; fetch before reconciling`, trigger.sha)]);
    }
    report.trigger.inWindow = position < start.index;
    const refused = await verifyTriggerRun({ github, repository, repositoryId, sha: trigger.sha, runId: trigger.runId });
    if (refused.length > 0) return refuse(refused);
  }

  // A commit at or before the newest annotated normal release on this line is contained in a release.
  const newestRelease = Math.min(
    ...tags
      .filter((tag) => NORMAL_TAG.test(tag.name) && tag.objectType === "tag" && tag.peeledType === "commit")
      .map((tag) => line.findIndex((commit) => commit.sha === tag.peeledName))
      .filter((index) => index >= 0),
  );

  // Oldest first. A commit on main's first-parent line has that line's tail as its own.
  const allocated = new Map();
  for (let index = start.index - 1; index >= 0; index -= 1) {
    report.commits.push(
      await reconcileCommit({
        git,
        github,
        tags,
        sha: line[index].sha,
        line: line.slice(index),
        released: index >= newestRelease,
        repository,
        repositoryId,
        mainRef,
        serverUrl,
        allocated,
      }),
    );
  }
  for (const { decision } of report.commits) {
    if (decision === "recorded") report.counts.recorded += 1;
    else if (decision === "eligible") report.counts.eligible += 1;
    else if (decision === "not_applicable") report.counts.notApplicable += 1;
    else report.counts.blocked += 1;
  }
  report.decision = report.counts.eligible > 0 ? "eligible" : "nothing_to_publish";
  return report;
}

/** Why a value read from a plan file cannot be a reconciliation of this repository. Empty when it can. */
export function reconciliationPlanProblems(plan, { repository, repositoryId, mainRef }) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["the plan is not a JSON object"];
  const problems = [];
  if (plan.command !== "reconcile-builds") problems.push("it was not written by reconcile-builds");
  if (plan.schema !== RECONCILIATION_SCHEMA) problems.push(`its schema is ${JSON.stringify(plan.schema ?? null)}`);
  if (plan.repository !== repository) problems.push(`it is for ${JSON.stringify(plan.repository ?? null)}, not ${repository}`);
  if ((plan.repositoryId ?? null) !== repositoryId) {
    problems.push(`its repository id is ${JSON.stringify(plan.repositoryId ?? null)}, not ${JSON.stringify(repositoryId)}`);
  }
  if (plan.mainRef !== mainRef) problems.push(`it reconciled ${JSON.stringify(plan.mainRef ?? null)}, not ${mainRef}`);
  if (!RECONCILIATION_DECISIONS.has(plan.decision)) {
    problems.push(`its decision ${JSON.stringify(plan.decision ?? null)} is not one reconcile-builds reports`);
  }
  if (plan.since === null) {
    if (plan.decision !== "refused") problems.push("it has no window");
  } else if (plan.since?.tag !== BUILD_TAGS_OWED_AFTER) {
    problems.push(`its window starts after ${JSON.stringify(plan.since?.tag ?? null)}, not ${BUILD_TAGS_OWED_AFTER}`);
  }
  if (plan.main !== null && !FULL_SHA.test(String(plan.main ?? ""))) problems.push("its main is not a full commit sha");
  if (
    plan.trigger !== null &&
    !(FULL_SHA.test(String(plan.trigger?.sha ?? "")) && Number.isSafeInteger(plan.trigger?.runId) && plan.trigger.runId > 0)
  ) {
    problems.push("its trigger is not a commit sha and a run id");
  }
  if (!Array.isArray(plan.commits)) {
    problems.push("it lists no commits");
  } else if (
    plan.commits.some(
      (commit) =>
        !commit ||
        !FULL_SHA.test(String(commit.sha ?? "")) ||
        typeof commit.decision !== "string" ||
        (commit.decision === "eligible" && (!commit.target || typeof commit.target !== "object")),
    )
  ) {
    problems.push("a commit it lists is not a commit sha with a decision and, when eligible, a target");
  }
  return problems;
}

/**
 * Publishes a build tag for every commit that is eligible now, if publication is activated. The plan only
 * starts the work and says what an earlier job expected: what is owed is reconciled again here, under the
 * lock. A commit the plan found eligible is refused if its target has drifted since; a commit the plan did
 * not find eligible, but that is eligible now, is published too.
 *
 * Commits are published oldest first. A write that fails stops the run: what was confirmed is reported,
 * the rest are `not_attempted`, and the next reconciliation resumes from the tags GitHub holds. So does a
 * name GitHub has given to something else.
 */
export async function publishReconciledBuilds({ git, github, makeTagWriter, repository, repositoryId, plan, mainRef, serverUrl, activation }) {
  const report = {
    command: "publish-reconciled-builds",
    schema: RECONCILIATION_SCHEMA,
    decision: null,
    publication: "none",
    repository,
    repositoryId,
    mainRef,
    main: null,
    since: null,
    counts: null,
    commits: [],
    reasons: [],
  };
  const finish = (decision, reasons = []) => Object.assign(report, { decision, reasons });

  const problems = reconciliationPlanProblems(plan, { repository, repositoryId, mainRef });
  if (problems.length > 0) {
    return finish("refused", [refusal("plan_invalid", `the plan cannot be used: ${problems.join("; ")}`)]);
  }
  if (plan.decision === "refused") {
    return finish("refused", [
      refusal("plan_not_reconciled", "the plan's reconciliation was refused, so nothing is published from it"),
    ]);
  }

  const owed = await reconcileBuilds({
    git,
    github,
    repository,
    repositoryId,
    mainRef,
    serverUrl,
    since: BUILD_TAGS_OWED_AFTER,
    trigger: null,
  });
  Object.assign(report, { main: owed.main, since: owed.since, counts: owed.counts });
  if (owed.decision === "refused") return finish("refused", owed.reasons);

  const eligible = owed.commits.filter((commit) => commit.decision === "eligible");
  const planned = (sha) => plan.commits.find((commit) => commit.sha === sha && commit.decision === "eligible") ?? null;
  const outcome = (commit, fields) => ({
    sha: commit.sha,
    pr: commit.pr,
    planned: planned(commit.sha) !== null,
    decision: null,
    tag: null,
    existingTag: null,
    target: commit.target,
    reasons: [],
    ...fields,
  });
  const notAttempted = (from) =>
    report.commits.push(...eligible.slice(from).map((commit) => outcome(commit, { decision: "not_attempted" })));
  const interruption = (error, commit) => ({
    kind: "interrupted",
    code: error.code,
    detail: error.message,
    commit: commit.sha,
    pr: commit.pr,
  });

  if (eligible.length === 0) return finish("nothing_to_publish");
  if (activation !== ACTIVATED) {
    report.commits = eligible.map((commit) => outcome(commit, { decision: "eligible", tag: commit.tag }));
    return finish("publication_disabled");
  }

  const confirmed = new Map();
  const writerGit = withConfirmedTags(git, confirmed);
  let tagWriter = null;
  const writer = () => (tagWriter ??= makeTagWriter());

  for (const [index, commit] of eligible.entries()) {
    let result;
    try {
      result = await publishCommit({
        git: writerGit,
        github,
        makeTagWriter: writer,
        repository,
        repositoryId,
        sha: commit.sha,
        runId: null,
        planned: planned(commit.sha) ?? commit,
        mainRef,
        serverUrl,
        activation,
      });
    } catch (error) {
      if (!(error instanceof ControllerError)) throw error;
      report.commits.push(outcome(commit, { decision: "interrupted", reasons: [interruption(error, commit)] }));
      notAttempted(index + 1);
      return finish("interrupted");
    }

    if (result.publication === "created") report.publication = "created";
    report.commits.push(
      outcome(commit, {
        decision: result.decision,
        tag: result.decision === "tagged" ? result.tag : null,
        existingTag:
          result.decision === "already_tagged" ? { name: result.existingTag.name, object: result.existingTag.object } : null,
        target: result.target ?? commit.target,
        reasons: result.reasons,
      }),
    );

    // Another object now holds a name the next allocation would read; stop and let the next run read it.
    if (result.reasons.some((reason) => reason.code === "build_tag_name_collision")) {
      notAttempted(index + 1);
      return finish("refused");
    }

    const name =
      result.decision === "tagged" ? result.tag.name : result.decision === "already_tagged" ? result.existingTag.name : null;
    if (name && !writerGit.tags().some((tag) => tag.name === name)) {
      try {
        confirmed.set(name, await readConfirmedTag(github, name, commit.sha));
      } catch (error) {
        if (!(error instanceof ControllerError)) throw error;
        notAttempted(index + 1);
        return finish("interrupted", [interruption(error, commit)]);
      }
    }
  }
  return finish(report.commits.some((commit) => commit.decision === "refused") ? "refused" : "published");
}

/**
 * Writes the `release/build-tag` status of each commit a reconciliation's run is answerable for: the commit
 * whose CI completion started it, every commit the plan did not find recorded, and any commit merged since
 * the plan was made. Each is evaluated again when this runs — under the writer lock in the workflow — and a
 * status is written only when it differs from the one GitHub shows, so an unresolved merge stays visible
 * without a new status on every run. A trigger outside the window gets none.
 */
export async function writeReconciledStatuses({
  git,
  github,
  makeStatusWriter,
  repository,
  repositoryId,
  plan,
  mainRef,
  serverUrl,
  activation,
  writer,
  targetUrl,
}) {
  const report = { command: "write-reconciled-statuses", decision: null, repository, repositoryId, commits: [], reasons: [] };
  const finish = (decision, reasons = []) => Object.assign(report, { decision, reasons });

  const problems = reconciliationPlanProblems(plan, { repository, repositoryId, mainRef });
  if (problems.length > 0) {
    return finish("refused", [refusal("plan_invalid", `the plan cannot be used: ${problems.join("; ")}`)]);
  }
  if (activation !== ACTIVATED) return finish("publication_disabled");

  await assertCheckoutTagsCurrent(github, git.tags());
  const main = git.commit(mainRef);
  const line = main ? git.firstParentLine(main) : [];
  const position = new Map(line.map((commit, index) => [commit.sha, index]));

  const subjects = new Map();
  if (plan.trigger) subjects.set(plan.trigger.sha, true);
  for (const commit of plan.commits) {
    if (commit.decision !== "recorded" && commit.decision !== "not_applicable" && !subjects.has(commit.sha)) {
      subjects.set(commit.sha, false);
    }
  }
  if (plan.decision !== "refused" && position.has(plan.main)) {
    for (const commit of line.slice(0, position.get(plan.main))) if (!subjects.has(commit.sha)) subjects.set(commit.sha, false);
  }
  const oldestFirst = [...subjects].sort(
    ([a], [b]) => (position.get(b) ?? Number.MAX_SAFE_INTEGER) - (position.get(a) ?? Number.MAX_SAFE_INTEGER),
  );

  let statusWriter = null;
  for (const [sha, trigger] of oldestFirst) {
    const entry = { sha, trigger, result: null, evaluation: null, status: null };
    report.commits.push(entry);
    if (trigger && plan.trigger.inWindow !== true) {
      entry.result = "outside_window";
      continue;
    }

    const fresh = await evaluateCommit({
      git,
      github,
      repository,
      repositoryId,
      sha,
      runId: trigger ? plan.trigger.runId : null,
      mainRef,
      serverUrl,
    });
    entry.evaluation = {
      decision: fresh.decision,
      tag: fresh.existingTag?.name ?? null,
      reasons: fresh.reasons.map((reason) => reason.code),
    };
    const planEntry = plan.commits.find((commit) => commit.sha === sha);
    const status = statusToWrite({ plan: { decision: planEntry?.decision ?? null }, fresh, writer });
    if (!status) {
      entry.result = "no_status";
      continue;
    }
    entry.status = status;

    const shown = await github.buildTagStatus(sha);
    if (shown?.state === status.state && shown?.description === status.description) {
      entry.result = "unchanged";
      continue;
    }
    statusWriter ??= makeStatusWriter();
    await statusWriter.createStatus({ sha, state: status.state, description: status.description, targetUrl });
    entry.result = "written";
  }
  return finish("reported");
}
