/**
 * Build tags: their names, the annotation that binds one to its evidence, and what the tags that
 * already exist say about a commit and a target version.
 *
 * A build tag is `vX.Y.Z-dev.N`. X.Y.Z is the normal version the commit's own accepted range calculates
 * from the commit's own ancestral normal release. N records allocation order for that target — one more
 * than every build tag for the target that exists when the writer allocates — so a late retry can hold
 * a higher N than a later merge. Merge order is Git's to record. A build tag never changes a package
 * version, and nothing here writes a file.
 *
 * The annotation carries a provenance block of `Field: value` lines. The stable fields — schema,
 * repository, commit, target, classification, base and notes digest, plus the CI workflow — decide
 * whether an existing tag is this commit's build tag. The CI run and attempt are the evidence that
 * satisfied the gate; the caller checks separately that they belong to the commit.
 */

import { createHash } from "node:crypto";

import { BUILD_TAG } from "./version.mjs";

export const PROVENANCE_SCHEMA = "1";

const PROVENANCE_FIELDS = Object.freeze([
  "Release-Controller-Schema",
  "Repository",
  "Commit",
  "Target-Version",
  "Classification",
  "Release-Base",
  "Notes-Digest",
  "CI-Workflow",
  "CI-Run",
  "CI-Attempt",
]);

const STABLE_FIELDS = Object.freeze(PROVENANCE_FIELDS.slice(0, 8));

const BUILD_TAG_LIKE = /^v\d+\.\d+\.\d+-dev/;

export function buildTagName(version, ordinal) {
  return `v${version}-dev.${ordinal}`;
}

/**
 * A digest of everything the release notes for this commit are built from: the accepted merges with
 * their retained titles, classifications, footers and development commits, the base and the target.
 * URLs are left out, because they depend on where the controller runs, not on history.
 */
