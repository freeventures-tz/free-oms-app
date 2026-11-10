import { describe, expect, it } from "vitest";

import { buildGraph } from "@/scripts/testing/graph.mjs";
import {
  collectIdentity,
  parseNameStatus,
  parsePorcelain,
  revisionFiles,
  selectTests,
  validateManifest,
} from "@/scripts/testing/select.mjs";

/**
 * The selection rules, checked against a small repository written out by hand.
 *
 * Every expectation below is read off the specification's examples and this fixture, not off the
 * selector's code: a changed report query must pull in the tests that import it and the report
 * screens; a money helper forces everything; an unknown path forces everything; a test that shares
 * a fund pulls in the whole fund group; and nothing ever runs fewer than the mandatory smoke tests.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const manifest = {
  version: 1,
  activation: { selectiveEnforcement: false },
  suites: {
    unit: ["tests/unit/**/*.test.ts"],
    integration: ["tests/integration/**/*.test.ts"],
    e2e: ["e2e/**/*.spec.ts"],
    pgtap: ["supabase/tests/database/*.sql"],
  },
  minimums: {},
  forceFull: [
    { pattern: "supabase/**", reason: "database" },
    { pattern: "lib/money.ts", reason: "business money helper" },
    { pattern: "package.json", reason: "dependencies" },
    { pattern: "scripts/**", reason: "selector or test infrastructure" },
  ],
  docsOnly: ["README.md"],
  domains: {
    reports: { risk: "medium", sources: ["app/reports/**", "lib/reports/**"], e2e: ["e2e/reports.spec.ts"] },
    brand: { risk: "low", sources: ["components/brand/**"], e2e: ["e2e/auth.spec.ts"] },
  },
  groups: {
    integration: { fund: { files: ["tests/integration/fund-a.test.ts", "tests/integration/fund-b.test.ts"] } },
    e2e: {},
  },
  independent: {
    integration: ["tests/integration/authority.test.ts", "tests/integration/paging.test.ts"],
    e2e: ["e2e/auth.spec.ts", "e2e/reports.spec.ts", "e2e/shell.spec.ts"],
  },
  smoke: {
    pgtap: ["supabase/tests/database/001_auth.sql"],
    integration: ["tests/integration/authority.test.ts"],
    e2e: ["e2e/shell.spec.ts"],
  },
};

const sources: Record<string, string> = {
  "app/reports/page.tsx": 'import { pageOf } from "@/lib/reports/query";\nexport default pageOf;',
  "lib/reports/query.ts": 'import { formatMoney } from "../money";\nexport const pageOf = formatMoney;',
  "lib/money.ts": "export const formatMoney = (n: number) => String(n);",
  "lib/unknown.ts": "export const x = 1;",
  "components/brand/logo.tsx": "export const Logo = () => null;",
  "README.md": "# app",
  "package.json": "{}",
  "scripts/testing/select.mjs": "",
  "tests/unit/query.test.ts": 'import { pageOf } from "@/lib/reports/query";',
  "tests/unit/logo.test.ts": 'vi.mock("@/components/brand/logo");\nimport { Logo } from "@/components/brand/logo";',
  "tests/unit/money.test.ts": 'import { formatMoney } from "@/lib/money";',
  "tests/integration/authority.test.ts": "",
  "tests/integration/paging.test.ts": 'import { pageOf } from "@/lib/reports/query";',
  "tests/integration/fund-a.test.ts": "",
  "tests/integration/fund-b.test.ts": "",
  "e2e/auth.spec.ts": "",
  "e2e/reports.spec.ts": "",
  "e2e/shell.spec.ts": "",
  "supabase/tests/database/001_auth.sql": "",
  "supabase/tests/database/002_stock.sql": "",
};

const files = Object.keys(sources).sort();
const { edges } = buildGraph(files, (path: string) => sources[path]);
const proven = { base: SHA_A, head: SHA_B, executedCommit: SHA_B, proven: true, problems: [] };

