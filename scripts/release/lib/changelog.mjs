/**
 * CHANGELOG.md as the release controller sees it: a preamble, then one section per release, newest
 * first, each headed `## [X.Y.Z] — date`.
 *
 * A preparation owns two things in the section it writes: the heading line, and a block between
 * `<!-- release-controller:begin … -->` and `<!-- release-controller:end -->`. The block lists every
 * accepted merge after the last normal release, and last of all the preparation's own pull request.
 * Its merge commit cannot be listed before it exists, and it does not need to be: once merged, the
 * preparation is an accepted merge like any other, and the release notes and tag read its sha from
 * history. So the changelog never needs a second commit to record it.
 *
 * Everything else is kept byte for byte, line endings included: the preamble, earlier releases, and prose
 * a person writes above or below the block. A preparation repeated on the same branch replaces its
 * heading and block, and nothing else.
 */

import semver from "semver";

import { escapeMarkdown, listParagraphs } from "./markdown.mjs";
import { NORMAL_VERSION } from "./version.mjs";

const BOM = "\uFEFF";
const HEADING = /^## \[([^\]]*)\]/;
const MARKER = /^<!-- release-controller:/;
const BEGIN = /^<!-- release-controller:begin version=(\S+) base=(\S+) preparation=([1-9]\d*|none) -->$/;
const END = "<!-- release-controller:end -->";

const withoutTerminator = (line) => line.replace(/\r?\n$/, "");
const terminatorOf = (line) => /\r?\n$/.exec(line)?.[0] ?? "";

/**
 * The changelog's lines, each with its own terminator, and its release sections. `problems` says why the
 * structure cannot be trusted: a heading that is not a normal version, releases out of order, or a marker
 * the controller did not write where it writes them.
 */
export function parseChangelog(text) {
  const bom = text.startsWith(BOM) ? BOM : "";
  const lines = text.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const firstTerminated = lines.find((line) => line.endsWith("\n"));
  const eol = firstTerminated?.endsWith("\r\n") ? "\r\n" : "\n";
  const sections = [];
  const problems = [];

  lines.forEach((line, index) => {
    const value = withoutTerminator(line);
    const heading = HEADING.exec(value);
    if (heading) {
      if (!NORMAL_VERSION.test(heading[1])) {
        problems.push(`has a release heading ${JSON.stringify(value)} whose version is not a normal version`);
      }
      sections.push({ index, end: lines.length, version: heading[1], heading: value, begin: null, close: null, marker: null });
      return;
    }
    if (!MARKER.test(value)) return;
    const section = sections[sections.length - 1];
    const begin = BEGIN.exec(value);
    if (section && begin && section.begin === null) {
      section.begin = index;
      section.marker = { version: begin[1], base: begin[2], preparation: begin[3] === "none" ? null : Number(begin[3]) };
    } else if (section && value === END && section.begin !== null && section.close === null) {
      section.close = index;
    } else {
      problems.push(`has a misplaced or malformed release-controller marker: ${JSON.stringify(value)}`);
    }
  });

  sections.forEach((section, position) => {
    const next = sections[position + 1];
    if (next) section.end = next.index;
    if (section.begin !== null && section.close === null) {
      problems.push(`has a release-controller block in ${section.version} that never ends`);
    }
    if (next && NORMAL_VERSION.test(section.version) && NORMAL_VERSION.test(next.version) && !semver.gt(section.version, next.version)) {
      problems.push(`lists ${section.version} above ${next.version}; releases must run newest first, each once`);
    }
  });

  return { bom, lines, eol, sections, problems };
}

/** The title a release preparation's pull request carries, and its merge body keeps. */
export function preparationTitle(version) {
  return `chore(release): prepare ${version}`;
}

export function sectionHeading(version, date) {
  return `## [${version}] — ${date}`;
}

/**
 * The generated block, begin marker to end marker, as lines without terminators. `merges` are the
 * accepted merges after the base, as `readAcceptedRange` returns them; `preparation` is `{ pr, url, title }`,
 * where `pr` may be null in a dry run.
 */