export function notesDigest({ repository, sha, version, base, highestChange, merges }) {
  const canonical = {
    schema: 1,
    repository,
    sha,
    version,
    base: { tag: base.tag, tagObject: base.tagObject, commit: base.commit, version: base.version },
    highestChange,
    merges: merges.map((merge) => ({
      pr: merge.pr,
      mergeSha: merge.mergeSha,
      headSha: merge.headSha,
      title: merge.title,
      type: merge.type,
      scope: merge.scope,
      change: merge.change,
      breaking: merge.breaking,
      breakingExplanation: merge.breakingExplanation,
      deprecation: merge.deprecation,
      reverts: merge.reverts.map((reverted) => reverted.sha),
      developmentCommits: merge.developmentCommits.map((dev) => ({ sha: dev.sha, subject: dev.subject })),
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** The first line and stable provenance fields a build tag for this commit and target must carry. */
export function expectedProvenance({ tag, repository, sha, target, ciWorkflowPath }) {
  return {
    firstLine: `Build ${tag} of ${repository}`,
    fields: {
      "Release-Controller-Schema": PROVENANCE_SCHEMA,
      Repository: repository,
      Commit: sha,
      "Target-Version": target.version,
      Classification: target.highestChange,
      "Release-Base": `${target.base.tag} ${target.base.tagObject} ${target.base.commit}`,
      "Notes-Digest": target.notesDigest,
      "CI-Workflow": ciWorkflowPath,
    },
  };
}

const oneLine = (text) => String(text).replace(/\s+/g, " ");

/** One line per run attempt, and per accepted flaky retry of a run that satisfied the gate. */
export function ciEvidence(ci) {
  const lines = [];
  for (const run of ci.runs) {
    if (run.attempts.length === 0) {
      lines.push(`run ${run.runId} attempt ${run.attempt}: ${oneLine(run.status ?? "unknown")}`);
    }
    for (const attempt of run.attempts) {
      const unsuccessful = attempt.unsuccessfulJobs.map((job) => `${oneLine(job.name)} ${job.conclusion}`).join(", ");
      lines.push(
        `run ${run.runId} attempt ${attempt.attempt}: ${attempt.conclusion ?? attempt.status ?? "unknown"}${unsuccessful ? ` (${unsuccessful})` : ""}`,
      );
    }
    if (!run.satisfied) continue;
    for (const flake of run.acceptedFlakes) {
      const failures = flake.unsuccessful.map((u) => `${u.conclusion} in attempt ${u.attempt}`).join(", ");
      lines.push(
        `accepted flaky retry in run ${run.runId}: ${oneLine(flake.job)} ${failures}, success in attempt ${flake.passedAttempt}`,
      );
    }
  }
  return lines;
}

/** The annotation of a new build tag. Pull-request titles are deliberately not in it. */
export function renderBuildAnnotation({ tag, repository, sha, target, ci }) {
  const expected = expectedProvenance({ tag, repository, sha, target, ciWorkflowPath: ci.workflow.path });
  const lines = [
    expected.firstLine,
    "",
    "An exact merge on main that passed its own final-merge CI. A build identifier, not a release.",
    "",
    ...STABLE_FIELDS.map((field) => `${field}: ${expected.fields[field]}`),
    `CI-Run: ${ci.satisfiedBy.runId}`,
    `CI-Attempt: ${ci.satisfiedBy.attempt}`,
    "",
    "Final-merge CI evidence:",
    ...ciEvidence(ci).map((line) => `- ${line}`),
    "",
    `Accepted merges (${target.merges.length}):`,
    ...target.merges.map((merge) => `- #${merge.pr} ${merge.mergeSha}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The provenance fields of an annotation, or null unless each appears exactly once. */
export function parseBuildProvenance(message) {
  const fields = {};
  for (const line of String(message).split("\n")) {
    const match = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (!match || !PROVENANCE_FIELDS.includes(match[1])) continue;
    if (Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2];
  }
  return PROVENANCE_FIELDS.every((field) => Object.hasOwn(fields, field)) ? fields : null;
}

/** How an annotation differs from the expected provenance. An empty list is a match. */
export function provenanceDifferences({ message, expected }) {
  const differences = [];
  const firstLine = String(message).split("\n")[0];
  if (firstLine !== expected.firstLine) {
    differences.push(`its annotation begins ${JSON.stringify(firstLine)}, not ${JSON.stringify(expected.firstLine)}`);
  }
  const fields = parseBuildProvenance(message);
  if (!fields) return [...differences, "its annotation carries no complete build provenance"];
  for (const field of STABLE_FIELDS) {
    if (fields[field] !== expected.fields[field]) {
      differences.push(`${field} is ${JSON.stringify(fields[field])}, not ${JSON.stringify(expected.fields[field])}`);
    }
  }
  if (!/^[1-9]\d*$/.test(fields["CI-Run"]) || !/^[1-9]\d*$/.test(fields["CI-Attempt"])) {
    differences.push("its CI run or attempt is not a positive integer");
  }
  return differences;
}

/**
 * What the existing tags say about one commit and, when it is known, one target version.
 *
 * Returns the annotated build tags on the commit, the highest ordinal already used for the target,
 * and a refusal for any tag that looks like a build tag for either but cannot be trusted to mean what
 * its name says: a malformed name or ordinal, a tag that is not an annotated tag of a commit, or — for
 * another commit's tag of the same target — an annotation whose provenance does not name that tag,
 * this repository, that commit and that target. An ordinal sequence with an untrusted member is
 * refused rather than allocated past. The caller verifies the commit's own tags in full.
 *
 * `untrustedOnCommit` names the malformed and lightweight build references on the commit itself, so the
 * caller can count them as duplicates before it confirms a valid tag.
 */
export function inspectBuildTags({ tags, sha, version, repository, readMessage }) {
  const refusal = (code, detail) => ({ kind: "refusal", code, detail, commit: sha, pr: null });
  const forCommit = [];
  const untrustedOnCommit = [];
  const problems = [];
  let highestOrdinal = 0;
  const reject = (tag, onCommit, reason) => {
    problems.push(reason);
    if (onCommit) untrustedOnCommit.push({ name: tag.name, reason });
  };

  for (const tag of tags) {
    if (!BUILD_TAG_LIKE.test(tag.name)) continue;
    const strict = BUILD_TAG.exec(tag.name);
    const peeled = tag.objectType === "tag" ? tag.peeledName : tag.objectName;
    const onCommit = peeled === sha;
    const forVersion =
      version !== null &&
      (strict ? `${strict[1]}.${strict[2]}.${strict[3]}` === version : tag.name.startsWith(`v${version}-dev`));
    if (!onCommit && !forVersion) continue;

    if (!strict || !Number.isSafeInteger(Number(strict[4]))) {
      reject(
        tag,
        onCommit,
        refusal("malformed_build_tag", `${tag.name} looks like a build tag but is not vX.Y.Z-dev.N with a positive ordinal`),
      );
      continue;
    }
    if (tag.objectType !== "tag" || tag.peeledType !== "commit") {
      reject(tag, onCommit, refusal("lightweight_build_tag", `${tag.name} is not an annotated tag of a commit`));
      continue;
    }
    if (forVersion && !onCommit) {
      const message = readMessage(tag.objectName);
      const fields = parseBuildProvenance(message);
      const consistent =
        fields !== null &&
        message.split("\n")[0] === `Build ${tag.name} of ${repository}` &&
        fields.Repository === repository &&
        fields.Commit === peeled &&
        fields["Target-Version"] === version;
      if (!consistent) {
        problems.push(
          refusal(
            "untrusted_build_tag",
            `${tag.name} does not carry build provenance for its own name and commit, so the ${version} ordinals cannot be trusted`,
          ),
        );
        continue;
      }
    }
    if (forVersion) highestOrdinal = Math.max(highestOrdinal, Number(strict[4]));
    if (onCommit) forCommit.push({ name: tag.name, object: tag.objectName });
  }

  return { forCommit, untrustedOnCommit, highestOrdinal, problems };
}
