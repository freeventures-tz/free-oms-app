/**
 * What one accepted change means for the version, decided from its title and its retained body.
 *
 * The policy is issue #36's and nothing here extends it. A title must be a Conventional Commit with
 * one of the declared types. `feat` is new functionality; every other declared type is a compatible
 * patch. A breaking change needs BOTH markers — `!` in the title and a `BREAKING CHANGE:` explanation
 * — because either one alone is exactly the ambiguity the policy refuses to guess about. Deprecation
 * is minor. A revert names the commit it reverts and is classified by the contract it leaves behind.
 *
 * Everything that cannot be classified without guessing is returned as a named reason, never as a
 * default. The caller decides what a refusal stops; this module only refuses.
 *
 * Strings here are data. Nothing a title or body contains is ever evaluated, interpolated into a
 * shell or used to build a pattern.
 */

import { CommitParser } from "conventional-commits-parser";

/** The declared types and the change each implies when no breaking marker is present. */
export const DECLARED_TYPES = Object.freeze({
  feat: "minor",
  fix: "patch",
  perf: "patch",
  test: "patch",
  docs: "patch",
  chore: "patch",
  ci: "patch",
  build: "patch",
  refactor: "patch",
  style: "patch",
});

/** Change levels, lowest first. The index is the order used to pick the highest. */
export const CHANGE_LEVELS = Object.freeze(["patch", "minor", "breaking"]);

// Deliberately permissive: the parser finds the parts, and the rules below judge them. A header the
// pattern cannot split at all is malformed; a header it can split into an undeclared type is
// reported as that, which tells an author what to change.
const parser = new CommitParser({
  headerPattern: /^(\w+)(?:\(([^()\r\n]*)\))?(!)?: (.*)$/,
  headerCorrespondence: ["type", "scope", "breaking", "subject"],
  noteKeywords: ["BREAKING CHANGE", "BREAKING-CHANGE"],
});

const SCOPE = /^[a-z0-9][a-z0-9._/-]*$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: (\S.*)$/;
const BREAKING_FOOTER_EMPTY = /^BREAKING[ -]CHANGE:\s*$/;
const BREAKING_NEAR_MISS = /^\s*(?:[*-]\s+)?breaking[\s_-]*changes?\b/i;

const DEPRECATED_FOOTER = /^DEPRECATED: (\S.*)$/;
const DEPRECATED_FOOTER_EMPTY = /^DEPRECATED:\s*$/;
const DEPRECATED_NEAR_MISS = /^\s*(?:[*-]\s+)?deprecat(?:ed|ion|es)s?\s*[:-]/i;

const REVERTS_FOOTER = /^Reverts: (\S+)$/;
const REVERTS_NEAR_MISS = /^\s*(?:[*-]\s+)?reverts?\s*:|^Reverts\s+\S+#\d+\s*$|^This reverts commit\b/i;

const OVERRIDE_FOOTER = /^\s*(?:release-as|semver|semver-bump|version-bump)\s*:/i;
const OVERRIDE_TOKEN = /\[(?:major|minor|patch)\]|\+semver:\s*\w+/i;

/** Any `Token: value` line, used to end a multi-line footer value. */
const FOOTER_TOKEN = /^(?:BREAKING[ -]CHANGE|[A-Za-z][\w-]*): /;

function reason(code, detail) {
  return { code, detail };
}

/**
 * A footer's value — the rest of its line plus continuation lines up to a blank line or the next
 * footer — and the raw lines it came from, which are what a merge body has to keep.
 */
function footerValue(lines, index, firstLine) {
  const parts = [firstLine];
  const raw = [lines[index]];
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (!line.trim() || FOOTER_TOKEN.test(line)) break;
    parts.push(line.trim());
    raw.push(line);
  }
  return { value: parts.join(" "), raw };
}

/**
 * Classifies one change.
 *
 * @param {{ title: string, description?: string }} change The title, and the body that accompanies
 *   it — a PR description before merge, the retained merge body after it.
 * @returns {{ ok: true, classification: object, footersToRetain: string[] }
 *   | { ok: false, reasons: Array<{ code: string, detail: string }> }}
 */
