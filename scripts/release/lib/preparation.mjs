/**
 * Release preparation: the metadata a normal release carries, prepared on a branch for review.
 *
 * A preparation reads the last normal release from its annotated tag and the accepted merges after it
 * up to the candidate, which is main as it stands. From them it calculates one version, exactly as
 * `preview` does, and writes that version into package.json, the lockfile's top level and root package,
 * and a generated changelog section. It never commits, pushes, tags or writes to GitHub: the Implementer
 * commits the three files on the preparation branch and opens its pull request for review.
 *
 * The version is never taken from package metadata. A package version ahead of the last normal tag is
 * a preparation that merged and was not released; it is labelled, checked, and replaced when the accepted
 * merges now calculate more. A build tag's prerelease ordinal never reaches package metadata.
 *
 * The preparation's own merge is not written into the changelog, because its sha does not exist until
 * it merges. The changelog names its pull request instead. Once merged, that pull request is an accepted
 * merge like any other: the final notes read its sha from history, and a run of this command at the merge
 * checks that the changelog, the package fields and the notes agree, with no second commit to record it.
 *
 * This module decides and reads. It returns the texts to write; the command writes them all or none.
 */

import { assertCheckoutTagsCurrent } from "./build.mjs";
import { notesDigest } from "./build-tags.mjs";
import {
  blockLines,
  newestReleaseProblem,
  placeSection,
  preparationTitle,
  renderBlock,
  sectionHeading,
  sectionText,
} from "./changelog.mjs";
import { highestChange } from "./classification.mjs";
import { ControllerError } from "./errors.mjs";
import { readAcceptedRange } from "./history.mjs";
import {
  CHANGELOG_FILE,
  describeMetadata,
  isPendingVersion,
  LOCKFILE,
  METADATA_FILES,
  PACKAGE_FILE,
  readCommitMetadata,
  readMetadata,
  setLockfileVersion,
  setPackageVersion,
} from "./metadata.mjs";
import { renderReleaseNotes } from "./notes.mjs";
import { nextVersion, NORMAL_VERSION, policyFor } from "./version.mjs";

/** The branch a preparation starts from and is merged into. */
export const MAIN_BRANCH = "main";

const refusal = (code, detail, { commit = null, pr = null } = {}) => ({ kind: "refusal", code, detail, commit, pr });

/**
 * Prepares, or checks, the release metadata for one candidate.
 *
 * `readWorkingFile(name)` reads a file from the working tree, or returns null when it is missing. The
 * result is the report and, for a preparation that is not a dry run, all three files as
 * `[{ path, before, after }]`, for the command to write the changed ones. Nothing here writes.
 */
