/**
 * Normal-release evidence: the policy that names who may issue each record, the references a release
 * request gives, and the records those references name.
 *
 * A record is an issue or pull-request comment in this repository. The request names it by id and by the
 * SHA-256 of its body, so a comment edited after the Owner read it no longer matches. The digest proves
 * only which bytes were meant. What makes a record count is read from GitHub: who wrote it, where, when,
 * and a block of `key: value` lines that must equal the authoritative values one by one. Nothing here
 * accepts a claim because it is well formed.
 *
 * The policy is read from Git at the commit being released, so the reviewed history that is released also
 * carries the rules that release it. An issuer the policy leaves `null` refuses its gate: there is no
 * default and no override.
 */

import { createHash } from "node:crypto";

export const POLICY_PATH = "scripts/release/release-evidence-policy.json";
export const POLICY_SCHEMA = 1;
export const RECORD_SCHEMA = "1";

/** The one action an Owner approval can authorise. */
export const AUTHORIZED_ACTIONS = "publish-normal-tag";

/** `comment:<id>@sha256:<hex>`: a comment of this repository and the digest of its body. */
export const RECORD_REFERENCE = /^comment:([1-9]\d{0,15})@(sha256:[0-9a-f]{64})$/;

/** The kinds a policy issuer is named for. The first two must not be the Owner's account. */
export const ISSUED_KINDS = Object.freeze(["independent-review", "production-acceptance", "hosted-migration"]);
const INDEPENDENT_KINDS = new Set(["independent-review", "production-acceptance"]);

/** The keys each kind's block carries besides `schema`, `kind` and `repository`. */
export const RECORD_KEYS = Object.freeze({
  "independent-review": ["pull-request", "reviewed-head", "version", "verdict"],
  "production-acceptance": ["version", "commit", "deployment", "verdict"],
  "hosted-migration": ["schema-boundary", "migration-first", "hosted-preservation"],
  "owner-release-approval": [
    "version",
    "tag",
    "commit",
    "pull-request",
    "reviewed-head",
    "release-date",
    "schema-boundary",
    "deployment",
    "review",
    "production-acceptance",
    "hosted-migration",
    "authorized-actions",
  ],
});

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const BLOCK_OPEN = "```release-evidence";
const BLOCK_CLOSE = "```";

const refusal = (gate, code, detail) => ({ kind: "refusal", gate, code, detail, commit: null, pr: null });

function readAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "id,login" || typeof value.login !== "string" || !LOGIN.test(value.login)) return null;
  if (!Number.isSafeInteger(value.id) || value.id <= 0) return null;
  return { login: value.login, id: value.id };
}

/**
 * The policy in `text`, or the problems that stop it being used. `text` is null when the commit has no
 * policy file.
 */
export function readPolicy(text, repository) {
  if (text === null) {
    return { policy: null, reasons: [refusal("policy", "release_policy_missing", `the release commit has no ${POLICY_PATH}`)] };
  }
  const problems = [];
  let data = null;
  try {
    data = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (error) {
    problems.push(`it is not JSON (${error.message})`);
  }
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) problems.push("it is not a JSON object");
  const policy = { owner: null, issuers: {}, vercel: null };
  if (problems.length === 0) {
    if (data.schema !== POLICY_SCHEMA) problems.push(`its schema is ${JSON.stringify(data.schema ?? null)}, not ${POLICY_SCHEMA}`);
    if (data.repository !== repository) problems.push(`it is for ${JSON.stringify(data.repository ?? null)}, not ${repository}`);
    policy.owner = readAccount(data.owner);
    if (!policy.owner) problems.push("its owner is not a GitHub login and numeric id");

    const issuers = data.issuers;
    if (!issuers || typeof issuers !== "object" || Array.isArray(issuers)) {
      problems.push("it has no issuers");
    } else {
      for (const key of Object.keys(issuers)) {
        if (!ISSUED_KINDS.includes(key)) problems.push(`it names an issuer for an unknown kind ${JSON.stringify(key)}`);
      }
      for (const kind of ISSUED_KINDS) {
        if (!Object.hasOwn(issuers, kind)) problems.push(`it does not say who issues ${kind} records`);
        else if (issuers[kind] === null) policy.issuers[kind] = null;
        else {
          policy.issuers[kind] = readAccount(issuers[kind]);
          if (!policy.issuers[kind]) problems.push(`its ${kind} issuer is not null or a GitHub login and numeric id`);
        }
      }
    }

    const vercel = data.vercel;
    const creator = readAccount(vercel?.creator);
    if (
      !creator ||
      typeof vercel.environment !== "string" ||
      !/^[A-Za-z0-9 _-]{1,64}$/.test(vercel.environment) ||
      typeof vercel.project !== "string" ||
      !SLUG.test(vercel.project) ||
      typeof vercel.team !== "string" ||
      !SLUG.test(vercel.team)
    ) {
      problems.push("its vercel entry is not a creator, an environment, a project and a team");
    } else {
      policy.vercel = { creator, environment: vercel.environment, project: vercel.project, team: vercel.team };
    }
  }
  if (problems.length > 0) {
    return {
      policy: null,
      reasons: [refusal("policy", "release_policy_invalid", `${POLICY_PATH} at the release commit cannot be used: ${problems.join("; ")}`)],
    };
  }
  return { policy, reasons: [] };
}