export function classifyChange({ title, description = "" }) {
  const reasons = [];

  if (typeof title !== "string" || title.length === 0) {
    return { ok: false, reasons: [reason("malformed_title", "the title is empty")] };
  }
  if (/[\r\n]/.test(title)) {
    return { ok: false, reasons: [reason("malformed_title", "the title spans more than one line")] };
  }
  if (title !== title.trim()) {
    return {
      ok: false,
      reasons: [reason("malformed_title", "the title has leading or trailing whitespace")],
    };
  }

  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const parsed = parser.parse(`${title}\n\n${description.replace(/\r\n?/g, "\n")}`);

  if (!parsed.type) {
    if (/^revert\b/i.test(title)) {
      return {
        ok: false,
        reasons: [
          reason(
            "ambiguous_revert",
            "a revert title must still be a Conventional Commit naming the resulting contract, with a `Reverts: <full sha>` footer",
          ),
        ],
      };
    }
    return {
      ok: false,
      reasons: [reason("malformed_title", "the title is not `type(scope)!: description`")],
    };
  }

  const type = parsed.type;
  const scope = parsed.scope;
  const bang = parsed.breaking === "!";
  const subject = parsed.subject ?? "";

  if (type === "revert") {
    reasons.push(
      reason(
        "ambiguous_revert",
        "`revert` does not say what contract results; use the declared type for the result and a `Reverts: <full sha>` footer",
      ),
    );
  } else if (!Object.hasOwn(DECLARED_TYPES, type)) {
    reasons.push(
      reason(
        "unknown_type",
        `\`${type}\` is not a declared type (${Object.keys(DECLARED_TYPES).join(", ")})`,
      ),
    );
  }
  if (scope !== null && scope !== undefined && !SCOPE.test(scope)) {
    reasons.push(reason("malformed_title", "the scope must be lowercase letters, digits, `.`, `_`, `/` or `-`"));
  }
  if (!subject || subject !== subject.trim()) {
    reasons.push(reason("malformed_title", "the description after `: ` is empty or padded"));
  }

  let breakingExplanation = null;
  let deprecation = null;
  const reverts = [];
  const footersToRetain = [];

  lines.forEach((line, index) => {
    const breaking = BREAKING_FOOTER.exec(line);
    const deprecated = DEPRECATED_FOOTER.exec(line);
    const reverted = REVERTS_FOOTER.exec(line);

    if (breaking) {
      const { value, raw } = footerValue(lines, index, breaking[1]);
      breakingExplanation = breakingExplanation ? `${breakingExplanation} ${value}` : value;
      footersToRetain.push(...raw);
    } else if (BREAKING_FOOTER_EMPTY.test(line)) {
      reasons.push(reason("breaking_missing_explanation", "`BREAKING CHANGE:` has no explanation"));
    } else if (BREAKING_NEAR_MISS.test(line)) {
      reasons.push(
        reason(
          "malformed_breaking_footer",
          "a breaking-change line must be exactly `BREAKING CHANGE: <explanation>` at the start of a line",
        ),
      );
    }

    if (deprecated) {
      const { value, raw } = footerValue(lines, index, deprecated[1]);
      deprecation = deprecation ? `${deprecation} ${value}` : value;
      footersToRetain.push(...raw);
    } else if (DEPRECATED_FOOTER_EMPTY.test(line)) {
      reasons.push(reason("deprecation_missing_explanation", "`DEPRECATED:` has no explanation"));
    } else if (DEPRECATED_NEAR_MISS.test(line)) {
      reasons.push(
        reason(
          "malformed_deprecation_footer",
          "a deprecation line must be exactly `DEPRECATED: <what and why>` at the start of a line",
        ),
      );
    }

    if (reverted) {
      if (FULL_SHA.test(reverted[1])) {
        if (!reverts.includes(reverted[1])) reverts.push(reverted[1]);
        footersToRetain.push(line);
      } else {
        reasons.push(
          reason("ambiguous_revert", "`Reverts:` must name the reverted commit by its full 40-character sha"),
        );
      }
    } else if (REVERTS_NEAR_MISS.test(line)) {
      reasons.push(
        reason("ambiguous_revert", "a revert must be recorded as exactly `Reverts: <full sha>`"),
      );
    }

    if (OVERRIDE_FOOTER.test(line) || OVERRIDE_TOKEN.test(line)) {
      reasons.push(
        reason("unsupported_override", "the version is calculated from the declared types; overrides are refused"),
      );
    }
  });

  if (OVERRIDE_TOKEN.test(title)) {
    reasons.push(
      reason("unsupported_override", "the version is calculated from the declared types; overrides are refused"),
    );
  }

  // The parser reads `BREAKING CHANGE` case-insensitively and with a bullet in front. A note it found
  // that the strict rule did not is a marker somebody meant and wrote wrongly.
  const strictBreakingLines = lines.filter((line) => BREAKING_FOOTER.test(line)).length;
  if (
    parsed.notes.length > strictBreakingLines &&
    !reasons.some((r) => r.code === "malformed_breaking_footer" || r.code === "breaking_missing_explanation")
  ) {
    reasons.push(
      reason(
        "malformed_breaking_footer",
        "a breaking-change line must be exactly `BREAKING CHANGE: <explanation>` at the start of a line",
      ),
    );
  }

  if (/^revert\b/i.test(subject) && reverts.length === 0) {
    reasons.push(
      reason("ambiguous_revert", "a revert must name the reverted commit with a `Reverts: <full sha>` footer"),
    );
  }

  const breakingReported = reasons.some(
    (r) => r.code === "breaking_missing_explanation" || r.code === "malformed_breaking_footer",
  );
  if (bang && breakingExplanation === null && !breakingReported) {
    reasons.push(
      reason(
        "breaking_missing_explanation",
        "a `!` title needs a `BREAKING CHANGE: <explanation>` line in the body that is retained",
      ),
    );
  }
  if (!bang && breakingExplanation !== null) {
    reasons.push(
      reason(
        "breaking_missing_title_marker",
        "a `BREAKING CHANGE:` explanation needs `!` in the title as well; the two markers disagree",
      ),
    );
  }
  if (deprecation !== null && !bang && type !== "feat") {
    reasons.push(
      reason(
        "deprecation_requires_minor",
        `a deprecation is a minor change, but \`${type}\` declares a patch; use \`feat\``,
      ),
    );
  }

  if (reasons.length > 0) {
    return { ok: false, reasons: dedupe(reasons) };
  }

  const change = bang ? "breaking" : deprecation !== null ? "minor" : DECLARED_TYPES[type];

  return {
    ok: true,
    classification: {
      type,
      scope: scope ?? null,
      subject,
      breaking: bang,
      breakingExplanation,
      deprecation,
      reverts,
      change,
    },
    footersToRetain,
  };
}

function dedupe(reasons) {
  const seen = new Set();
  return reasons.filter((r) => {
    const key = `${r.code}\u0000${r.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The highest of a set of change levels, or null for none. */
export function highestChange(changes) {
  let highest = -1;
  for (const change of changes) {
    highest = Math.max(highest, CHANGE_LEVELS.indexOf(change));
  }
  return highest < 0 ? null : CHANGE_LEVELS[highest];
}