export async function prepareRelease({ git, github, readWorkingFile, repository, sha, mainRef, serverUrl, pr, date, dryRun, stableContract = false }) {
  const report = {
    command: "prepare-release",
    status: null,
    mode: dryRun ? "dry_run" : "write",
    publication: "none",
    repository,
    sha,
    mainRef,
    main: null,
    branch: null,
    lastNormalRelease: null,
    candidateMetadata: null,
    version: null,
    policy: null,
    highestChange: null,
    notesDigest: null,
    preparation: null,
    merges: [],
    files: [],
    changelogSection: null,
    notes: null,
    final: null,
    reasons: [],
  };
  let files = [];
  const finish = (status, reasons = []) => {
    report.status = status;
    report.reasons = reasons;
    if (status !== "prepared") files = [];
    return { report, files };
  };
  const refuse = (reasons) => finish(reasons.some((r) => r.kind === "refusal") ? "refused" : "pending_decision", reasons);

  // The last normal release is only as current as the checkout's tags.
  await assertCheckoutTagsCurrent(github, git.tags());

  const range = await readAcceptedRange({ git, github, repository, sha, mainRef, serverUrl });
  if (range.reasons.length > 0) return refuse(range.reasons);
  const base = range.base;
  report.lastNormalRelease = base;

  const candidate = readCommitMetadata(git, sha);
  report.candidateMetadata = describeMetadata(candidate, base.version);
  if (range.merges.length === 0) return finish("nothing_to_prepare");

  const highest = highestChange(range.merges.map((merge) => merge.change));
  const policy = policyFor(base.version);
  // 1.0.0 is never calculated from a change: it is the Owner deciding the interface is stable. Preparing it
  // writes the version into a branch and settles nothing — the release itself still needs the Owner's own
  // approval record saying the stable contract is authorized.
  const acceptance = stableContract && policy === "0.x" ? true : null;
  const { version } = nextVersion({ baseVersion: base.version, highest, stableContractAcceptance: acceptance });
  Object.assign(report, {
    version,
    policy,
    highestChange: highest,
    notesDigest: notesDigest({ repository, sha, version, base, highestChange: highest, merges: range.merges }),
    merges: range.merges,
  });
  const notesFor = (merges, preparation) =>
    renderReleaseNotes({
      status: "calculated",
      repository,
      sha,
      base,
      policy,
      highestChange: highest,
      version,
      stableContractAcceptance: acceptance,
      candidateMetadata: report.candidateMetadata,
      merges,
      proposed: [],
      preparation,
    });

  const reasons = [];
  if (git.tags().some((tag) => tag.name === `v${version}`)) {
    reasons.push(refusal("target_already_released", `v${version} already exists, and a normal version is released once`));
  }
  reasons.push(...candidateProblems(candidate, { base, version, sha }));
  if (reasons.length > 0) return refuse(reasons);

  // A candidate that is itself the merge its own changelog names as the preparation is checked, not
  // prepared again, unless another pull request is named to prepare it anew.
  const last = range.merges[range.merges.length - 1];
  const newest = candidate.changelog.sections[0];
  const merged =
    candidate.packageVersion !== base.version &&
    last.mergeSha === sha &&
    newest.marker.preparation === last.pr &&
    (pr === null || pr === last.pr);
  if (merged) {
    const problems = preparedProblems({ candidate, range, base, version, policy, highest, date, sha });
    report.preparation = { pr: last.pr, url: last.url, title: last.title, date };
    if (problems.length > 0) return refuse(problems);
    report.changelogSection = sectionText(candidate.changelog, newest);
    report.notes = notesFor(range.merges, null);
    report.final = {
      sha,
      version,
      notesDigest: report.notesDigest,
      merges: range.merges.map(({ pr: number, mergeSha, title }) => ({ pr: number, mergeSha, title })),
      notes: report.notes,
    };
    return finish("already_prepared");
  }

  const title = preparationTitle(version);
  report.preparation = { pr, url: pr === null ? null : `${serverUrl}/${repository}/pull/${pr}`, title, date };

  // A preparation starts from main as it stands on GitHub, or its changelog would miss what merged since.
  const main = git.commit(mainRef);
  report.main = main;
  const remoteMain = await github.branchReference(MAIN_BRANCH);
  if (remoteMain?.object?.sha !== main) {
    throw new ControllerError(
      "main_out_of_date",
      `${mainRef} is ${main}, but GitHub's ${MAIN_BRANCH} is ${remoteMain?.object?.sha ?? "missing"}; fetch and prepare again`,
    );
  }
  if (sha !== main) {
    reasons.push(
      refusal("candidate_not_main_tip", `a preparation starts from main as it stands, ${main}, and ${sha} is behind it`, { commit: sha }),
    );
  }

  if (!git.isWorkTreeRoot()) {
    return refuse([...reasons, refusal("working_tree_required", "--path must be the top level of a Git working tree")]);
  }
  const branch = git.currentBranch();
  report.branch = branch;
  if (!dryRun && branch === null) {
    reasons.push(refusal("preparation_branch_required", "HEAD is detached; a preparation is written on its own branch"));
  }
  if (!dryRun && branch === MAIN_BRANCH) {
    reasons.push(
      refusal("preparation_on_main", "the checkout is on main; a preparation is written on its own branch and reaches main only through its reviewed pull request"),
    );
  }
  const head = git.commit("HEAD");
  if (!git.isAncestor(sha, head)) {
    reasons.push(refusal("branch_not_based_on_candidate", `HEAD ${head} does not contain the candidate ${sha}; bring the branch up to date with main first`));
  } else {
    const others = git.changedPaths(sha, head).filter((path) => !METADATA_FILES.includes(path));
    if (others.length > 0) {
      reasons.push(
        refusal("branch_has_other_changes", `the branch changes ${others.join(", ")} beside the release metadata, and a preparation changes nothing else`),
      );
    }
  }
  if (pr !== null) reasons.push(...(await pullRequestProblems(github, { pr, title, branch, repository, range })));
  if (reasons.length > 0) return refuse(reasons);

  const working = readMetadata(readWorkingFile);
  const workingProblems = working.problems.map((p) => refusal(`working_metadata_${p.code}`, `in the working tree, ${p.detail}`));
  if (workingProblems.length > 0) return refuse(workingProblems);

  // The working version is the candidate's, or a preparation of it this branch has already written.
  const current = working.packageVersion;
  if (current !== candidate.packageVersion && !isPendingVersion(current, base.version, version)) {
    return refuse([
      refusal(
        "working_metadata_inconsistent",
        `in the working tree, ${PACKAGE_FILE} says ${current}, which is neither the candidate's ${candidate.packageVersion} nor a preparation from ${base.tag} no higher than ${version}`,
      ),
    ]);
  }

  const block = renderBlock({ version, base, policy, highestChange: highest, merges: range.merges, preparation: report.preparation });
  const placed = placeSection(working.changelog, {
    base,
    pendingVersion: current === base.version ? null : current,
    heading: sectionHeading(version, date),
    block,
  });
  if (placed.reason) {
    return refuse([refusal("working_metadata_inconsistent", `in the working tree, ${CHANGELOG_FILE} ${placed.reason}`)]);
  }

  const after = {
    [PACKAGE_FILE]: setPackageVersion(working.texts[PACKAGE_FILE], version),
    [LOCKFILE]: setLockfileVersion(working.texts[LOCKFILE], version),
    [CHANGELOG_FILE]: placed.text,
  };
  const changed = (path) => after[path] !== working.texts[path];
  report.files = [
    { path: PACKAGE_FILE, before: { version: current }, after: { version } },
    {
      path: LOCKFILE,
      before: { version: working.lockfileVersion, rootVersion: working.lockfileRootVersion },
      after: { version, rootVersion: version },
    },
    { path: CHANGELOG_FILE, before: { version: working.changelogVersion }, after: { version } },
  ].map((file) => ({ ...file, changed: changed(file.path), written: false }));
  files = METADATA_FILES.map((path) => ({ path, before: working.texts[path], after: after[path] }));

  // What would be written is read back as metadata, and must be one version throughout.
  const prepared = readMetadata((name) => after[name]);
  if (prepared.problems.length > 0 || prepared.packageVersion !== version || prepared.changelogVersion !== version) {
    throw new ControllerError(
      "preparation_unverified",
      `the prepared files do not read back as ${version}: ${prepared.problems.map((p) => p.detail).join("; ") || "their versions differ"}`,
    );
  }
  report.changelogSection = sectionText(prepared.changelog, prepared.changelog.sections[0]);
  report.notes = notesFor(range.merges, report.preparation);
  return finish(dryRun ? "would_prepare" : "prepared");
}

