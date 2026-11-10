import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverInventory, gitRunner, matchesAny, repositoryFiles } from "@/scripts/testing/common.mjs";
import { buildGraph, importSpecifiers } from "@/scripts/testing/graph.mjs";
import { validateManifest } from "@/scripts/testing/select.mjs";

/**
 * The reviewed manifest against the repository as it really is.
 *
 * A manifest that has drifted from the code still "works": it just selects too little. These checks
 * make that drift a failing test instead: every committed file is either a test the suites find, a
 * path that forces full coverage, documentation, or a source a reviewed domain owns; every test the
 * suites find has a reviewed grouping; and the floors the gate enforces match what is on disk.
 */

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "scripts/testing/manifest.json"), "utf8"));
const files: string[] = repositoryFiles(gitRunner(root));
const inventory = discoverInventory(root, manifest, files);

describe("the reviewed test manifest", () => {
  it("names every committed file: a test, a full-coverage path, documentation or a domain source", () => {
    const unmapped = files.filter((file) => {
      if (Object.values(manifest.suites as Record<string, string[]>).some((globs) => matchesAny(file, globs))) return false;
      if (manifest.forceFull.some((rule: { pattern: string }) => matchesAny(file, [rule.pattern]))) return false;
      if (manifest.appWide.some((rule: { pattern: string }) => matchesAny(file, [rule.pattern]))) return false;
      if (matchesAny(file, manifest.docsOnly)) return false;
      return !Object.values(manifest.domains as Record<string, { sources: string[] }>).some((domain) => matchesAny(file, domain.sources));
    });
    // An unmapped file is not unsafe (it forces full coverage), but it means the map is out of date.
    expect(unmapped).toEqual([]);
  });

  it("matches the tests on disk, with no stale or missing entries", () => {
    expect(validateManifest(manifest, inventory)).toEqual([]);
  });

  it("keeps the shared-fund ordering files together in one group", () => {
    // vitest.config.mts runs funding first and not-counted and retirement last; selecting any one of
    // them without the others would break the order the suite depends on.
    const fund = manifest.groups.integration["imprest-fund"].files;
    for (const file of ["imprest-funding", "imprest-not-counted", "imprest-retirement", "imprest-lost-response"]) {
      expect(fund).toContain(`tests/integration/${file}.test.ts`);
    }
  });

  it("holds the floors the gate enforces", () => {
    const migrations = readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
    expect(migrations).toHaveLength(manifest.minimums.migrations);
    expect(migrations).toContain("20261006000100_report_imprest_section.sql");
    expect(inventory.pgtap).toHaveLength(manifest.minimums.pgtapFiles);
    expect(manifest.minimums.migrationChainCounterexamples).toBe(155);
    expect(manifest.minimums.responsiveProjects).toEqual(["mobile", "tablet", "desktop"]);
  });

  it("lists every benchmark, so a Release Gate cannot skip one nobody runs", () => {
    // A file that reads FV_BENCHMARK holds an opt-in benchmark; each must have an isolated pass.
    const readsFlag = files.filter(
      (file) => (matchesAny(file, manifest.suites.e2e) || matchesAny(file, manifest.suites.integration)) && readFileSync(join(root, file), "utf8").includes("FV_BENCHMARK"),
    );
    const listed = [...manifest.benchmarks.e2e, ...manifest.benchmarks.integration].map((entry: { file: string }) => entry.file);
    expect([...listed].sort()).toEqual(readsFlag.sort());
    for (const entry of manifest.benchmarks.e2e) {
      // The grep must match the benchmark block's title in that file.
      expect(readFileSync(join(root, entry.file), "utf8"), entry.file).toContain(entry.grep);
    }
  });

  it("has selective enforcement on: a pull request runs its lane", () => {
    expect(manifest.activation.selectiveEnforcement).toBe(true);
  });

  it("never lets a lane leave out a suite for the database, dependencies, CI or the tests' own infrastructure", () => {
    // The gate holds this line itself (NEVER_PARTIAL); the manifest must send the same paths to
    // full coverage, or a pull request would be planned onto a lane the gate then refuses.
    const full = (path: string) => manifest.forceFull.some((rule: { pattern: string }) => matchesAny(path, [rule.pattern]));
    for (const path of [
      "supabase/migrations/20261006000100_report_imprest_section.sql",
      "supabase/config.toml",
      "scripts/testing/select.mjs",
      "scripts/migration-chain-check.mjs",
      ".github/workflows/ci.yml",
      "package.json",
      "package-lock.json",
      "playwright.config.ts",
      "vitest.config.mts",
      "tests/setup/integration.ts",
      "tests/support/database.ts",
      "e2e/fixtures.ts",
      "e2e/global-setup.ts",
    ]) {
      expect(full(path), path).toBe(true);
    }
  });

  it("sends authentication, permissions, and money and stock commands to every suite", () => {
    const full = (path: string) => manifest.forceFull.some((rule: { pattern: string }) => matchesAny(path, [rule.pattern]));
    for (const path of [
      "lib/auth/guard.ts",
      "lib/supabase/server.ts",
      "lib/admin/accounts.ts",
      "lib/imprest/disbursements.ts",
      "lib/inventory/inventory.ts",
      "lib/sales/sales.ts",
      "lib/settlement/settlement.ts",
      "lib/money.ts",
      "app/(app)/inventory/actions.ts",
      "app/(app)/admin/accounts/page.tsx",
      "app/(app)/layout.tsx",
      "app/sign-in/page.tsx",
      "proxy.ts",
      "next.config.ts",
    ]) {
      expect(full(path), path).toBe(true);
    }
  });

  it("keeps the one spec that needs an open fund with the spec that opens it, and that spec sorts first", () => {
    // Measured on 10 November 2026: every E2E spec passed alone, after its own reset, on all three
    // projects, except imprest-funding, whose first tests read a fund that already exists.
    const groups = Object.values(manifest.groups.e2e as Record<string, { files: string[] }>);
    const withFunding = groups.filter((group) => group.files.includes("e2e/imprest-funding.spec.ts"));
    expect(withFunding).toHaveLength(1);
    const files = [...withFunding[0].files].sort();
    expect(files.indexOf("e2e/imprest-daily-count.spec.ts")).toBeGreaterThan(-1);
    expect(files.indexOf("e2e/imprest-daily-count.spec.ts")).toBeLessThan(files.indexOf("e2e/imprest-funding.spec.ts"));
  });

  it("names, for the imprest screens, every spec that drives them", () => {
    // No group pulls a whole area in any more, so the area's domain has to name its own specs.
    const named = new Set(manifest.domains["imprest-ui"].e2e as string[]);
    for (const file of inventory.e2e.filter((entry: string) => /^e2e\/imprest-/.test(entry))) expect(named.has(file), file).toBe(true);
  });

  it("gives every E2E spec a measured weight for the shards", () => {
    for (const file of inventory.e2e) expect(manifest.e2eMinutes[file], file).toBeGreaterThan(0);
  });

  it("resolves every repository import in the application and its test support", () => {
    const { unresolved } = buildGraph(files, (path: string) => readFileSync(join(root, path), "utf8"));
    // An unresolved specifier would be a dependency the selector cannot see. Test files are left out
    // because the selector's own tests hold imports inside fixture strings; CSS and asset imports are
    // not code.
    const tests = Object.values(manifest.suites as Record<string, string[]>).flat();
    expect(
      unresolved.filter(
        (entry: { from: string; specifier: string }) =>
          !matchesAny(entry.from, tests) && !/\.(css|svg|png|json)$/.test(entry.specifier),
      ),
    ).toEqual([]);
  });

  it("the plan and gate scripts need nothing but Node itself", () => {
    // The plan and gate jobs in CI run without `npm ci`, so neither may import a package.
    const reached = new Set<string>();
    const queue = ["scripts/testing/select.mjs", "scripts/testing/gate.mjs"];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (reached.has(file)) continue;
      reached.add(file);
      for (const specifier of importSpecifiers(readFileSync(join(root, file), "utf8"))) {
        if (specifier.startsWith("./")) queue.push(join("scripts/testing", specifier).replaceAll("\\", "/"));
        else expect(specifier, `${file} imports ${specifier}`).toMatch(/^node:/);
      }
    }
  });
});
