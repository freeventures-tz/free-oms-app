/**
 * Release notes from a calculated preview.
 *
 * Every accepted merge appears exactly once, in history order, whatever its type — tests,
 * documentation, CI, maintenance and release preparation included. Nothing is grouped away or
 * filtered by type. Breaking changes and deprecations are ALSO listed on their own, so the required
 * user actions are visible without reading every entry.
 */

import { escapeMarkdown, listParagraphs } from "./markdown.mjs";

const POLICY = {
  "0.x": "0.x — a breaking change raises the minor version and is listed below",
  stable: "stable — a breaking change raises the major version",
};

const short = (sha) => sha.slice(0, 7);

/**
 * What the package version at a commit claims, beside the release the calculation starts from. A version
 * ahead of the last normal release is a preparation that has merged and not been released; it is shown,
 * and never calculated from.
 */
export function describePackageVersion(metadata, base) {
  const version = metadata.packageVersion === null ? null : `\`${escapeMarkdown(metadata.packageVersion)}\``;
  switch (metadata.relation) {
    case "last_normal_release":
      return `${version}, the last normal release`;
    case "ahead_of_last_normal_release":
      return `${version}, ahead of the last normal release \`${base.tag}\`: prepared and not yet released. The version above is calculated from \`${base.tag}\``;
    case "behind_last_normal_release":
      return `${version}, behind the last normal release \`${base.tag}\``;
    case "not_a_normal_version":
      return `${version}, which is not a normal version`;
    case "inconsistent":
      return `${version} in package.json, which package-lock.json does not repeat`;
    case "unreadable":
      return "package.json cannot be read";
    default:
      return "none: this commit has no package.json";
  }
}

export function renderReleaseNotes(preview) {
  const preparation = preview.preparation ?? null;
  const lines = [
    `## ${preview.version} — release notes preview`,
    "",
    preparation
      ? "Calculated from accepted merges and this release's preparation. Not reserved and not published."
      : "Calculated from accepted merges. Not reserved and not published.",
    "",
    "| | |",
    "| --- | --- |",
    `| Repository | ${escapeMarkdown(preview.repository)} |`,
    `| Exact merge | \`${preview.sha}\` |`,
    `| Normal-release base | \`${preview.base.tag}\` at \`${preview.base.commit}\` |`,
    ...(preview.candidateMetadata
      ? [`| Package version at this merge | ${describePackageVersion(preview.candidateMetadata, preview.base)} |`]
      : []),
    `| Version policy | ${POLICY[preview.policy]} |`,
    `| Highest change | ${preview.highestChange} |`,
    `| Stable-contract acceptance | ${
      preview.stableContractAcceptance
        ? `requested with reference ${escapeMarkdown(preview.stableContractAcceptance.reference)} — recorded here, not validated`
        : "not requested"
    } |`,
    "",
    "### Breaking changes",
    "",
  ];

  const breaking = preview.merges.filter((m) => m.breaking);
  if (breaking.length === 0) lines.push("None.");
  for (const m of breaking) {
    lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${listParagraphs(m.breakingExplanation)}`);
  }

  lines.push("", "### Deprecations", "");
  const deprecations = preview.merges.filter((m) => m.deprecation);
  if (deprecations.length === 0) lines.push("None.");
  for (const m of deprecations) {
    lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${listParagraphs(m.deprecation)}`);
  }

  lines.push("", `### Accepted merges (${preview.merges.length + (preparation ? 1 : 0)})`, "");
  preview.merges.forEach((m, index) => {
    lines.push(
      `${index + 1}. **${escapeMarkdown(m.title)}** — [#${m.pr}](${m.url}) · merge [\`${m.mergeSha}\`](${m.mergeUrl}) · \`${m.type}\` → ${m.change}`,
    );
    if (m.reverts.length > 0) {
      lines.push(`   - Reverts: ${m.reverts.map((r) => `[\`${r.sha}\`](${r.url})`).join(", ")}`);
    }
    lines.push(
      `   - Development commits: ${m.developmentCommits
        .map((dev) => `[\`${short(dev.sha)}\`](${dev.url}) ${escapeMarkdown(dev.subject)}`)
        .join("; ")}`,
    );
  });
  if (preparation) {
    const link = preparation.pr === null ? "pull request not named yet" : `[#${preparation.pr}](${preparation.url})`;
    lines.push(
      `${preview.merges.length + 1}. **${escapeMarkdown(preparation.title)}** — ${link} · this release's preparation; history records its merge when it merges · \`chore\` → patch`,
    );
  }

  lines.push(...proposedSection(preview));

  return `${lines.join("\n")}\n`;
}

/**
 * Titles given with `--proposed-title` and the version they would give. Kept apart from accepted
 * merges in every state, including right after a normal release when nothing has merged yet.
 */
function proposedSection(preview) {
  if (preview.proposed.length === 0) return [];
  const lead =
    preview.status === "calculated"
      ? "Not in history, so not in the version above."
      : "Not in history, so there is still nothing to release.";
  return [
    "",
    `### Proposed, not accepted (${preview.proposed.length})`,
    "",
    `${lead} Including them, the calculation gives **${preview.versionIncludingProposed}**.`,
    "",
    ...preview.proposed.map((p) => `- **${escapeMarkdown(p.title)}** — \`${p.type}\` → ${p.change}`),
  ];
}

/** What `preview --format markdown` prints: the notes, or what stopped them. */
export function renderPreviewReport(preview) {
  if (preview.status === "calculated") return preview.notes;

  if (preview.status === "no_accepted_changes") {
    const lines = [
      "## Release preview: nothing to release",
      "",
      `\`${preview.sha}\` is the normal release \`${preview.base.tag}\` itself.`,
      ...proposedSection(preview),
    ];
    return `${lines.join("\n")}\n`;
  }

  const heading =
    preview.status === "pending_decision"
      ? "## Release preview: pending an Owner decision"
      : "## Release preview: refused";
  const lines = [heading, "", `Exact merge \`${preview.sha}\`. No version was calculated.`, ""];
  for (const r of preview.reasons) {
    const where = [r.commit ? `commit \`${r.commit}\`` : null, r.pr ? `PR #${r.pr}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`- \`${r.code}\` (${r.kind.replace("_", " ")})${where ? ` at ${where}` : ""}: ${escapeMarkdown(r.detail)}`);
  }
  return `${lines.join("\n")}\n`;
}