const RELEASE_HEADING = /^## \[([^\]]*)\] — (\d{4}-\d{2}-\d{2})$/;

/**
 * Checks that `sha` is the merge of preparation `pr` and that what it merged agrees with history, exactly as
 * `prepare-release` checks a merged preparation: the package version, both lockfile fields, the changelog
 * heading and generated block, and the retained title. `base` and `merges` are the accepted range ending at
 * `sha`. A normal release uses this before its tag is published; the release date is read from the heading.
 *
 * Returns the refusals, and when there are none the version, the release date and the final notes, which list
 * every accepted merge once, the preparation's own merge included.
 */
export function verifyMergedPreparation({ git, repository, sha, base, merges, pr, stableContract = false }) {
  const result = { reasons: [], version: null, policy: null, highestChange: null, stableContract: false, releaseDate: null, candidateMetadata: null, notes: null, preparation: null };
  const at = { commit: sha, pr };
  const candidate = readCommitMetadata(git, sha);
  result.candidateMetadata = describeMetadata(candidate, base.version);
  if (merges.length === 0) {
    result.reasons.push(refusal("preparation_not_at_target", `nothing merged after ${base.tag}, so ${sha} carries no preparation`, at));
    return result;
  }
  const highest = highestChange(merges.map((merge) => merge.change));
  const policyName = policyFor(base.version);
  const acceptance = stableContract && policyName === "0.x" ? true : null;
  const { version } = nextVersion({ baseVersion: base.version, highest, stableContractAcceptance: acceptance });
  Object.assign(result, { version, policy: policyName, highestChange: highest, stableContract: acceptance === true });

  const last = merges[merges.length - 1];
  result.preparation = { pr: last.pr, reviewedHead: last.headSha, mergeSha: last.mergeSha, title: last.title };
  if (last.mergeSha !== sha) {
    result.reasons.push(refusal("preparation_not_at_target", `${sha} is not the merge of a pull request; its last accepted merge is #${last.pr}`, at));
    return result;
  }
  if (last.pr !== pr) {
    result.reasons.push(refusal("preparation_pr_mismatch", `${sha} is the merge of #${last.pr}, not of preparation #${pr}`, at));
    return result;
  }
  const problems = candidateProblems(candidate, { base, version, sha });
  if (problems.length > 0) {
    result.reasons.push(...problems);
    return result;
  }
  const newest = candidate.changelog.sections[0];
  if (candidate.packageVersion === base.version || newest.marker?.preparation !== pr) {
    result.reasons.push(
      refusal(
        "preparation_not_at_target",
        `${sha} merged #${pr}, but its metadata carries no preparation of it: the package version is ${candidate.packageVersion} and the newest changelog section names preparation ${newest.marker?.preparation ?? "none"}`,
        at,
      ),
    );
    return result;
  }
  const heading = RELEASE_HEADING.exec(newest.heading);
  if (!heading) {
    result.reasons.push(refusal("prepared_changelog_mismatch", `its changelog heading ${JSON.stringify(newest.heading)} is not "## [X.Y.Z] — YYYY-MM-DD"`, at));
    return result;
  }
  result.releaseDate = heading[2];
  const range = { merges };
  result.reasons.push(...preparedProblems({ candidate, range, base, version, policy: result.policy, highest, date: result.releaseDate, sha }));
  if (result.reasons.length > 0) return result;

  result.notes = renderReleaseNotes({
    status: "calculated",
    repository,
    sha,
    base,
    policy: result.policy,
    highestChange: highest,
    version,
    stableContractAcceptance: acceptance,
    candidateMetadata: result.candidateMetadata,
    merges,
    proposed: [],
    preparation: null,
  });
  return result;
}

