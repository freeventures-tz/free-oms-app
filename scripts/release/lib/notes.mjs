/**
 * Release notes from a calculated preview.
 *
 * Every accepted merge appears exactly once, in history order, whatever its type — tests,
 * documentation, CI, maintenance and release preparation included. Nothing is grouped away or
 * filtered by type. Breaking changes and deprecations are ALSO listed on their own, so the required
 * user actions are visible without reading every entry.
 */

import { escapeMarkdown } from "./markdown.mjs";

const POLICY = {
  "0.x": "0.x — a breaking change raises the minor version and is listed below",
  stable: "stable — a breaking change raises the major version",
};

const short = (sha) => sha.slice(0, 7);

export function renderReleaseNotes(preview) {
  const lines = [
    `## ${preview.version} — release notes preview`,
    "",
    "Calculated from accepted merges. Not reserved and not published.",
    "",
    "| | |",
    "| --- | --- |",
    `| Repository | ${escapeMarkdown(preview.repository)} |`,
    `| Exact merge | \`${preview.sha}\` |`,
    `| Normal-release base | \`${preview.base.tag}\` at \`${preview.base.commit}\` |`,
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
    lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${escapeMarkdown(m.breakingExplanation)}`);
  }

  lines.push("", "### Deprecations", "");
  const deprecations = preview.merges.filter((m) => m.deprecation);
  if (deprecations.length === 0) lines.push("None.");
  for (const m of deprecations) {
    lines.push(`- **${escapeMarkdown(m.title)}** ([#${m.pr}](${m.url})): ${escapeMarkdown(m.deprecation)}`);
  }

  lines.push("", `### Accepted merges (${preview.merges.length})`, "");
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

  if (preview.proposed.length > 0) {
    lines.push(
      "",
      `### Proposed, not accepted (${preview.proposed.length})`,
      "",
      `Not in history, so not in the version above. Including them, the calculation gives **${preview.versionIncludingProposed}**.`,
      "",
    );
    for (const p of preview.proposed) {
      lines.push(`- **${escapeMarkdown(p.title)}** — \`${p.type}\` → ${p.change}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** What `preview --format markdown` prints: the notes, or what stopped them. */
export function renderPreviewReport(preview) {
  if (preview.status === "calculated") return preview.notes;

  if (preview.status === "no_accepted_changes") {
    return `## Release preview: nothing to release\n\n\`${preview.sha}\` is the normal release \`${preview.base.tag}\` itself.\n`;
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