function select(changes: Array<{ status: string; path: string; oldPath?: string }>, overrides: Record<string, unknown> = {}) {
  return selectTests({ manifest, files, edges, changes, identity: proven, ...overrides });
}

describe("test selection", () => {
  it("a changed report query selects what imports it, the report screens and the smoke tests", () => {
    const plan = select([{ status: "M", path: "lib/reports/query.ts" }]);

    expect(plan.risk).toBe("medium");
    expect(plan.fullReasons).toEqual([]);
    expect(plan.selection.unit.files).toEqual(["tests/unit/query.test.ts"]);
    expect(plan.selection.integration.files).toEqual([
      "tests/integration/authority.test.ts",
      "tests/integration/paging.test.ts",
    ]);
    expect(plan.selection.e2e.files).toEqual(["e2e/reports.spec.ts", "e2e/shell.spec.ts"]);
    expect(plan.selection.integration.reasons["tests/integration/paging.test.ts"]).toEqual(["imports lib/reports/query.ts"]);
    expect(plan.selection.integration.reasons["tests/integration/authority.test.ts"]).toEqual(["mandatory smoke"]);
    expect(plan.selection.e2e.excluded).toEqual(["e2e/auth.spec.ts"]);
  });

  it("follows imports through more than one hop", () => {
    // page.tsx imports query.ts, which nothing tests through page.tsx; the e2e comes from the domain.
    const plan = select([{ status: "M", path: "app/reports/page.tsx" }]);
    expect(plan.selection.unit.files).toEqual([]);
    expect(plan.selection.e2e.files).toEqual(["e2e/reports.spec.ts", "e2e/shell.spec.ts"]);
  });

  it("a low-risk brand change stays low and reaches the unit test that mocks the module", () => {
    const plan = select([{ status: "M", path: "components/brand/logo.tsx" }]);
    expect(plan.risk).toBe("low");
    expect(plan.selection.unit.files).toEqual(["tests/unit/logo.test.ts"]);
    expect(plan.selection.e2e.files).toEqual(["e2e/auth.spec.ts", "e2e/shell.spec.ts"]);
  });

  it("a business money helper forces every suite to full, and says why", () => {
    const plan = select([{ status: "M", path: "lib/money.ts" }]);
    expect(plan.risk).toBe("high");
    for (const suite of ["unit", "integration", "e2e", "pgtap"] as const) {
      expect(plan.selection[suite].mode).toBe("full");
      expect(plan.selection[suite].excluded).toEqual([]);
    }
    expect(plan.fullReasons).toEqual(["lib/money.ts: business money helper"]);
  });

  it("a path no rule names forces full coverage", () => {
    const plan = select([{ status: "M", path: "lib/unknown.ts" }]);
    expect(plan.selection.integration.mode).toBe("full");
    expect(plan.fullReasons).toEqual(["lib/unknown.ts is not mapped by any reviewed rule"]);
  });

  it("a change to the selector itself forces full coverage", () => {
    expect(select([{ status: "M", path: "scripts/testing/select.mjs" }]).selection.unit.mode).toBe("full");
  });

  it("a documentation-only change runs only the mandatory smoke tests", () => {
    const plan = select([{ status: "M", path: "README.md" }]);
    expect(plan.risk).toBe("low");
    expect(plan.fullReasons).toEqual([]);
    expect(plan.selection.unit.files).toEqual([]);
    expect(plan.selection.integration.files).toEqual(["tests/integration/authority.test.ts"]);
    expect(plan.selection.e2e.files).toEqual(["e2e/shell.spec.ts"]);
  });

  it("deleting or renaming source forces full coverage and names both paths", () => {
    expect(select([{ status: "D", path: "components/brand/logo.tsx" }]).fullReasons[0]).toMatch(/^deleted components\/brand\/logo\.tsx/);
    const renamed = select([{ status: "R", path: "lib/reports/pages.ts", oldPath: "lib/reports/query.ts" }]);
    expect(renamed.selection.unit.mode).toBe("full");
    expect(renamed.fullReasons[0]).toContain("lib/reports/pages.ts -> lib/reports/query.ts");
  });

  it("deleting a test forces full coverage, because its replacement needs review", () => {
    const plan = select([{ status: "D", path: "tests/unit/money.test.ts" }]);
    expect(plan.selection.unit.mode).toBe("full");
  });

  it("deleting documentation does not", () => {
    expect(select([{ status: "D", path: "README.md" }]).fullReasons).toEqual([]);
  });

  it("an unrecognised change status forces full coverage", () => {
    expect(select([{ status: "X", path: "README.md" }]).fullReasons).toEqual(["unrecognised change status X on README.md"]);
  });

  it("a new unit test always runs", () => {
    const withNew = [...files, "tests/unit/new.test.ts"];
    const plan = selectTests({ manifest, files: withNew, edges, changes: [{ status: "A", path: "tests/unit/new.test.ts" }], identity: proven });
    expect(plan.selection.unit.files).toEqual(["tests/unit/new.test.ts"]);
    expect(plan.selection.unit.reasons["tests/unit/new.test.ts"]).toEqual(["changed or new test"]);
  });

  it("a new integration test in no reviewed group runs the whole integration suite", () => {
    const withNew = [...files, "tests/integration/new.test.ts"];
    const plan = selectTests({ manifest, files: withNew, edges, changes: [{ status: "A", path: "tests/integration/new.test.ts" }], identity: proven });
    expect(plan.selection.integration.mode).toBe("full");
    expect(plan.selection.integration.fullReasons.join(" ")).toContain("tests/integration/new.test.ts is in no reviewed group");
    // The other suites are still selected: the doubt is about integration grouping only.
    expect(plan.selection.unit.mode).toBe("selected");
  });

  it("selecting one member of a shared-state group selects the whole group, and says why", () => {
    const plan = select([{ status: "M", path: "tests/integration/fund-a.test.ts" }]);
    expect(plan.selection.integration.files).toEqual([
      "tests/integration/authority.test.ts",
      "tests/integration/fund-a.test.ts",
      "tests/integration/fund-b.test.ts",
    ]);
    expect(plan.selection.integration.reasons["tests/integration/fund-b.test.ts"]).toEqual([
      "group fund (shares state with tests/integration/fund-a.test.ts)",
    ]);
  });

  it("pgTAP always runs in full", () => {
    const plan = select([{ status: "M", path: "README.md" }]);
    expect(plan.selection.pgtap.mode).toBe("full");
    expect(plan.selection.pgtap.files).toEqual(["supabase/tests/database/001_auth.sql", "supabase/tests/database/002_stock.sql"]);
  });

  it("an identity problem (unknown base, missing ancestry) forces full coverage", () => {
    const plan = select([{ status: "M", path: "README.md" }], {
      identity: { ...proven, proven: false, problems: ["base or head is missing from the clone's history"] },
    });
    expect(plan.selection.e2e.mode).toBe("full");
    expect(plan.fullReasons).toEqual(["base or head is missing from the clone's history"]);
  });

  it("zero changed paths is docs-only only when the identities are proven", () => {
    expect(select([]).fullReasons).toEqual([]);
    const unproven = select([], { identity: { base: null, head: SHA_B, proven: false, problems: [] } });
    expect(unproven.fullReasons).toEqual(["no changed paths, and the base and head identities are not proven"]);
  });

  it("shadow mode reports the selection but requires full execution", () => {
    const plan = select([{ status: "M", path: "components/brand/logo.tsx" }]);
    expect(plan.selection.unit.files).toEqual(["tests/unit/logo.test.ts"]);
    expect(plan.execution.unit.files).toEqual(["tests/unit/logo.test.ts", "tests/unit/money.test.ts", "tests/unit/query.test.ts"]);
    expect(plan.execution.e2e.files).toHaveLength(3);
    expect(plan.execution.projects).toEqual(["mobile", "tablet", "desktop"]);
  });

  it("requires everything in enforce mode while the manifest's switch is off", () => {
    // One edit to the manifest returns every gate to full execution.
    const plan = select([{ status: "M", path: "README.md" }], { mode: "enforce" });
    expect(plan.executionPolicy).toBe("full execution; selective enforcement is switched off in the manifest");
    expect(plan.execution.pgtap.mode).toBe("full");
    expect(plan.execution.e2e.files).toHaveLength(3);
    expect(plan.expectedJobs).toEqual(["static", "database", "integration", "e2e"]);
  });

  describe("enforce mode: a pull request runs its lane", () => {
    const activated = {
      ...manifest,
      activation: { selectiveEnforcement: true },
      appWide: [{ pattern: "components/ui/**", reason: "shared interface components reach every screen" }],
    };
    const withUi = [...files, "components/ui/button.tsx"].sort();
    const enforce = (changes: Array<{ status: string; path: string; oldPath?: string }>, extra: Record<string, unknown> = {}) =>
      selectTests({ manifest: activated, files: withUi, edges, changes, identity: proven, mode: "enforce", ...extra });
    const modes = (plan: ReturnType<typeof enforce>) =>
      Object.fromEntries(["unit", "integration", "e2e", "pgtap", "migrationChain", "advisors"].map((key) => [key, plan.execution[key].mode]));

    it("documentation only: the static job, and nothing that needs a database or a browser", () => {
      const plan = enforce([{ status: "M", path: "README.md" }]);
      expect(plan.lane).toBe("docs");
      expect(modes(plan)).toEqual({ unit: "full", integration: "none", e2e: "none", pgtap: "none", migrationChain: "none", advisors: "none" });
      expect(plan.expectedJobs).toEqual(["static"]);
    });

    it("one area's screen: that area's specs and the smoke specs, and no database job", () => {
      const plan = enforce([{ status: "M", path: "components/brand/logo.tsx" }]);
      expect(plan.lane).toBe("screen");
      expect(plan.execution.e2e).toMatchObject({ mode: "selected", files: ["e2e/auth.spec.ts", "e2e/shell.spec.ts"] });
      expect(plan.execution.pgtap).toMatchObject({ mode: "none", files: [] });
      expect(plan.execution.pgtap.reason).toContain("no database input changed");
      expect(plan.execution.integration.mode).toBe("none");
      expect(plan.expectedJobs).toEqual(["static", "e2e"]);
    });

    it("a change deep in one area reaches the specs of every area whose screens import it", () => {
      // app/reports/page.tsx imports lib/reports/query.ts, so a change to the query reaches the
      // reports screens although no spec imports either file.
      const deep = { ...activated, domains: { ...activated.domains, helpers: { risk: "low", sources: ["lib/reports/**"], e2e: [] } } };
      const plan = selectTests({ manifest: deep, files: withUi, edges, changes: [{ status: "M", path: "lib/reports/query.ts" }], identity: proven, mode: "enforce" });
      expect(plan.execution.e2e.files).toEqual(["e2e/reports.spec.ts", "e2e/shell.spec.ts"]);
      expect(plan.selection.e2e.reasons["e2e/reports.spec.ts"]).toContain("domain reports (app/reports/page.tsx imports lib/reports/query.ts)");
    });

    it("a change that a shared or high-risk file imports reaches every screen", () => {
      // The shared button imports the logo, so a change to the logo is on every screen.
      const withButton: Record<string, string> = { ...sources, "components/ui/button.tsx": 'export { Logo as Button } from "@/components/brand/logo";' };
      const graph = buildGraph(withUi, (path: string) => withButton[path] ?? "");
      const plan = selectTests({ manifest: activated, files: withUi, edges: graph.edges, changes: [{ status: "M", path: "components/brand/logo.tsx" }], identity: proven, mode: "enforce" });
      expect(plan.lane).toBe("app-wide");
      expect(plan.execution.e2e.mode).toBe("full");
      expect(plan.selection.e2e.fullReasons).toEqual(["components/ui/button.tsx imports components/brand/logo.tsx: shared interface components reach every screen"]);
      expect(plan.execution.pgtap.mode).toBe("none");
    });

    it("always runs the whole unit suite, which needs no database", () => {
      const plan = enforce([{ status: "M", path: "components/brand/logo.tsx" }]);
      expect(plan.selection.unit.files).toEqual(["tests/unit/logo.test.ts"]);
      expect(plan.execution.unit).toEqual({ mode: "full", files: ["tests/unit/logo.test.ts", "tests/unit/money.test.ts", "tests/unit/query.test.ts"] });
    });

    it("shared interface: every E2E spec, and still no database job", () => {
      const plan = enforce([{ status: "M", path: "components/ui/button.tsx" }]);
      expect(plan.lane).toBe("app-wide");
      expect(plan.risk).toBe("medium");
      expect(plan.fullReasons).toEqual([]);
      expect(plan.execution.e2e.mode).toBe("full");
      expect(plan.execution.e2e.files).toHaveLength(3);
      expect(plan.selection.e2e.fullReasons).toEqual(["components/ui/button.tsx: shared interface components reach every screen"]);
      expect(plan.expectedJobs).toEqual(["static", "e2e"]);
    });

    it("the HTTP suite runs whole when the change reaches one of its files, and not for its smoke files alone", () => {
      // lib/reports/query.ts is imported by tests/integration/paging.test.ts.
      const reached = enforce([{ status: "M", path: "lib/reports/query.ts" }]);
      expect(reached.execution.integration).toMatchObject({ mode: "full" });
      expect(reached.execution.integration.files).toHaveLength(4);
      expect(reached.expectedJobs).toEqual(["static", "integration", "e2e"]);
      const smokeOnly = enforce([{ status: "M", path: "components/brand/logo.tsx" }]);
      expect(smokeOnly.selection.integration.files).toEqual(["tests/integration/authority.test.ts"]);
      expect(smokeOnly.execution.integration.mode).toBe("none");
    });

    it("a changed test runs without the smoke specs, because the application did not change", () => {
      const unit = enforce([{ status: "M", path: "tests/unit/money.test.ts" }]);
      expect(unit.lane).toBe("tests");
      expect(unit.expectedJobs).toEqual(["static"]);
      const spec = enforce([{ status: "M", path: "e2e/reports.spec.ts" }]);
      expect(spec.execution.e2e).toMatchObject({ mode: "selected", files: ["e2e/reports.spec.ts"] });
      expect(spec.expectedJobs).toEqual(["static", "e2e"]);
      const http = enforce([{ status: "M", path: "tests/integration/fund-a.test.ts" }]);
      expect(http.execution.integration.mode).toBe("full");
      expect(http.execution.e2e.mode).toBe("none");
      expect(http.expectedJobs).toEqual(["static", "integration"]);
    });

    it("anything high-risk, and every doubt, runs every suite", () => {
      for (const path of ["lib/money.ts", "supabase/tests/database/001_auth.sql", "package.json", "scripts/testing/select.mjs", "lib/unknown.ts"]) {
        const plan = enforce([{ status: "M", path }]);
        expect(plan.lane, path).toBe("critical");
        expect(modes(plan), path).toEqual({ unit: "full", integration: "full", e2e: "full", pgtap: "full", migrationChain: "full", advisors: "full" });
        expect(plan.expectedJobs, path).toEqual(["static", "database", "integration", "e2e"]);
      }
      const renamed = enforce([{ status: "R", path: "components/brand/mark.tsx", oldPath: "components/brand/logo.tsx" }]);
      expect(renamed.lane).toBe("critical");
    });

    it("splits the E2E specs into balanced shards, and never more than it is allowed", () => {
      const minutes = { "e2e/auth.spec.ts": 9, "e2e/reports.spec.ts": 8, "e2e/shell.spec.ts": 7 };
      const wide = (maxShards: number) => enforce([{ status: "M", path: "components/ui/button.tsx" }], { maxShards, manifest: { ...activated, e2eMinutes: minutes } });
      expect(wide(1).execution.e2e.shards).toEqual([["e2e/auth.spec.ts", "e2e/reports.spec.ts", "e2e/shell.spec.ts"]]);
      // 24 minutes at 12 a shard is two shards: the heaviest alone, the other two together.
      expect(wide(4).execution.e2e.shards).toEqual([["e2e/auth.spec.ts"], ["e2e/reports.spec.ts", "e2e/shell.spec.ts"]]);
      expect(enforce([{ status: "M", path: "README.md" }]).execution.e2e.shards).toBeUndefined();
    });

    it("shadow and full plans still require everything, whatever lane the change is in", () => {
      const shadow = selectTests({ manifest: activated, files: withUi, edges, changes: [{ status: "M", path: "README.md" }], identity: proven });
      expect(shadow.lane).toBe("docs");
      expect(shadow.execution.pgtap.mode).toBe("full");
      expect(shadow.execution.migrationChain.mode).toBe("full");
      expect(shadow.expectedJobs).toEqual(["static", "database", "integration", "e2e"]);
    });
  });

  it("is deterministic: the same inputs in another order give the same plan digest", () => {
    const changes = [
      { status: "M", path: "components/brand/logo.tsx" },
      { status: "M", path: "lib/reports/query.ts" },
    ];
    const first = selectTests({ manifest, files, edges, changes, identity: proven });
    const second = selectTests({ manifest, files: [...files].reverse(), edges, changes: [...changes].reverse(), identity: proven });
    expect(second.digest).toBe(first.digest);
  });

  it("R7: resolves a .js specifier to the TypeScript source it names, so its dependants are selected", () => {
    // The review's probe: a `.js` import of a `.tsx` module was unresolved, stayed low risk and lost
    // its dependent test.
    const withJs = {
      ...sources,
      "components/brand/badge.tsx": "export const Badge = () => null;",
      "components/brand/logo.tsx": 'import { Badge } from "./badge.js";\nexport const Logo = Badge;',
    };
    const jsFiles = Object.keys(withJs).sort();
    const graph = buildGraph(jsFiles, (path: string) => withJs[path as keyof typeof withJs]);
    expect(graph.unresolved).toEqual([]);
    const result = selectTests({
      manifest,
      files: jsFiles,
      edges: graph.edges,
      unresolved: graph.unresolved,
      changes: [{ status: "M", path: "components/brand/badge.tsx" }],
      identity: proven,
    });
    expect(result.selection.unit.files).toEqual(["tests/unit/logo.test.ts"]);
  });

  it("R7: an import the graph cannot resolve in non-test source forces full coverage", () => {
    const unresolved = [{ from: "lib/reports/query.ts", specifier: "./missing.js" }];
    const result = select([{ status: "M", path: "components/brand/logo.tsx" }], { unresolved });
    expect(result.risk).toBe("high");
    expect(result.selection.unit.mode).toBe("full");
    expect(result.fullReasons).toEqual(["lib/reports/query.ts imports ./missing.js, which the import graph cannot resolve"]);
  });

  it("R7: an unresolved import inside a test file does not force full coverage", () => {
    const unresolved = [{ from: "tests/unit/query.test.ts", specifier: "@/lib/nowhere" }];
    expect(select([{ status: "M", path: "components/brand/logo.tsx" }], { unresolved }).fullReasons).toEqual([]);
  });

  it("R6: selects the migration chain locally for high-risk changes only, and says why not otherwise", () => {
    expect(select([{ status: "M", path: "lib/money.ts" }]).selection.migrationChain.mode).toBe("full");
    const low = select([{ status: "M", path: "components/brand/logo.tsx" }]).selection.migrationChain;
    expect(low.mode).toBe("not selected");
    expect(low.reason).toMatch(/CI and every release candidate still run it/);
    // Execution, which the gates enforce, keeps it full either way.
    expect(select([{ status: "M", path: "components/brand/logo.tsx" }]).execution.migrationChain.mode).toBe("full");
  });

  it("R4: carries the manifest's retired tests into the plan for the gate to read", () => {
    const retiring = { ...manifest, retiredTests: [{ file: "tests/unit/old.test.ts", reason: "merged" }] };
    expect(selectTests({ manifest: retiring, files, edges, changes: [], identity: proven }).retiredTests).toEqual([
      { file: "tests/unit/old.test.ts", reason: "merged" },
    ]);
  });

  it("survives an import cycle", () => {
    const cyclic = {
      "lib/reports/a.ts": 'import "./b";',
      "lib/reports/b.ts": 'import "./a";',
      "tests/unit/a.test.ts": 'import "@/lib/reports/a";',
    };
    const cyclicFiles = [...files, ...Object.keys(cyclic)];
    const graph = buildGraph(cyclicFiles, (path: string) => ({ ...sources, ...cyclic })[path as keyof typeof cyclic]);
    const plan = selectTests({ manifest, files: cyclicFiles, edges: graph.edges, changes: [{ status: "M", path: "lib/reports/b.ts" }], identity: proven });
    expect(plan.selection.unit.files).toEqual(["tests/unit/a.test.ts"]);
  });

  it("a stale manifest forces the suite it describes to full", () => {
    const stale = { ...manifest, independent: { ...manifest.independent, e2e: ["e2e/auth.spec.ts", "e2e/reports.spec.ts"] } };
    const plan = selectTests({ manifest: stale, files, edges, changes: [{ status: "M", path: "README.md" }], identity: proven });
    expect(plan.selection.e2e.mode).toBe("full");
    expect(plan.selection.e2e.fullReasons.join(" ")).toContain("e2e/shell.spec.ts is in no reviewed group");
  });

  it("validates the manifest against the tests on disk", () => {
    const inventory = {
      unit: [],
      integration: ["tests/integration/authority.test.ts"],
      e2e: ["e2e/auth.spec.ts", "e2e/reports.spec.ts", "e2e/shell.spec.ts"],
      pgtap: ["supabase/tests/database/001_auth.sql"],
    };
    const problems = validateManifest(manifest, inventory).map((problem: { reason: string }) => problem.reason);
    expect(problems).toContain("manifest names tests/integration/paging.test.ts, which does not exist");
    expect(problems).toContain("manifest names tests/integration/fund-a.test.ts, which does not exist");
  });
});

