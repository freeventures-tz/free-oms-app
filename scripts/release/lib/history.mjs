/**
 * Which accepted merges a release contains, read from immutable history.
 *
 * An accepted merge, for this rollout, is a two-parent commit on main's first-parent line whose
 * subject is GitHub's `Merge pull request #N from ...`, whose pull request GitHub reports as merged
 * into main at exactly this commit from exactly its second parent, and whose body retains the
 * checked title. The retained body governs classification. The pull request's CURRENT title, body
 * and labels are never read into the result, so editing a PR after its merge cannot change a release.
 *
 * Anything else on the first-parent line — a squash, a rebase, a direct push, a local merge, an
 * octopus, or a merge GitHub does not associate with its pull request — is a pending decision for the
 * Owner. It is named and never guessed at.
 */

import { classifyChange } from "./classification.mjs";
import { compareVersions, NORMAL_TAG } from "./version.mjs";

const GITHUB_MERGE_SUBJECT = /^Merge pull request #([1-9]\d*) from \S+$/;

function refusal(code, detail, { commit = null, pr = null } = {}) {
  return { kind: "refusal", code, detail, commit, pr };
}

function pending(code, detail, { commit = null, pr = null } = {}) {
  return { kind: "pending_decision", code, detail, commit, pr };
}

/**
 * The last normal release on a commit's own first-parent line.
 *
 * Only annotated `vX.Y.Z` tags count. A candidate that cannot be trusted to mean what its name says —
 * lightweight, off the first-parent line, sharing a commit with another, or older in history than a
 * lower version — is refused rather than skipped, because skipping it would silently choose a
 * different base.
 */
function selectReleaseBase(git, line, sha, ignoreNormalTagAt) {
  const position = new Map(line.map((commit, index) => [commit.sha, index]));
  const reasons = [];
  const candidates = [];

  for (const tag of git.tags()) {
    if (!NORMAL_TAG.test(tag.name)) continue;

    const target = tag.objectType === "tag" ? tag.peeledName : tag.objectName;
    if (ignoreNormalTagAt !== null && target === ignoreNormalTagAt) continue;
    const onLine = position.has(target);
    const inHistory = onLine || (git.commit(target) !== null && git.isAncestor(target, sha));
    if (!inHistory) continue;

    if (tag.objectType !== "tag") {
      reasons.push(
        refusal("lightweight_normal_tag", `${tag.name} is a lightweight tag; a normal release tag must be annotated`),
      );
      continue;
    }
    if (tag.peeledType !== "commit") {
      reasons.push(refusal("normal_tag_not_a_commit", `${tag.name} does not tag a commit`));
      continue;
    }
    if (!onLine) {
      reasons.push(
        refusal(
          "normal_tag_off_first_parent",
          `${tag.name} tags ${target}, which is in this history but not on main's first-parent line`,
        ),
      );
      continue;
    }
    candidates.push({
      tag: tag.name,
      tagObject: tag.objectName,
      commit: target,
      version: tag.name.slice(1),
      index: position.get(target),
    });
  }

  if (reasons.length > 0) return { reasons };
  if (candidates.length === 0) {
    return {
      reasons: [
        refusal("no_normal_release_base", "no annotated vX.Y.Z tag is on this commit's first-parent history"),
      ],
    };
  }

  const nearest = Math.min(...candidates.map((c) => c.index));
  const atNearest = candidates.filter((c) => c.index === nearest);
  if (atNearest.length > 1) {
    return {
      reasons: [
        refusal(
          "duplicate_normal_tags",
          `${atNearest.map((c) => c.tag).join(" and ")} tag the same commit ${atNearest[0].commit}`,
        ),
      ],
    };
  }
  const highest = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (highest.index !== nearest) {
    return {
      reasons: [
        refusal(
          "normal_tag_order_conflict",
          `${highest.tag} is the highest version but ${atNearest[0].tag} is later in history`,
        ),
      ],
    };
  }

  const { tag, tagObject, commit, version } = atNearest[0];
  return { base: { tag, tagObject, commit, version }, baseIndex: nearest, reasons: [] };
}

/** Splits a merge message into its subject and the title and description its body retains. */
function retainedMessage(message) {
  const lines = message.split("\n");
  const subject = lines[0] ?? "";
  if (lines[1] !== "" || !lines[2]) {
    return { subject, title: null, description: "" };
  }
  return { subject, title: lines[2], description: lines.slice(3).join("\n") };
}

/**
 * Reads the release range ending at `sha`.
 *
 * `ignoreNormalTagAt` names a commit whose own normal release tags are not a base. A build tag uses
 * it for its own commit: the build identifies the merge as it was accepted, so a normal release
 * later published at that same commit does not turn its range into nothing.
 *
 * @returns {Promise<{ base: object|null, merges: object[], reasons: object[] }>}
 */
