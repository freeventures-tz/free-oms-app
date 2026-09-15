/** The Markdown a build command prints, and appends to a job summary. Every text from history is escaped. */

import { ciEvidence } from "./build-tags.mjs";
import { escapeMarkdown } from "./markdown.mjs";

const HEADINGS = Object.freeze({
  eligible: "eligible",
  already_tagged: "already tagged",
  tagged: "created",
  not_applicable: "not applicable, the commit is a normal release",
  pending: "pending",
  failed: "a required CI gate is unsatisfied",
  refused: "refused",
  publication_disabled: "eligible, but publication is not activated",
});

export function renderBuildReport(report) {
  const lines = [
    `## Build tag: ${HEADINGS[report.decision] ?? report.decision}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Command | \`${report.command}\` |`,
    `| Exact merge | \`${report.sha ?? "unknown"}\` |`,
    `| Repository | ${escapeMarkdown(report.repository)} |`,
    `| Publication | ${report.publication === "created" ? `created \`${report.tag.name}\`` : "none"} |`,
  ];
  const { target, tag, existingTag, ci } = report;
  if (target) {
    lines.push(
      `| Target | ${target.version} from \`${target.base.tag}\` at \`${target.base.commit}\` · highest change ${target.highestChange} |`,
      `| Notes digest | \`${target.notesDigest}\` |`,
    );
  }
  if (tag) {
    lines.push(
      `| Tag | \`${tag.name}\`${tag.provisional ? " · provisional: the writer allocates the ordinal again under its lock" : ` · object \`${tag.object}\``} |`,
    );
  }
  if (existingTag) lines.push(`| Existing build tag | \`${existingTag.name}\` · object \`${existingTag.object}\` |`);
  if (report.releasedAs.length > 0) {
    lines.push(`| Normal release at this commit | ${report.releasedAs.map((name) => `\`${name}\``).join(", ")} |`);
  }
  if (ci?.satisfiedBy) {
    lines.push(`| Final-merge CI | run ${ci.satisfiedBy.runId} attempt ${ci.satisfiedBy.attempt} |`);
  }
  if (report.status) {
    lines.push(`| Commit status | ${report.status.state}: ${escapeMarkdown(report.status.description)} |`);
  }

  const shown = ci?.runs.find((run) => run.runId === ci.satisfiedBy?.runId) ?? ci?.runs[0];
  if (shown && shown.gates.length > 0) {
    lines.push(
      "",
      `### Required gates in run ${shown.runId} attempt ${shown.attempt}`,
      "",
      "| Gate | Result |",
      "| --- | --- |",
      ...shown.gates.map(
        (gate) =>
          `| ${escapeMarkdown(gate.name)} | ${gate.result}${gate.conclusion && gate.result !== "success" ? ` (${gate.conclusion})` : ""} |`,
      ),
    );
  }
  const evidence = ci ? ciEvidence(ci) : [];
  if (evidence.length > 0) {
    lines.push("", "### Final-merge CI evidence", "", ...evidence.map((line) => `- ${escapeMarkdown(line)}`));
  }
  if (ci && ci.ignoredRuns.length > 0) {
    lines.push(
      "",
      "### Runs that are not final-merge CI",
      "",
      ...ci.ignoredRuns.map((run) => `- run ${run.runId}: ${escapeMarkdown(run.why.join("; "))}`),
    );
  }
  if (target && target.merges.length > 0) {
    lines.push(
      "",
      `### Accepted merges (${target.merges.length})`,
      "",
      ...target.merges.map((merge) => `- #${merge.pr} \`${merge.mergeSha}\` ${escapeMarkdown(merge.title)} → ${merge.change}`),
    );
  }
  if (report.reasons.length > 0) {
    lines.push(
      "",
      "### Reasons",
      "",
      ...report.reasons.map((r) => `- \`${r.code}\` (${r.kind.replace("_", " ")}): ${escapeMarkdown(r.detail)}`),
    );
  }
  return `${lines.join("\n")}\n`;
}
