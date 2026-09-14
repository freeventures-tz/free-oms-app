/** The Markdown the reconciliation commands print, and append to a job summary. Every text from history is escaped. */

import { escapeMarkdown } from "./markdown.mjs";

const pr = (commit) => (commit.pr ? ` · #${commit.pr}` : "");
const reasonLines = (reasons, indent = "") => reasons.map((r) => `${indent}- \`${r.code}\`: ${escapeMarkdown(r.detail)}`);

function identityRows(report) {
  return [
    "| | |",
    "| --- | --- |",
    `| Command | \`${report.command}\` |`,
    `| Repository | ${escapeMarkdown(report.repository)} |`,
    `| Main | ${report.main ? `\`${report.main}\` (${escapeMarkdown(report.mainRef)})` : escapeMarkdown(report.mainRef)} |`,
    `| Window | ${report.since ? `accepted merges after \`${report.since.tag}\` at \`${report.since.commit}\`` : "none"} |`,
  ];
}

function newestGates(commit) {
  const run = commit.ci?.runs?.[0];
  if (!run || run.gates.length === 0) return [];
  const gates = run.gates.map((gate) => `${escapeMarkdown(gate.name)} ${gate.result}`).join("; ");
  return [`  - Gates in run ${run.runId} attempt ${run.attempt}: ${gates}`];
}

export function renderReconciliationReport(report) {
  const { counts } = report;
  const lines = [
    report.decision === "refused"
      ? "## Build-tag reconciliation: refused"
      : `## Build-tag reconciliation: ${counts.eligible} eligible, ${counts.blocked} blocked, ${counts.recorded} recorded`,
    "",
    ...identityRows(report),
    `| Started by | ${report.trigger ? `CI run ${report.trigger.runId} for \`${report.trigger.sha}\`` : "no CI completion: a recovery dispatch or a local run"} |`,
    "| Publication | none |",
  ];

  const section = (title, commits, render) => {
    if (commits.length === 0) return;
    lines.push("", `### ${title} (${commits.length})`, "");
    for (const commit of commits) lines.push(...render(commit));
  };
  const having = (...decisions) => report.commits.filter((commit) => decisions.includes(commit.decision));

  section("Eligible", having("eligible"), (c) => [
    `- \`${c.sha}\`${pr(c)} · \`${c.tag.name}\` · provisional · ${c.target.version} from \`${c.target.base.tag}\``,
  ]);
  section("Blocked", having("pending", "failed", "refused"), (c) => [
    `- \`${c.sha}\`${pr(c)} · ${c.decision}`,
    ...reasonLines(c.reasons, "  "),
    ...newestGates(c),
  ]);
  section("Recorded", having("recorded"), (c) => [
    `- \`${c.sha}\`${pr(c)} · \`${c.recordedTag.name}\`${c.recordedTag.verification === "git" ? " · checked from Git: a normal release contains it" : ""}`,
  ]);
  section("Not applicable", having("not_applicable"), (c) => [
    `- \`${c.sha}\` · the normal release ${c.releasedAs.map((name) => `\`${name}\``).join(", ")}`,
  ]);
  if (report.reasons.length > 0) lines.push("", "### Reasons", "", ...reasonLines(report.reasons));
  return `${lines.join("\n")}\n`;
}

const PUBLICATION_HEADINGS = Object.freeze({
  published: "published",
  nothing_to_publish: "nothing to publish",
  refused: "refused",
  publication_disabled: "eligible, but publication is not activated",
  interrupted: "interrupted, and the next reconciliation resumes",
});

export function renderPublicationReport(report) {
  const lines = [
    `## Reconciled build tags: ${PUBLICATION_HEADINGS[report.decision] ?? report.decision}`,
    "",
    ...identityRows(report),
    `| Publication | ${report.publication} |`,
  ];
  if (report.counts) {
    lines.push(
      `| Window now | ${report.counts.eligible} eligible, ${report.counts.blocked} blocked, ${report.counts.recorded} recorded |`,
    );
  }
  if (report.commits.length > 0) {
    lines.push("", "### Eligible commits", "");
    for (const commit of report.commits) {
      const name = commit.tag?.name ?? commit.existingTag?.name;
      lines.push(`- \`${commit.sha}\`${pr(commit)} · ${commit.decision.replace("_", " ")}${name ? ` · \`${name}\`` : ""}`);
      lines.push(...reasonLines(commit.reasons, "  "));
    }
  }
  if (report.reasons.length > 0) lines.push("", "### Reasons", "", ...reasonLines(report.reasons));
  return `${lines.join("\n")}\n`;
}

export function renderStatusesReport(report) {
  const lines = [`## Build-tag statuses: ${report.decision.replace("_", " ")}`, ""];
  for (const commit of report.commits) {
    const status = commit.status ? ` · ${commit.status.state}: ${escapeMarkdown(commit.status.description)}` : "";
    lines.push(`- \`${commit.sha}\`${commit.trigger ? " · started this run" : ""} · ${commit.result.replace("_", " ")}${status}`);
  }
  if (report.reasons.length > 0) lines.push(...reasonLines(report.reasons));
  return `${lines.join("\n")}\n`;
}