/** A record reference, as `{ id, digest }`, or null when the text is not one. */
export function readReference(text) {
  const match = RECORD_REFERENCE.exec(String(text ?? ""));
  // An id past JavaScript's safe integers would be read as another comment than the one named.
  return match && Number.isSafeInteger(Number(match[1])) ? { id: Number(match[1]), digest: match[2], text: match[0] } : null;
}

export function bodyDigest(body) {
  return `sha256:${createHash("sha256").update(String(body), "utf8").digest("hex")}`;
}

/** A migration boundary as records and annotations write it. Each tree is an id or `absent`. */
export function formatBoundary({ before, after }) {
  return before === after ? `unchanged ${before ?? "absent"}` : `changed ${before ?? "absent"} ${after ?? "absent"}`;
}

/**
 * The one `release-evidence` block in a body, as `{ fields }`, or `{ problem }`. A body with an HTML comment
 * is refused: GitHub does not show what is inside one, so a block there would count without being seen.
 */
export function readBlock(body) {
  if (String(body).includes("<!--")) return { problem: "it contains an HTML comment, which GitHub does not show" };
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const opens = lines.flatMap((line, index) => (line.trimEnd() === BLOCK_OPEN ? [index] : []));
  if (opens.length !== 1) {
    return { problem: opens.length === 0 ? "it has no release-evidence block" : "it has more than one release-evidence block" };
  }
  const [start] = opens;
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === BLOCK_CLOSE);
  if (end < 0) return { problem: "its release-evidence block never ends" };
  const fields = {};
  for (const raw of lines.slice(start + 1, end)) {
    const match = /^([a-z][a-z-]*): (\S(?:.*\S)?)$/.exec(raw.trimEnd());
    if (!match) return { problem: `its block has a line that is not "key: value": ${JSON.stringify(raw.trimEnd())}` };
    if (Object.hasOwn(fields, match[1])) return { problem: `its block gives ${match[1]} more than once` };
    fields[match[1]] = match[2];
  }
  return { fields };
}

/** The block a record of this kind carries, with `fields` in order. */
export function renderBlock(kind, fields) {
  const lines = [BLOCK_OPEN, `schema: ${RECORD_SCHEMA}`, `kind: ${kind}`];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push(BLOCK_CLOSE);
  return `${lines.join("\n")}\n`;
}

const timeOf = (text) => {
  const time = typeof text === "string" ? Date.parse(text) : Number.NaN;
  return Number.isNaN(time) ? null : time;
};

/** Whether GitHub's timestamp `earlier` is not after `later`; null when either cannot be read. */
export function notAfter(earlier, later) {
  const a = timeOf(earlier);
  const b = timeOf(later);
  return a === null || b === null ? null : a <= b;
}

/** Whether GitHub's timestamp `earlier` is strictly before `later`; null when either cannot be read. */
export function isBefore(earlier, later) {
  const a = timeOf(earlier);
  const b = timeOf(later);
  return a === null || b === null ? null : a < b;
}

/**
 * Reads one record and checks it: the comment exists here and its body has the referenced digest, the issuer
 * is configured (and, for a review or an acceptance, is not the Owner), the author is that issuer, the
 * comment is where the kind belongs, and the block is this kind's, with `expected` values exactly.
 *
 * `issuer` is the account allowed to write it, or null when the policy names none. `pullRequest` is the pull
 * request it must sit on, or null for anywhere in this repository. `verdict` is the verdict it must give.
 *
 * Returns the record as the report shows it, the refusals, and the comment's `createdAt`.
 */
