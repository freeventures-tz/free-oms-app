// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runController, runControllerJson } from "./support/run-controller";

/**
 * The pre-merge half of classification, through the command the PR workflow runs. The title and
 * body travel as environment variables, exactly as the workflow hands them over.
 */
const check = (title: string, body = "", options: { cwd?: string; env?: Record<string, string> } = {}) =>
  runControllerJson(["check-pr-title", "--title-env", "PR_TITLE", "--body-env", "PR_BODY"], {
    cwd: options.cwd,
    env: { PR_TITLE: title, PR_BODY: body, ...options.env },
  });

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("check-pr-title", { timeout: 60_000 }, () => {
  it("classifies a compatible fix as a patch", async () => {
    const { code, json } = await check("fix(settlement): keep the paid figure after a reload");

    expect(code).toBe(0);
    expect(json).toMatchObject({
      command: "check-pr-title",
      status: "valid",
      classification: {
        type: "fix",
        scope: "settlement",
        breaking: false,
        change: "patch",
      },
      reasons: [],
    });
  });

  it.each([
    ["fix", "patch"],
    ["perf", "patch"],
    ["test", "patch"],
    ["docs", "patch"],
    ["chore", "patch"],
    ["ci", "patch"],
    ["build", "patch"],
    ["refactor", "patch"],
    ["style", "patch"],
    ["feat", "minor"],
  ])("classifies every declared type: %s is a %s", async (type, change) => {
    const { code, json } = await check(`${type}: a change of this kind`);

    expect(code).toBe(0);
    expect(json.classification).toMatchObject({ type, scope: null, breaking: false, change });
  });

  it("classifies a breaking change only when both markers are present, and keeps the explanation", async () => {
    const body = [
      "Quotations no longer take a discount.",
      "",
      "BREAKING CHANGE: api.staff_create_quotation no longer accepts p_discount;",
      "apply the discount on the order instead.",
    ].join("\n");

    const { code, json } = await check("feat(orders)!: move the quotation discount to the order", body);

    expect(code).toBe(0);
    expect(json.classification).toMatchObject({
      type: "feat",
      scope: "orders",
      breaking: true,
      change: "breaking",
      breakingExplanation:
        "api.staff_create_quotation no longer accepts p_discount; apply the discount on the order instead.",
    });
    // The repository keeps only the PR title in a merge body by default, so the command says which
    // lines have to be carried into it.
    expect(json.footersToRetain).toEqual([
      "BREAKING CHANGE: api.staff_create_quotation no longer accepts p_discount;",
      "apply the discount on the order instead.",
    ]);
  });

  it("keeps every paragraph of a breaking explanation, in the explanation and in the lines to retain", async () => {
    const title = "feat(api)!: remove the legacy field";
    const body = "BREAKING CHANGE: The legacy field is removed.\n\nMigrate saved records before upgrading.";

    const { code, json } = await check(title, body);
    expect(code).toBe(0);
    expect(json.classification).toMatchObject({
      change: "breaking",
      breakingExplanation: "The legacy field is removed.\n\nMigrate saved records before upgrading.",
    });
    expect(json.footersToRetain).toEqual([
      "BREAKING CHANGE: The legacy field is removed.",
      "",
      "Migrate saved records before upgrading.",
    ]);

    const markdown = await runController(["check-pr-title", "--title-env", "PR_TITLE", "--body-env", "PR_BODY"], {
      env: { PR_TITLE: title, PR_BODY: body },
    });
    expect(markdown.code).toBe(0);
    const copyBlock = markdown.stdout.slice(markdown.stdout.indexOf("Copy these lines"));
    expect(copyBlock).toContain(
      "    BREAKING CHANGE: The legacy field is removed.\n\n    Migrate saved records before upgrading.",
    );
  });

  it("ends a footer's explanation at the next footer, whichever separator it uses, not at a blank line", async () => {
    const body = [
      "BREAKING CHANGE: The legacy field is removed.",
      "",
      "Migrate saved records before upgrading.",
      "Refs #7",
      "",
      "DEPRECATED: the legacy export; use the ledger export.",
      "",
      "Remove calls to it before 0.3.0.",
      "Acked-by: Owner",
      "",
    ].join("\n");

    const { code, json } = await check("feat(api)!: remove the legacy field", body);
    expect(code).toBe(0);
    expect(json.classification).toMatchObject({
      breakingExplanation: "The legacy field is removed.\n\nMigrate saved records before upgrading.",
      deprecation: "the legacy export; use the ledger export.\n\nRemove calls to it before 0.3.0.",
    });
    expect(json.footersToRetain).toEqual([
      "BREAKING CHANGE: The legacy field is removed.",
      "",
      "Migrate saved records before upgrading.",
      "DEPRECATED: the legacy export; use the ledger export.",
      "",
      "Remove calls to it before 0.3.0.",
    ]);
  });

  it("treats a breaking fix as breaking, not as a patch", async () => {
    const { json } = await check("fix!: refuse a negative quantity", "BREAKING CHANGE: zero is now refused too");
    expect(json.classification).toMatchObject({ type: "fix", breaking: true, change: "breaking" });
  });

  it("classifies a deprecation as minor", async () => {
    const { code, json } = await check(
      "feat(catalogue): deprecate the per-unit price field",
      "DEPRECATED: the per-unit price field; read the counting-unit price instead",
    );

    expect(code).toBe(0);
    expect(json.classification).toMatchObject({
      change: "minor",
      deprecation: "the per-unit price field; read the counting-unit price instead",
    });
  });

  it("accepts a revert that names its commit and classifies it by the contract it leaves", async () => {
    const { code, json } = await check("fix(receipts): restore the previous receipt layout", `Reverts: ${SHA}`);

    expect(code).toBe(0);
    expect(json.classification).toMatchObject({ type: "fix", change: "patch", reverts: [SHA] });
    expect(json.footersToRetain).toEqual([`Reverts: ${SHA}`]);
  });

  it("reads ordinary description prose that happens to start with a word like Version as prose, not as an override", async () => {
    const { code, json } = await check(
      "chore(release): record the preview",
      "Version: 0.0.6 is unchanged by this pull request.\nBump: none.",
    );
    expect(code).toBe(0);
    expect(json.status).toBe("valid");
  });

  it.each([
    ["an ordinary sentence", "Fix the thing", "", ["malformed_title"]],
    ["an empty title", "", "", ["malformed_title"]],
    ["leading whitespace", " fix: a change", "", ["malformed_title"]],
    ["an empty description", "fix: ", "", ["malformed_title"]],
    ["no space after the colon", "fix:a change", "", ["malformed_title"]],
    ["an uppercase scope", "fix(Settlement): a change", "", ["malformed_title"]],
    ["an undeclared type", "feature: a change", "", ["unknown_type"]],
    ["a capitalised type", "Feat: a change", "", ["unknown_type"]],
    ["the revert type", "revert: feat: add the receipt layout", "", ["ambiguous_revert"]],
    ["GitHub's revert title", 'Revert "feat: add the receipt layout"', "", ["ambiguous_revert"]],
    ["a revert with no Reverts footer", "fix: revert the receipt layout", "", ["ambiguous_revert"]],
    ["a revert naming an abbreviated sha", "fix: restore the layout", "Reverts: abc1234", ["ambiguous_revert"]],
    [
      "GitHub's revert body",
      "fix: restore the layout",
      "Reverts freeventures-tz/free-oms-app#12",
      ["ambiguous_revert"],
    ],
    ["a `!` with no explanation", "feat!: drop the legacy call", "", ["breaking_missing_explanation"]],
    [
      "an empty breaking footer",
      "feat!: drop the legacy call",
      "BREAKING CHANGE:",
      ["breaking_missing_explanation"],
    ],
    [
      "a breaking footer with no `!`",
      "feat: drop the legacy call",
      "BREAKING CHANGE: the call is gone",
      ["breaking_missing_title_marker"],
    ],
    [
      "a lowercase breaking footer",
      "feat!: drop the legacy call",
      "breaking change: the call is gone",
      ["malformed_breaking_footer"],
    ],
    [
      "a bulleted breaking footer",
      "feat!: drop the legacy call",
      "* BREAKING CHANGE: the call is gone",
      ["malformed_breaking_footer"],
    ],
    [
      "a deprecation declared as a patch",
      "chore: retire the unit field",
      "DEPRECATED: the unit field",
      ["deprecation_requires_minor"],
    ],
    [
      "a misspelt deprecation footer",
      "feat: retire the unit field",
      "Deprecation: the unit field",
      ["malformed_deprecation_footer"],
    ],
    ["a Reverts footer using the # separator", "fix: restore the layout", "Reverts #12", ["ambiguous_revert"]],
    [
      "a DEPRECATED footer using the # separator",
      "feat: retire the unit field",
      "DEPRECATED #12",
      ["malformed_deprecation_footer"],
    ],
    ["a version override footer", "fix: a change", "Release-As: 1.0.0", ["unsupported_override"]],
    ["a semver override footer", "fix: a change", "Semver-Bump: minor", ["unsupported_override"]],
    ["a bump token in the title", "fix: a change [minor]", "", ["unsupported_override"]],
  ])("refuses %s", async (_label, title, body, codes) => {
    const { code, json } = await check(title, body);

    expect(code).toBe(4);
    expect(json.status).toBe("refused");
    expect(json.classification).toBeNull();
    expect((json.reasons as Array<{ code: string }>).map((r) => r.code)).toEqual(codes);
  });

  it("names the refusal in the default Markdown report", async () => {
    const run = await runController(["check-pr-title", "--title-env", "PR_TITLE"], {
      env: { PR_TITLE: "feat!: drop the legacy call" },
    });

    expect(run.code).toBe(4);
    expect(run.stdout).toContain("## Release classification: refused");
    expect(run.stdout).toContain("`breaking_missing_explanation`");
  });

  it("keeps hostile title and body text as data: nothing runs and no credential is read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "release-injection-"));
    try {
      const title =
        "fix: $(node -e \"require('fs').writeFileSync('pwned-subshell','x')\") `touch pwned-backtick` ${{ secrets.GITHUB_TOKEN }}";
      const body = "'; node -e \"require('fs').writeFileSync('pwned-body','x')\" #\n$GITHUB_TOKEN";

      const { code, json, stdout, stderr } = await check(title, body, {
        cwd,
        env: { GITHUB_TOKEN: "sentinel-token-7f3a", GITHUB_API_URL: "http://127.0.0.1:9" },
      });

      expect(code).toBe(0);
      expect(json.title).toBe(title);
      expect(readdirSync(cwd)).toEqual([]);
      expect(`${stdout}${stderr}`).not.toContain("sentinel-token-7f3a");

      const markdown = await runController(["check-pr-title", "--title-env", "PR_TITLE"], {
        cwd,
        env: { PR_TITLE: title },
      });
      // Rendered, the backticks cannot open code spans or the brackets a link.
      expect(markdown.stdout).toContain("\\`touch pwned-backtick\\`");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is a usage error without a title", async () => {
    const run = await runController(["check-pr-title"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--title or --title-env is required");
  });
});
