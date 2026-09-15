// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  COMMIT,
  occurrences,
  PULL,
  REPOSITORY,
  TOKEN,
  usePreviewFixture,
  type PreviewMerge,
} from "./support/preview-harness";

/**
 * The version and the notes a preview calculates, through the public command, against disposable
 * Git history and a simulated GitHub. Every expected version is a literal worked out from the policy
 * table in issue #36, not recomputed the way the controller computes it.
 */
describe("preview: versions and notes", { timeout: 180_000 }, () => {
  const { state, preview, previewMarkdown } = usePreviewFixture();

  it("calculates 0.0.7 from 0.0.6 for the two test merges and the proposed CI change, listing every merge", async () => {
    const { repo, github } = state;
    const released = repo.mergePullRequest({
      number: 30,
      title: "fix(stock): a batch may not consume what a customer has been promised",
    });
    repo.tag("v0.0.6", released.mergeSha);
    const pr32 = repo.mergePullRequest({
      number: 32,
      title: "test(settlement): prove the walk-in sale landed before reloading on it",
      commits: [
        "test(settlement): prove the walk-in sale landed before reloading on it",
        "test(settlement): take the sample timings out of the comments",
      ],
    });
    const pr33 = repo.mergePullRequest({
      number: 33,
      title: "test: set the yard as well as the ledger, and wait for the inspection",
      retainedBody:
        "test: set the yard as well as the ledger, and wait for the inspection\n\nTwo test-only corrections.",
    });
    const refsBefore = repo.refs();

    const { code, json } = await preview([
      "--sha",
      pr33.mergeSha,
      "--proposed-title",
      "ci(release): preview versions and release notes from accepted merges",
    ]);

    expect(code).toBe(0);
    expect(json).toMatchObject({
      command: "preview",
      status: "calculated",
      publication: "none",
      repository: REPOSITORY,
      sha: pr33.mergeSha,
      base: { tag: "v0.0.6", commit: released.mergeSha, version: "0.0.6" },
      policy: "0.x",
      highestChange: "patch",
      version: "0.0.7",
      versionIncludingProposed: "0.0.7",
      reasons: [],
    });
    expect(json.merges).toEqual([
      {
        pr: 32,
        url: PULL(32),
        mergeSha: pr32.mergeSha,
        mergeUrl: COMMIT(pr32.mergeSha),
        headSha: pr32.headSha,
        title: "test(settlement): prove the walk-in sale landed before reloading on it",
        type: "test",
        scope: "settlement",
        change: "patch",
        breaking: false,
        breakingExplanation: null,
        deprecation: null,
        reverts: [],
        developmentCommits: [
          {
            sha: pr32.developmentCommits[0],
            subject: "test(settlement): prove the walk-in sale landed before reloading on it",
            url: COMMIT(pr32.developmentCommits[0]),
          },
          {
            sha: pr32.developmentCommits[1],
            subject: "test(settlement): take the sample timings out of the comments",
            url: COMMIT(pr32.developmentCommits[1]),
          },
        ],
      },
      {
        pr: 33,
        url: PULL(33),
        mergeSha: pr33.mergeSha,
        mergeUrl: COMMIT(pr33.mergeSha),
        headSha: pr33.headSha,
        title: "test: set the yard as well as the ledger, and wait for the inspection",
        type: "test",
        scope: null,
        change: "patch",
        breaking: false,
        breakingExplanation: null,
        deprecation: null,
        reverts: [],
        developmentCommits: [
          {
            sha: pr33.developmentCommits[0],
            subject: "test: set the yard as well as the ledger, and wait for the inspection",
            url: COMMIT(pr33.developmentCommits[0]),
          },
        ],
      },
    ]);
    expect(json.proposed).toEqual([
      {
        title: "ci(release): preview versions and release notes from accepted merges",
        type: "ci",
        scope: "release",
        change: "patch",
        breaking: false,
      },
    ]);

    const notes = json.notes as string;
    expect(notes).toContain("## 0.0.7 — release notes preview");
    expect(occurrences(notes, `[#32](${PULL(32)})`)).toBe(1);
    expect(occurrences(notes, `[#33](${PULL(33)})`)).toBe(1);
    expect(notes).toContain(pr32.mergeSha);
    expect(notes).toContain(pr33.mergeSha);
    expect(notes).toContain(COMMIT(pr32.developmentCommits[1]));
    expect(notes).toContain("Proposed, not accepted");
    // The merge before the tag belongs to v0.0.6, not to this release.
    expect(notes).not.toContain(PULL(30));

    // Read-only, provably: every request was a GET with the read token, and no ref moved.
    expect(github.requests.length).toBeGreaterThan(0);
    expect(github.writes()).toEqual([]);
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(repo.refs()).toBe(refsBefore);

    // Without --format json the command prints the notes themselves.
    const markdown = await previewMarkdown(["--sha", pr33.mergeSha]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout.startsWith("## 0.0.7 — release notes preview")).toBe(true);
  });

  it("classifies a range of every patch type as a patch, lists each merge once, and lets a later feature win", async () => {
    const { repo } = state;
    repo.tag("v0.4.2", repo.root);
    const types = ["fix", "perf", "test", "docs", "chore", "ci", "build", "refactor", "style"];
    const merges = types.map((type, index) =>
      repo.mergePullRequest({ number: 100 + index, title: `${type}: a ${type} change` }),
    );

    const patchOnly = await preview(["--sha", merges[merges.length - 1].mergeSha]);
    expect(patchOnly.code).toBe(0);
    expect(patchOnly.json).toMatchObject({ version: "0.4.3", highestChange: "patch" });
    expect((patchOnly.json.merges as PreviewMerge[]).map((m) => m.pr)).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107, 108,
    ]);
    for (let n = 100; n <= 108; n += 1) {
      expect(occurrences(patchOnly.json.notes as string, `[#${n}](${PULL(n)})`)).toBe(1);
    }

    const feature = repo.mergePullRequest({ number: 109, title: "feat(orders): let a quotation carry a note" });
    const mixed = await preview(["--sha", feature.mergeSha]);
    // Highest wins, and the patch component resets.
    expect(mixed.json).toMatchObject({ version: "0.5.0", highestChange: "minor" });
    expect((mixed.json.merges as PreviewMerge[]).map((m) => m.pr)).toHaveLength(10);
  });

  it("raises only the minor version for a breaking change during 0.x, lists it, and reaches 1.0.0 only by explicit acceptance", async () => {
    const { repo } = state;
    repo.tag("v0.9.3", repo.root);
    repo.mergePullRequest({ number: 110, title: "fix: keep the receipt number on a reprint" });
    const breaking = repo.mergePullRequest({
      number: 111,
      title: "feat(api)!: remove the legacy quotation discount",
      retainedBody:
        "feat(api)!: remove the legacy quotation discount\n\nBREAKING CHANGE: api.staff_create_quotation no longer accepts p_discount",
    });

    const without = await preview(["--sha", breaking.mergeSha]);
    expect(without.code).toBe(0);
    expect(without.json).toMatchObject({
      policy: "0.x",
      highestChange: "breaking",
      version: "0.10.0",
      stableContractAcceptance: null,
    });
    const notes = without.json.notes as string;
    const breakingSection = notes.slice(notes.indexOf("### Breaking changes"), notes.indexOf("### Deprecations"));
    expect(breakingSection).toContain("api.staff\\_create\\_quotation no longer accepts p\\_discount");
    expect(breakingSection).toContain(`[#111](${PULL(111)})`);

    const reference = "https://github.com/freeventures-tz/free-oms-app/issues/99#issuecomment-1";
    const accepted = await preview(["--sha", breaking.mergeSha, "--accept-stable-contract", reference]);
    expect(accepted.code).toBe(0);
    expect(accepted.json).toMatchObject({
      version: "1.0.0",
      stableContractAcceptance: { reference, validated: false },
    });
    expect(accepted.json.notes).toContain("recorded here, not validated");
  });

  it("carries multi-paragraph breaking and deprecation explanations from the retained merge body into the notes", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    const title = "feat(api)!: remove the legacy field";
    const body = [
      "BREAKING CHANGE: The legacy field is removed.",
      "",
      "Migrate saved records before upgrading.",
      "Refs #7",
      "",
      "DEPRECATED: the legacy export.",
      "",
      "Remove calls to it before 0.3.0.",
    ].join("\n");
    const merge = repo.mergePullRequest({ number: 101, title, retainedBody: `${title}\n\n${body}` });

    const { code, json } = await preview(["--sha", merge.mergeSha]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ version: "0.1.0", highestChange: "breaking" });
    expect((json.merges as PreviewMerge[])[0]).toMatchObject({
      breakingExplanation: "The legacy field is removed.\n\nMigrate saved records before upgrading.",
      deprecation: "the legacy export.\n\nRemove calls to it before 0.3.0.",
    });

    const notes = json.notes as string;
    const breaking = notes.slice(notes.indexOf("### Breaking changes"), notes.indexOf("### Deprecations"));
    expect(breaking).toContain("The legacy field is removed.");
    expect(breaking).toContain("Migrate saved records before upgrading.");
    expect(breaking).not.toContain("Refs");
    const deprecations = notes.slice(notes.indexOf("### Deprecations"), notes.indexOf("### Accepted merges"));
    expect(deprecations).toContain("the legacy export.");
    expect(deprecations).toContain("Remove calls to it before 0.3.0.");

    // The default Markdown output is those same notes.
    const markdown = await previewMarkdown(["--sha", merge.mergeSha]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toBe(notes);
  });

  it("shows proposed titles and their target in both formats when nothing has merged since the normal release", async () => {
    const { repo } = state;
    const released = repo.mergePullRequest({ number: 101, title: "feat(receipts): print a receipt" });
    repo.tag("v0.1.0", released.mergeSha);
    const extra = [
      "--sha",
      released.mergeSha,
      "--proposed-title",
      "feat: add receipt exports",
      "--proposed-title",
      "fix: round receipt totals",
    ];

    const { code, json } = await preview(extra);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      status: "no_accepted_changes",
      version: null,
      merges: [],
      notes: null,
      versionIncludingProposed: "0.2.0",
    });
    const proposed = json.proposed as Array<{ title: string; type: string; change: string }>;
    expect(proposed.map((p) => [p.title, p.change])).toEqual([
      ["feat: add receipt exports", "minor"],
      ["fix: round receipt totals", "patch"],
    ]);

    const markdown = await previewMarkdown(extra);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout).toContain("## Release preview: nothing to release");
    expect(markdown.stdout).toContain("### Proposed, not accepted (2)");
    for (const p of proposed) {
      expect(markdown.stdout).toContain(`- **${p.title}** — \`${p.type}\` → ${p.change}`);
    }
    expect(markdown.stdout).toContain(`**${json.versionIncludingProposed}**`);

    // Without proposals, nothing to release stays exactly that.
    const plain = await previewMarkdown(["--sha", released.mergeSha]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("## Release preview: nothing to release");
    expect(plain.stdout).not.toContain("Proposed");
  });

  it("maps patch, minor and breaking to PATCH, MINOR and MAJOR at or above 1.0.0, resetting lower components", async () => {
    const { repo } = state;
    repo.tag("v1.4.2", repo.root);

    // Asking for stability at 1.x is refused even when there is nothing new to release.
    const nothingNew = await preview(["--sha", repo.root, "--accept-stable-contract", "a reference"]);
    expect(nothingNew.code).toBe(4);
    expect(nothingNew.json.reasons).toMatchObject([{ code: "stability_acceptance_not_applicable" }]);

    const fix = repo.mergePullRequest({ number: 120, title: "fix: round a settlement once" });
    expect((await preview(["--sha", fix.mergeSha])).json).toMatchObject({ policy: "stable", version: "1.4.3" });

    const feature = repo.mergePullRequest({ number: 121, title: "feat: print a dispatch note twice" });
    expect((await preview(["--sha", feature.mergeSha])).json).toMatchObject({ version: "1.5.0" });

    const breaking = repo.mergePullRequest({
      number: 122,
      title: "refactor(api)!: rename the dispatch command",
      retainedBody:
        "refactor(api)!: rename the dispatch command\n\nBREAKING CHANGE: api.staff_sign_dispatch is now api.staff_confirm_dispatch",
    });
    expect((await preview(["--sha", breaking.mergeSha])).json).toMatchObject({
      highestChange: "breaking",
      version: "2.0.0",
    });

    // Stability is accepted once. Asking again at 1.x is refused, not ignored.
    const again = await preview(["--sha", breaking.mergeSha, "--accept-stable-contract", "a reference"]);
    expect(again.code).toBe(4);
    expect(again.json).toMatchObject({ status: "refused", version: null, notes: null });
    expect(again.json.reasons).toMatchObject([{ code: "stability_acceptance_not_applicable" }]);
  });

  it("calculates a deprecation as minor and lists it with its explanation", async () => {
    const { repo } = state;
    repo.tag("v1.4.2", repo.root);
    const deprecation = repo.mergePullRequest({
      number: 123,
      title: "feat(catalogue): deprecate the per-unit price field",
      retainedBody:
        "feat(catalogue): deprecate the per-unit price field\n\nDEPRECATED: the per-unit price field; read the counting-unit price",
    });

    const { code, json } = await preview(["--sha", deprecation.mergeSha]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ version: "1.5.0", highestChange: "minor" });
    const notes = json.notes as string;
    expect(notes.slice(notes.indexOf("### Deprecations"), notes.indexOf("### Accepted merges"))).toContain(
      "the per-unit price field; read the counting-unit price",
    );
  });

  it("raises the 0.0.6 target to 0.1.0 when a feature merges, without changing what an earlier merge calculates", async () => {
    const { repo } = state;
    const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
    repo.tag("v0.0.6", released.mergeSha);
    repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
    const pr33 = repo.mergePullRequest({ number: 33, title: "test: set the yard as well as the ledger" });
    const feature = repo.mergePullRequest({ number: 34, title: "feat(invoices): show the settled amount" });

    expect((await preview(["--sha", feature.mergeSha])).json).toMatchObject({ version: "0.1.0" });
    // Calculated per exact merge, never reserved: the earlier merge still calculates 0.0.7.
    expect((await preview(["--sha", pr33.mergeSha])).json).toMatchObject({ version: "0.0.7" });
  });

  it("calculates a patch after an intervening normal release from that release, while an older merge keeps its own", async () => {
    const { repo } = state;
    const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
    repo.tag("v0.0.6", released.mergeSha);
    const pr32 = repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
    const pr33 = repo.mergePullRequest({ number: 33, title: "test: set the yard as well as the ledger" });
    repo.tag("v0.0.7", pr33.mergeSha);
    const pr35 = repo.mergePullRequest({ number: 35, title: "fix(invoices): show the settled amount" });

    const later = await preview(["--sha", pr35.mergeSha]);
    expect(later.json).toMatchObject({ base: { tag: "v0.0.7", commit: pr33.mergeSha }, version: "0.0.8" });
    expect((later.json.merges as PreviewMerge[]).map((m) => m.pr)).toEqual([35]);

    const older = await preview(["--sha", pr32.mergeSha]);
    expect(older.json).toMatchObject({ base: { tag: "v0.0.6" }, version: "0.0.7" });
    expect((older.json.merges as PreviewMerge[]).map((m) => m.pr)).toEqual([32]);

    const release = await preview(["--sha", pr33.mergeSha]);
    expect(release.code).toBe(0);
    expect(release.json).toMatchObject({ status: "no_accepted_changes", version: null, notes: null });
  });

  it("includes release-preparation merges in the notes like any other accepted merge", async () => {
    const { repo } = state;
    repo.tag("v0.0.6", repo.root);
    repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
    const preparation = repo.mergePullRequest({ number: 40, title: "chore(release): prepare 0.0.7" });

    const { json } = await preview(["--sha", preparation.mergeSha]);
    expect(json).toMatchObject({ version: "0.0.7" });
    expect((json.merges as PreviewMerge[]).map((m) => m.pr)).toEqual([32, 40]);
    expect(occurrences(json.notes as string, `[#40](${PULL(40)})`)).toBe(1);
    expect(json.notes).toContain("chore(release): prepare 0.0.7");
  });
});