export async function readRecord({ github, gate, kind, reference, issuer, owner, repository, pullRequest, expected, verdict }) {
  const reasons = [];
  const refuse = (code, detail) => reasons.push(refusal(gate, code, `${kind} record ${reference.text}: ${detail}`));
  const record = {
    kind,
    reference: reference.text,
    id: reference.id,
    digest: null,
    author: null,
    via: null,
    createdAt: null,
    updatedAt: null,
    issue: null,
    fields: null,
    satisfied: false,
  };

  if (issuer === null) {
    reasons.push(refusal(gate, "evidence_issuer_unconfigured", `the release-evidence policy names no issuer of ${kind} records`));
  } else if (INDEPENDENT_KINDS.has(kind) && (issuer.id === owner.id || issuer.login.toLowerCase() === owner.login.toLowerCase())) {
    reasons.push(
      refusal(gate, "evidence_issuer_not_independent", `the release-evidence policy names the Owner's account as the issuer of ${kind} records`),
    );
  }

  const comment = await github.issueComment(reference.id);
  if (!comment) {
    refuse("evidence_record_missing", `no comment ${reference.id} exists in ${repository}`);
    return { record, reasons, createdAt: null };
  }
  const body = typeof comment.body === "string" ? comment.body : "";
  record.digest = bodyDigest(body);
  record.author = { login: comment.user?.login ?? null, id: comment.user?.id ?? null };
  record.via = comment.performed_via_github_app?.slug ?? null;
  record.createdAt = comment.created_at ?? null;
  record.updatedAt = comment.updated_at ?? null;
  const issuePath = (() => {
    try {
      return new URL(String(comment.issue_url)).pathname;
    } catch {
      return "";
    }
  })();
  const issueMatch = new RegExp(`/repos/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/([1-9]\\d*)$`).exec(issuePath);
  record.issue = issueMatch ? Number(issueMatch[1]) : null;

  if (record.digest !== reference.digest) {
    refuse("evidence_digest_mismatch", `its body's digest is ${record.digest}; it was edited, or the reference names another comment`);
  }
  // GitHub keeps a comment's author when anyone with write access edits it, so only an unedited comment is
  // its author's statement.
  if (record.updatedAt !== record.createdAt) {
    refuse("evidence_record_edited", `it was created at ${record.createdAt} and edited at ${record.updatedAt}; post a new record instead`);
  }
  if (issuer !== null && (record.author.id !== issuer.id || record.author.login !== issuer.login)) {
    refuse(
      "evidence_wrong_issuer",
      `it was written by ${JSON.stringify(record.author.login)} (${record.author.id}), not ${issuer.login} (${issuer.id})`,
    );
  }
  if (record.issue === null || (pullRequest !== null && record.issue !== pullRequest)) {
    refuse(
      "evidence_wrong_location",
      `it is on ${record.issue === null ? "no issue of this repository" : `#${record.issue}`}, not ${pullRequest === null ? "an issue of this repository" : `pull request #${pullRequest}`}`,
    );
  }

  const block = readBlock(body);
  if (block.problem) {
    refuse("evidence_block_invalid", block.problem);
    return { record, reasons, createdAt: record.createdAt };
  }
  record.fields = block.fields;
  const required = ["schema", "kind", "repository", ...RECORD_KEYS[kind]];
  const missing = required.filter((key) => !Object.hasOwn(block.fields, key));
  const unknown = Object.keys(block.fields).filter((key) => !required.includes(key));
  if (block.fields.kind !== kind) {
    refuse("evidence_block_invalid", `its block is a ${JSON.stringify(block.fields.kind ?? null)} record, not ${kind}`);
  } else if (missing.length > 0 || unknown.length > 0) {
    refuse(
      "evidence_block_invalid",
      [missing.length > 0 ? `its block lacks ${missing.join(", ")}` : null, unknown.length > 0 ? `its block has unknown keys ${unknown.join(", ")}` : null]
        .filter(Boolean)
        .join("; "),
    );
  } else {
    const authoritative = { schema: RECORD_SCHEMA, repository, ...expected };
    for (const [key, value] of Object.entries(authoritative)) {
      if (block.fields[key] !== value) {
        refuse("evidence_field_mismatch", `${key} is ${JSON.stringify(block.fields[key])}, not ${JSON.stringify(value)}`);
      }
    }
    if (verdict !== undefined && block.fields.verdict !== verdict) {
      refuse("evidence_verdict_not_accepted", `its verdict is ${JSON.stringify(block.fields.verdict)}, not ${verdict}`);
    }
  }

  record.satisfied = reasons.length === 0;
  return { record, reasons, createdAt: record.createdAt };
}