/** Why the candidate's committed metadata cannot be a starting point for this target. */
function candidateProblems(candidate, { base, version, sha }) {
  const at = { commit: sha };
  if (candidate.problems.length > 0) {
    return candidate.problems.map((p) => refusal(`candidate_metadata_${p.code}`, `at the candidate, ${p.detail}`, at));
  }
  const current = candidate.packageVersion;
  if (!NORMAL_VERSION.test(current)) {
    return [
      refusal(
        "candidate_version_not_normal",
        `the candidate's package version ${current} is not a normal version; build tags and their ordinals never enter package metadata`,
        at,
      ),
    ];
  }
  if (current !== base.version && !isPendingVersion(current, base.version, version)) {
    return [
      refusal(
        "candidate_metadata_inconsistent",
        `the candidate's package version ${current} is neither the last normal release ${base.version} nor an unreleased preparation from ${base.tag} no higher than ${version}`,
        at,
      ),
    ];
  }
  const problem = newestReleaseProblem(candidate.changelog, {
    base,
    pendingVersion: current === base.version ? null : current,
  });
  return problem ? [refusal("candidate_metadata_inconsistent", `at the candidate, ${CHANGELOG_FILE} ${problem}`, at)] : [];
}

/** Why a merged preparation at the candidate does not agree with the history it merged into. */
function preparedProblems({ candidate, range, base, version, policy, highest, date, sha }) {
  const last = range.merges[range.merges.length - 1];
  const before = range.merges.slice(0, -1);
  const newest = candidate.changelog.sections[0];
  const at = { commit: sha, pr: last.pr };
  const title = preparationTitle(version);
  const problems = [];

  if (before.length === 0) {
    problems.push(refusal("preparation_without_changes", `preparation #${last.pr} is the only merge after ${base.tag}, so there is nothing to release`, at));
  }
  if (last.title !== title) {
    problems.push(refusal("preparation_title_mismatch", `preparation #${last.pr} merged as ${JSON.stringify(last.title)}, not ${JSON.stringify(title)}`, at));
  }
  if (candidate.packageVersion !== version) {
    problems.push(
      refusal(
        "prepared_version_stale",
        `preparation #${last.pr} set ${candidate.packageVersion}, but the accepted merges through it calculate ${version} from ${base.tag}`,
        at,
      ),
    );
  }
  const heading = sectionHeading(version, date);
  if (newest.heading !== heading) {
    problems.push(refusal("prepared_changelog_mismatch", `its changelog heading is ${JSON.stringify(newest.heading)}, not ${JSON.stringify(heading)}`, at));
  }
  const expected = renderBlock({
    version,
    base,
    policy,
    highestChange: highest,
    merges: before,
    preparation: { pr: last.pr, url: last.url, title },
  });
  const actual = blockLines(candidate.changelog, newest);
  if (actual.join("\n") !== expected.join("\n")) {
    const listed = new Set([...actual.join("\n").matchAll(/\[#([1-9]\d*)\]\(/g)].map((match) => Number(match[1])));
    const missing = before.filter((merge) => !listed.has(merge.pr)).map((merge) => `#${merge.pr}`);
    problems.push(
      refusal(
        "prepared_changelog_stale",
        `its generated changelog block is not the one the accepted merges before it give${missing.length > 0 ? `: it leaves out ${missing.join(", ")}` : ""}`,
        at,
      ),
    );
  }
  return problems;
}

/** Why the named pull request cannot be this preparation's. */
async function pullRequestProblems(github, { pr, title, branch, repository, range }) {
  const at = { pr };
  const merged = range.merges.find((merge) => merge.pr === pr);
  if (merged) {
    return [
      refusal("preparation_pr_merged", `#${pr} already merged at ${merged.mergeSha}; name the pull request of this preparation`, {
        commit: merged.mergeSha,
        pr,
      }),
    ];
  }
  const pull = await github.pullRequest(pr);
  if (!pull) return [refusal("preparation_pr_missing", `pull request #${pr} does not exist in ${repository}`, at)];

  const mismatches = [];
  if (pull.state !== "open" || pull.merged === true) mismatches.push(`it is ${pull.merged === true ? "merged" : pull.state}, not open`);
  if (pull.base?.ref !== MAIN_BRANCH || pull.base?.repo?.full_name !== repository) {
    mismatches.push(`its base is ${pull.base?.repo?.full_name ?? "unknown"}:${pull.base?.ref ?? "unknown"}, not ${repository}:${MAIN_BRANCH}`);
  }
  if (pull.head?.repo?.full_name !== repository) {
    mismatches.push(`its head is in ${pull.head?.repo?.full_name ?? "no repository GitHub still has"}, not ${repository}`);
  }
  if (branch !== null && pull.head?.ref !== branch) {
    mismatches.push(`its head branch is ${pull.head?.ref ?? "unknown"}, not the checkout's ${branch}`);
  }
  const problems = mismatches.length > 0 ? [refusal("preparation_pr_mismatch", `pull request #${pr}: ${mismatches.join("; ")}`, at)] : [];
  if (pull.title !== title) {
    problems.push(
      refusal(
        "preparation_title_mismatch",
        `pull request #${pr} is titled ${JSON.stringify(pull.title)}; retitle it ${JSON.stringify(title)}, the title its merge keeps and this changelog names`,
        at,
      ),
    );
  }
  return problems;
}