export async function readAcceptedRange({ git, github, repository, sha, mainRef, serverUrl, ignoreNormalTagAt = null }) {
  const pullUrl = (number) => `${serverUrl}/${repository}/pull/${number}`;
  const commitUrl = (commit) => `${serverUrl}/${repository}/commit/${commit}`;

  if (git.commit(sha) !== sha) {
    return {
      base: null,
      merges: [],
      reasons: [refusal("unknown_commit", `${sha} is not a commit in this clone; fetch before previewing`)],
    };
  }
  const main = git.commit(mainRef);
  if (!main) {
    return {
      base: null,
      merges: [],
      reasons: [refusal("unknown_main_ref", `${mainRef} does not name a commit in this clone`)],
    };
  }
  if (!git.firstParentLine(main).some((commit) => commit.sha === sha)) {
    return {
      base: null,
      merges: [],
      reasons: [
        refusal(
          "not_on_main_first_parent",
          `${sha} is not on the first-parent line of ${mainRef}; only an accepted merge on main can be previewed`,
          { commit: sha },
        ),
      ],
    };
  }

  const line = git.firstParentLine(sha);
  const selected = selectReleaseBase(git, line, sha, ignoreNormalTagAt);
  if (selected.reasons.length > 0) {
    return { base: null, merges: [], reasons: selected.reasons };
  }

  const reasons = [];
  const merges = [];

  // Oldest first, stopping short of the release commit itself.
  for (const commit of line.slice(0, selected.baseIndex).reverse()) {
    const at = { commit: commit.sha };

    if (commit.parents.length === 1) {
      const associated = (await github.pullRequestsForCommit(commit.sha)).filter((pull) => pull.merged_at);
      reasons.push(
        associated.length > 0
          ? pending(
              "squash_or_rebase_merge",
              `a single-parent commit on main that GitHub associates with merged pull request ${associated
                .map((pull) => `#${pull.number}`)
                .join(", ")}; this rollout accepts only two-parent merges`,
              { ...at, pr: associated[0].number },
            )
          : pending("direct_push", "a single-parent commit on main with no merged pull request", at),
      );
      continue;
    }
    if (commit.parents.length > 2) {
      reasons.push(pending("octopus_merge", `a merge with ${commit.parents.length} parents`, at));
      continue;
    }

    const [mainParent, mergedParent] = commit.parents;
    const { subject, title, description } = retainedMessage(git.message(commit.sha));
    const subjectMatch = GITHUB_MERGE_SUBJECT.exec(subject);
    if (!subjectMatch) {
      reasons.push(
        pending(
          "unsupported_merge_subject",
          `the merge subject is not GitHub's pull-request merge subject: ${JSON.stringify(subject)}`,
          at,
        ),
      );
      continue;
    }

    const number = Number(subjectMatch[1]);
    const context = { ...at, pr: number };
    const pull = await github.pullRequest(number);
    if (!pull) {
      reasons.push(
        pending("missing_pr_association", `pull request #${number} does not exist in ${repository}`, context),
      );
      continue;
    }
    const mismatches = [];
    if (pull.merged !== true) mismatches.push("it is not merged");
    if (pull.merge_commit_sha !== commit.sha) {
      mismatches.push(`GitHub records its merge commit as ${pull.merge_commit_sha ?? "none"}`);
    }
    if (pull.head?.sha !== mergedParent) {
      mismatches.push(`its head ${pull.head?.sha ?? "unknown"} is not the merged parent ${mergedParent}`);
    }
    if (pull.base?.ref !== "main") mismatches.push(`its base is ${pull.base?.ref ?? "unknown"}, not main`);
    if (pull.base?.repo?.full_name !== repository) {
      mismatches.push(`its base repository is ${pull.base?.repo?.full_name ?? "unknown"}`);
    }
    if (mismatches.length > 0) {
      reasons.push(
        pending("pr_association_mismatch", `pull request #${number}: ${mismatches.join("; ")}`, context),
      );
      continue;
    }

    if (!title) {
      reasons.push(
        refusal("missing_retained_title", "the merge body does not retain the pull request title", context),
      );
      continue;
    }

    const result = classifyChange({ title, description });
    if (!result.ok) {
      reasons.push(...result.reasons.map((r) => refusal(r.code, r.detail, context)));
      continue;
    }

    const c = result.classification;
    let revertsOk = true;
    for (const reverted of c.reverts) {
      if (git.commit(reverted) !== reverted || !git.isAncestor(reverted, mainParent)) {
        revertsOk = false;
        reasons.push(
          refusal(
            "ambiguous_revert",
            `Reverts: ${reverted} is not a commit already on main before this merge`,
            context,
          ),
        );
      }
    }
    if (!revertsOk) continue;

    merges.push({
      pr: number,
      url: pullUrl(number),
      mergeSha: commit.sha,
      mergeUrl: commitUrl(commit.sha),
      headSha: mergedParent,
      title,
      type: c.type,
      scope: c.scope,
      change: c.change,
      breaking: c.breaking,
      breakingExplanation: c.breakingExplanation,
      deprecation: c.deprecation,
      reverts: c.reverts.map((reverted) => ({ sha: reverted, url: commitUrl(reverted) })),
      developmentCommits: git
        .commitsBetween(mainParent, mergedParent)
        .map((dev) => ({ sha: dev.sha, subject: dev.subject, url: commitUrl(dev.sha) })),
    });
  }

  return { base: selected.base, merges, reasons };
}
