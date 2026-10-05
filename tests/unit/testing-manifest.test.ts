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

  it("keeps selective enforcement off until the Owner activates it", () => {
    expect(manifest.activation.selectiveEnforcement).toBe(false);
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
