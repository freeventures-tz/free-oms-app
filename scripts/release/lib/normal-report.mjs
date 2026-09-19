/** The Markdown the normal-release commands print, and append to a job summary. Every text from history is escaped. */

import { ciEvidence } from "./build-tags.mjs";
import { escapeMarkdown } from "./markdown.mjs";

const HEADINGS = Object.freeze({
  eligible: "every gate is satisfied",
  already_published: "already published",
  published: "published",
  pending: "pending",
  failed: "a required CI gate is unsatisfied",
  refused: "refused",
  publication_disabled: "every gate is satisfied, but normal publication is not activated",
});

const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

export function renderReleaseReport(report) {
  const request = report.request;
  const lines = [`## Normal release ${request ? code(`v${request.version}`) : ""}: ${HEADINGS[report.decision] ?? report.decision}`, ""];
  if (request) {
    lines.push(
      "| | |",
      "| --- | --- |",
      `| Command | ${code(report.command)} |`,
      `| Repository | ${escapeMarkdown(report.repository)} |`,
      `| Exact merge | ${code(request.sha)} |`,
      `| Main now | ${report.main ? code(report.main) : "not read"} |`,
      // The mode is settled once the policy at the commit has been read, which a refusal before that never does.
      `| Authorization | ${report.mode ?? "not read"} |`,
      `| Ticket | ${code(request.ticket)} |`,
      `| Preparation | #${request.preparationPr} |`,
      `| Deployment | ${request.deployment} |`,
      `| Dispatch | ${request.dispatch ? `run ${request.dispatch.runId} attempt ${request.dispatch.attempt}` : "not given; the writer checks it"} |`,
      `| Publication | ${report.publication} |`,
    );
    if (report.tag?.object) lines.push(`| Tag | ${code(report.tag.name)} · object ${code(report.tag.object)} |`);
    if (report.existingTag) lines.push(`| Tag | ${code(report.existingTag.name)} · object ${code(report.existingTag.object)}, already this release |`);
  }

  if (report.gates?.length > 0) {
    lines.push("", "### Gates", "", "| Gate | State |", "| --- | --- |");
    for (const gate of report.gates) lines.push(`| ${gate.gate} | ${gate.state.replace("_", " ")} |`);
  }

  if (report.release) {
    const { release } = report;
    lines.push(
      "",
      "### Release",
      "",
      `- ${release.version} from ${code(release.base.tag)}, policy ${release.policy}, highest change ${release.highestChange}`,
      `- Notes digest ${code(release.notesDigest)}`,
      `- Reviewed head ${release.reviewedHead ? code(release.reviewedHead) : "unknown"}, release date ${release.releaseDate ?? "unknown"}`,
    );
    if (report.schemaBoundary) lines.push(`- Schema boundary: ${code(report.schemaBoundary.value)}`);
  }

  const records = Object.entries(report.records ?? {}).filter(([, record]) => record);
  if (records.length > 0) {
    lines.push("", "### Records", "");
    for (const [, record] of records) {
      const author = record.author ? `${escapeMarkdown(record.author.login ?? "unknown")} (${record.author.id})` : "not read";
      // The agent and role are what the Owner is vouching for. GitHub authenticates the author, not them.
      const attests = record.agent ? ` attesting ${escapeMarkdown(record.agent)} as ${escapeMarkdown(record.role ?? "no role")} on ${code(record.ticket ?? "no ticket")},` : "";
      lines.push(
        `- ${record.kind}: comment ${record.id} on ${record.issue ? `#${record.issue}` : "no issue"} by ${author}${record.via ? ` via ${escapeMarkdown(record.via)}` : ""},${attests} created ${record.createdAt ?? "unknown"}, digest ${record.digest ? code(record.digest) : "none"}${record.satisfied ? "" : " · not satisfied"}`,
      );
    }
  }

  if (report.deployment) {
    const d = report.deployment;
    lines.push("", "### Deployment", "", `- ${d.id}: ${escapeMarkdown(d.environment ?? "unknown")} · ${d.sha ? code(d.sha) : "no commit"} · ${d.state ?? "no status"} · ${d.environmentUrl ? escapeMarkdown(d.environmentUrl) : "no URL"}`);
  }

  if (report.ci?.runs?.length > 0) {
    lines.push("", "### Final-merge CI", "", ...ciEvidence(report.ci).map((line) => `- ${escapeMarkdown(line)}`));
  }

  if (report.reasons?.length > 0) {
    lines.push("", "### Unsatisfied", "");
    for (const r of report.reasons) lines.push(`- ${r.gate ?? "request"} · ${code(r.code)} (${r.kind}): ${escapeMarkdown(r.detail)}`);
  }

  if (report.approvalTemplate) {
    lines.push(
      "",
      "### The Owner's approval",
      "",
      "Every other gate is satisfied. If the Owner approves, the Owner posts this block personally on the preparation pull request, then dispatches with its reference.",
      "",
      "````markdown",
      report.approvalTemplate.trimEnd(),
      "````",
    );
  }

  if (report.notes && (report.decision === "published" || report.decision === "already_published" || report.decision === "eligible" || report.decision === "publication_disabled")) {
    lines.push("", "### Final release notes", "", report.notes.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}