export function renderBlock({ version, base, policy, highestChange, merges, preparation }) {
  const lines = [
    `<!-- release-controller:begin version=${version} base=${base.tag} preparation=${preparation.pr ?? "none"} -->`,
    `Generated from every accepted merge after \`${base.tag}\`. Each preparation replaces the lines between these markers; write prose above or below them.`,
    "",
  ];

  const breaking = merges.filter((m) => m.breaking);
  const deprecations = merges.filter((m) => m.deprecation);
  const summary = `Version policy ${policy}. Highest change: ${highestChange}.`;
  lines.push(breaking.length + deprecations.length === 0 ? `${summary} No breaking change and no deprecation.` : summary, "");
  if (breaking.length > 0) {
    lines.push("### Breaking changes", "");
    for (const m of breaking) {
      lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${listParagraphs(m.breakingExplanation)}`);
    }
    lines.push("");
  }
  if (deprecations.length > 0) {
    lines.push("### Deprecations", "");
    for (const m of deprecations) {
      lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${listParagraphs(m.deprecation)}`);
    }
    lines.push("");
  }

  const total = merges.length + 1;
  lines.push(`### Accepted merges (${total})`, "");
  merges.forEach((m, index) => {
    lines.push(
      `${index + 1}. **${escapeMarkdown(m.title)}** — [#${m.pr}](${m.url}) · merge [\`${m.mergeSha.slice(0, 7)}\`](${m.mergeUrl}) · \`${m.type}\` → ${m.change}`,
    );
    if (m.reverts.length > 0) {
      lines.push(`   - Reverts: ${m.reverts.map((r) => `[\`${r.sha.slice(0, 7)}\`](${r.url})`).join(", ")}`);
    }
  });
  const link = preparation.pr === null ? "pull request not named yet" : `[#${preparation.pr}](${preparation.url})`;
  lines.push(`${total}. **${escapeMarkdown(preparation.title)}** — ${link} · this release's preparation · \`chore\` → patch`, END);

  // An explanation of several paragraphs arrives as one string; the file holds it as lines.
  return lines.flatMap((line) => line.split("\n"));
}

/** A section's lines from its heading up to the next release, each ended with `\n`. */
export function sectionText(changelog, section) {
  return changelog.lines
    .slice(section.index, section.end)
    .map((line) => `${withoutTerminator(line)}\n`)
    .join("");
}

/** A section's generated block, marker to marker, as lines without terminators; null when it has none. */
export function blockLines(changelog, section) {
  if (section.begin === null || section.close === null) return null;
  return changelog.lines.slice(section.begin, section.close + 1).map(withoutTerminator);
}

/**
 * Why a changelog's newest release is not what its package version says, or null when it is.
 *
 * With no `pendingVersion`, the newest release must be the last normal release. With one, the newest
 * must be the section a preparation generated for that version from that release. That means its heading,
 * a block whose marker names the same version and base, and the last normal release directly below it.
 */
export function newestReleaseProblem(changelog, { base, pendingVersion }) {
  const [newest, next] = changelog.sections;
  if (!newest) return `has no release section; its newest release must be the last normal release, ${base.version}`;
  if (pendingVersion === null) {
    return newest.version === base.version
      ? null
      : `has ${newest.version} as its newest release, but the package version is the last normal release, ${base.version}`;
  }
  if (newest.version !== pendingVersion) {
    return `has ${newest.version} as its newest release, but the package version is ${pendingVersion}`;
  }
  if (newest.begin === null || newest.marker.version !== pendingVersion || newest.marker.base !== base.tag) {
    return `has a ${pendingVersion} section that is not a preparation's from ${base.tag}, so it is not replaced`;
  }
  if (next?.version !== base.version) {
    return `lists ${next?.version ?? "nothing"} below the pending ${pendingVersion}, not the last normal release ${base.version}`;
  }
  return null;
}

/**
 * The changelog with a preparation's heading and block in place, or the reason they cannot be placed.
 *
 * With no `pendingVersion`, a new section goes above the last normal release. With one, that section's
 * heading and block are replaced, and nothing else in it changes. The pending section is a preparation
 * this branch made, or one that merged and was never released. `newestReleaseProblem` decides which is
 * allowed.
 */
export function placeSection(changelog, { base, pendingVersion, heading, block }) {
  const problem = newestReleaseProblem(changelog, { base, pendingVersion });
  if (problem) return { reason: problem };
  const [newest] = changelog.sections;
  const lines = [...changelog.lines];
  const terminated = (line) => `${line}${changelog.eol}`;

  if (pendingVersion === null) {
    lines.splice(newest.index, 0, ...[heading, "", ...block, ""].map(terminated));
    return { text: `${changelog.bom}${lines.join("")}` };
  }

  const closeTerminator = terminatorOf(changelog.lines[newest.close]);
  lines.splice(
    newest.begin,
    newest.close - newest.begin + 1,
    ...block.map((line, index) => (index === block.length - 1 ? `${line}${closeTerminator}` : terminated(line))),
  );
  lines[newest.index] = `${heading}${terminatorOf(changelog.lines[newest.index])}`;
  return { text: `${changelog.bom}${lines.join("")}` };
}
