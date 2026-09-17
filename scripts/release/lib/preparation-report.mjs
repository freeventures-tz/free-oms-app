/** The Markdown `prepare-release` prints. The JSON report carries the same facts. */

import { escapeMarkdown } from "./markdown.mjs";
import { describePackageVersion } from "./notes.mjs";

const HEADINGS = Object.freeze({
  prepared: "prepared",
  would_prepare: "dry run",
  already_prepared: "already prepared",
  nothing_to_prepare: "nothing to prepare",
  pending_decision: "pending an Owner decision",
  refused: "refused",
});

const short = (sha) => sha.slice(0, 7);

/** A fence longer than any run of backticks in the text, so the text cannot end it. */
function fenced(text, info) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, text.replace(/\n+$/, ""), fence];
}

function describeFields(fields) {
  if (!fields) return "—";
  return Object.entries(fields)
    .map(([name, value]) => `${name === "rootVersion" ? "root package" : "version"} ${value === null ? "none" : `\`${escapeMarkdown(value)}\``}`)
    .join(", ");
}

function outcome(report, file) {
  if (file.written) return "written";
  if (!file.changed) return "already so";
  return report.mode === "dry_run" ? "would be written" : "not written";
}

export function renderPreparationReport(report) {
  const lines = [`## Release preparation: ${HEADINGS[report.status]}`, ""];
  const wrote = report.files.some((file) => file.written);
  lines.push(
    `Candidate \`${report.sha}\`. ${
      wrote ? `Only the working tree of \`${escapeMarkdown(report.branch)}\` changed.` : "No file was written."
    } Nothing was committed, pushed, tagged or published.`,
    "",
  );

  const base = report.lastNormalRelease;
  if (base) {
    lines.push(
      "| | |",
      "| --- | --- |",
      `| Last normal release | \`${base.version}\`, tag \`${base.tag}\` (object \`${short(base.tagObject)}\`) at \`${short(base.commit)}\` |`,
    );
    if (report.candidateMetadata) {
      lines.push(`| Package version at the candidate | ${describePackageVersion(report.candidateMetadata, base)} |`);
    }
    if (report.version) {
      lines.push(
        `| Calculated version | **${report.version}**, from \`${base.tag}\` · policy ${report.policy} · highest change ${report.highestChange} |`,
      );
    }
    if (report.preparation) {
      const link = report.preparation.pr === null ? "not named yet" : `[#${report.preparation.pr}](${report.preparation.url})`;
      lines.push(
        `| Preparation pull request | ${link} · \`${escapeMarkdown(report.preparation.title)}\` |`,
        `| Release date | ${report.preparation.date} |`,
      );
    }
    lines.push("");
  }

  if (report.files.length > 0) {
    lines.push("### Release metadata", "", "| File | Before | After | |", "| --- | --- | --- | --- |");
    for (const file of report.files) {
      lines.push(`| ${file.path} | ${describeFields(file.before)} | ${describeFields(file.after)} | ${outcome(report, file)} |`);
    }
    lines.push("");
  }

  if (report.reasons.length > 0) {
    for (const r of report.reasons) {
      const where = [r.commit ? `commit \`${r.commit}\`` : null, r.pr ? `PR #${r.pr}` : null].filter(Boolean).join(", ");
      lines.push(`- \`${r.code}\` (${r.kind.replace("_", " ")})${where ? ` at ${where}` : ""}: ${escapeMarkdown(r.detail)}`);
    }
    lines.push("");
  }

  if (report.changelogSection) {
    lines.push("### Changelog section", "", ...fenced(report.changelogSection, "markdown"), "");
  }
  if (report.final) {
    lines.push(
      "### Final release notes",
      "",
      `Every accepted merge through \`${report.final.sha}\`, this preparation's own merge included. Notes digest \`${report.final.notesDigest}\`.`,
      "",
      report.final.notes,
    );
  } else if (report.notes) {
    lines.push("### Release notes", "", report.notes);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