describe("reading git", () => {
  it("R4: lists another commit's whole tree without a checkout, so a base keeps the tests a change deletes", () => {
    const git = (args: string[]) => {
      expect(args).toEqual(["ls-tree", "-r", "--name-only", "-z", SHA_A]);
      return "tests/unit/old.test.ts\0lib/money.ts\0";
    };
    expect(revisionFiles(git, SHA_A)).toEqual(["lib/money.ts", "tests/unit/old.test.ts"]);
  });

  it("parses renames and deletions from a -z name-status diff", () => {
    const raw = ["M", "lib/a.ts", "R087", "lib/old.ts", "lib/new.ts", "D", "lib/gone.ts", "A", "lib/b.ts", ""].join("\0");
    expect(parseNameStatus(raw)).toEqual([
      { status: "M", path: "lib/a.ts" },
      { status: "R", path: "lib/new.ts", oldPath: "lib/old.ts" },
      { status: "D", path: "lib/gone.ts" },
      { status: "A", path: "lib/b.ts" },
    ]);
  });

  it("parses the working tree, untracked files included", () => {
    const raw = [" M lib/a.ts", "?? lib/new.ts", " D lib/gone.ts", "R  lib/moved.ts", "lib/was.ts", ""].join("\0");
    expect(parsePorcelain(raw)).toEqual([
      { status: "M", path: "lib/a.ts" },
      { status: "A", path: "lib/new.ts" },
      { status: "D", path: "lib/gone.ts" },
      { status: "R", path: "lib/moved.ts", oldPath: "lib/was.ts" },
    ]);
  });

  function fakeGit(overrides: Record<string, string | Error> = {}) {
    const answers: Record<string, string | Error> = {
      "rev-parse HEAD": SHA_B,
      "rev-parse --is-shallow-repository": "false",
      [`cat-file -e ${SHA_A}^{commit}`]: "",
      [`cat-file -e ${SHA_B}^{commit}`]: "",
      [`rev-parse ${SHA_A}^{tree}`]: "1".repeat(40),
      [`rev-parse ${SHA_B}^{tree}`]: "2".repeat(40),
      [`merge-base ${SHA_A} ${SHA_B}`]: SHA_A,
      [`diff --name-status -M -z ${SHA_A} ${SHA_B}`]: "M\0lib/reports/query.ts\0",
      ...overrides,
    };
    return (args: string[]) => {
      const answer = answers[args.join(" ")];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected git ${args.join(" ")}`);
      return answer;
    };
  }

  it("proves an identity it can fully resolve", () => {
    const { identity, changes } = collectIdentity({ git: fakeGit(), base: SHA_A, head: SHA_B, readFile: () => "" });
    expect(identity.proven).toBe(true);
    expect(identity.mergeBase).toBe(SHA_A);
    expect(changes).toEqual([{ status: "M", path: "lib/reports/query.ts" }]);
  });

  it("names every doubt: shallow clone, abbreviated names, missing commits, wrong checkout", () => {
    expect(collectIdentity({ git: fakeGit({ "rev-parse --is-shallow-repository": "true" }), base: SHA_A, head: SHA_B, readFile: () => "" }).identity.problems)
      .toEqual(["the clone is shallow, so ancestry is incomplete"]);
    expect(collectIdentity({ git: fakeGit(), base: "abc123", head: SHA_B, readFile: () => "" }).identity.problems)
      .toEqual(["base abc123 is not a full 40-character commit name"]);
    expect(collectIdentity({ git: fakeGit(), head: SHA_B, readFile: () => "" }).identity.problems).toEqual(["no base commit was given"]);
    const missing = collectIdentity({ git: fakeGit({ [`cat-file -e ${SHA_A}^{commit}`]: new Error("not found") }), base: SHA_A, head: SHA_B, readFile: () => "" });
    expect(missing.identity.problems[0]).toMatch(/missing from the clone's history/);
    const elsewhere = collectIdentity({ git: fakeGit({ "rev-parse HEAD": "c".repeat(40) }), base: SHA_A, head: SHA_B, readFile: () => "" });
    expect(elsewhere.identity.problems).toEqual([`the checkout is at ${"c".repeat(40)}, not at head ${SHA_B}`]);
  });

  it("binds a local plan to the working tree's contents", () => {
    const git = fakeGit({ "status --porcelain=v1 -z --untracked-files=all": " M lib/money.ts\0" });
    const one = collectIdentity({ git, base: SHA_A, head: SHA_B, worktree: true, readFile: () => "one" }).identity.worktreeDigest;
    const two = collectIdentity({ git, base: SHA_A, head: SHA_B, worktree: true, readFile: () => "two" }).identity.worktreeDigest;
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
  });
});
