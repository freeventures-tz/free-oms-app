import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkBase, describePlan } from "@/scripts/testing/check.mjs";
import { partitionShards, planOutputs, planShards, runCiCli } from "@/scripts/testing/ci.mjs";
import { selectTests } from "@/scripts/testing/select.mjs";

/**
 * What CI and `npm run check` read out of a plan.
 *
 * The plan decides which jobs a pull request needs and how the E2E specs are split between them.
 * These helpers only read that decision, so the tests hold them to the plan: a job is asked for
 * exactly when the plan's execution needs it, every spec lands in exactly one shard, and the split
 * is the same every time it is made.
 */

const manifest = {
  version: 1,
  activation: { selectiveEnforcement: true },
  suites: {
    unit: ["tests/unit/**/*.test.ts"],
    integration: ["tests/integration/**/*.test.ts"],
    e2e: ["e2e/**/*.spec.ts"],
    pgtap: ["supabase/tests/database/*.sql"],
  },
  minimums: {},
  forceFull: [{ pattern: "supabase/**", reason: "database" }],
  appWide: [{ pattern: "components/ui/**", reason: "shared interface components reach every screen" }],
  docsOnly: ["README.md"],
  domains: { sales: { risk: "medium", sources: ["app/sales/**"], e2e: ["e2e/sales.spec.ts"] } },
  groups: { integration: {}, e2e: {} },
  independent: { integration: ["tests/integration/authority.test.ts"], e2e: ["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts", "e2e/sales.spec.ts", "e2e/shell.spec.ts"] },
  smoke: { pgtap: [], integration: ["tests/integration/authority.test.ts"], e2e: ["e2e/shell.spec.ts"] },
  e2eMinutes: { "e2e/a.spec.ts": 10, "e2e/b.spec.ts": 9, "e2e/c.spec.ts": 3, "e2e/sales.spec.ts": 6, "e2e/shell.spec.ts": 1 },
};
const files = [
  "README.md",
  "app/sales/page.tsx",
  "components/ui/button.tsx",
  "tests/unit/money.test.ts",
  "tests/integration/authority.test.ts",
  "e2e/a.spec.ts",
  "e2e/b.spec.ts",
  "e2e/c.spec.ts",
  "e2e/sales.spec.ts",
  "e2e/shell.spec.ts",
  "supabase/migrations/001_first.sql",
  "supabase/tests/database/001_auth.sql",
];
const identity = { base: "a".repeat(40), head: "b".repeat(40), executedCommit: "b".repeat(40), proven: true, problems: [] };
const plan = (path: string, mode = "enforce", maxShards = 4) =>
  selectTests({ manifest, files, edges: new Map(), changes: [{ status: "M", path }], identity, mode, maxShards });

describe("splitting E2E specs into shards", () => {
  const minutes = manifest.e2eMinutes;
  const all = Object.keys(minutes);

  it("keeps a small set in one shard, because every shard pays for its own stack and build", () => {
    expect(partitionShards(["e2e/shell.spec.ts", "e2e/sales.spec.ts"], minutes, { maxShards: 4 })).toEqual([["e2e/sales.spec.ts", "e2e/shell.spec.ts"]]);
  });

  it("puts every spec in exactly one shard", () => {
    const shards = partitionShards(all, minutes, { maxShards: 4 });
    expect(shards.flat().sort()).toEqual([...all].sort());
    expect(new Set(shards.flat()).size).toBe(all.length);
  });

  it("balances by measured minutes: 29 minutes at 12 a shard is three shards of about ten", () => {
    const shards = partitionShards(all, minutes, { maxShards: 4 });
    expect(shards).toEqual([["e2e/a.spec.ts"], ["e2e/b.spec.ts", "e2e/shell.spec.ts"], ["e2e/c.spec.ts", "e2e/sales.spec.ts"]]);
  });

  it("never makes more shards than it is allowed, or than there are specs", () => {
    expect(partitionShards(all, minutes, { maxShards: 2 })).toHaveLength(2);
    expect(partitionShards(["e2e/a.spec.ts"], { "e2e/a.spec.ts": 100 }, { maxShards: 4 })).toEqual([["e2e/a.spec.ts"]]);
    expect(partitionShards([], minutes, { maxShards: 4 })).toEqual([]);
  });

  it("gives the same split for the same specs in any order", () => {
    expect(partitionShards([...all].reverse(), minutes, { maxShards: 4 })).toEqual(partitionShards(all, minutes, { maxShards: 4 }));
  });

  it("never splits specs that share state, and keeps a chain of groups together", () => {
    // b reads what a left, and c reads what b left: one unit of 22 minutes, however heavy.
    const groups = [["e2e/a.spec.ts", "e2e/b.spec.ts"], ["e2e/b.spec.ts", "e2e/c.spec.ts"]];
    const shards = partitionShards(all, minutes, { maxShards: 4, groups });
    expect(shards).toEqual([["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"], ["e2e/sales.spec.ts", "e2e/shell.spec.ts"]]);
    // A group member that is not in this run does not pull the others together.
    expect(partitionShards(["e2e/a.spec.ts", "e2e/c.spec.ts"], { "e2e/a.spec.ts": 13, "e2e/c.spec.ts": 13 }, { maxShards: 4, groups })).toEqual([["e2e/a.spec.ts"], ["e2e/c.spec.ts"]]);
  });

  it("counts a spec with no measured time as an average one", () => {
    const unmeasured = Array.from({ length: 12 }, (_, index) => `e2e/new-${String(index).padStart(2, "0")}.spec.ts`);
    // Twelve specs at two minutes each is 24 minutes: two shards of six.
    expect(partitionShards(unmeasured, {}, { maxShards: 4 }).map((shard) => shard.length)).toEqual([6, 6]);
  });
});

describe("what CI reads from a plan", () => {
  it("a screen change needs the static and E2E jobs, in one shard", () => {
    expect(planOutputs(plan("app/sales/page.tsx"))).toEqual({
      lane: "screen",
      database: "false",
      integration: "false",
      e2e: "true",
      "e2e-shards": "[1]",
      "e2e-shard-total": "1",
    });
  });

  it("documentation needs no E2E job, and its matrix is empty", () => {
    expect(planOutputs(plan("README.md"))).toMatchObject({ lane: "docs", database: "false", integration: "false", e2e: "false", "e2e-shards": "[]", "e2e-shard-total": "0" });
  });

  it("a shared interface change runs every spec, split between jobs", () => {
    const outputs = planOutputs(plan("components/ui/button.tsx"));
    expect(outputs).toMatchObject({ lane: "app-wide", database: "false", e2e: "true", "e2e-shards": "[1,2,3]", "e2e-shard-total": "3" });
  });

  it("high-risk application code needs every E2E spec and no database job", () => {
      const critical = { ...manifest, appCritical: [{ pattern: "app/sales/**", reason: "stands in for a server action" }], domains: {} };
      const outputs = planOutputs(selectTests({ manifest: critical, files, edges: new Map(), changes: [{ status: "M", path: "app/sales/page.tsx" }], identity, mode: "enforce", maxShards: 8 }));
      expect(outputs).toMatchObject({ lane: "app-critical", database: "false", integration: "false", e2e: "true" });
    });

  it("makes shards of the manifest's own size when it names one", () => {
    // 29 minutes of specs: three shards at the default twelve minutes, five at six.
    const small = { ...manifest, e2eShardMinutes: 6 };
    const wide = (m: typeof manifest) => selectTests({ manifest: m, files, edges: new Map(), changes: [{ status: "M", path: "components/ui/button.tsx" }], identity, mode: "enforce", maxShards: 8 });
    expect(wide(manifest).execution.e2e.shards).toHaveLength(3);
    // No shard can be lighter than the heaviest spec (ten minutes), so six-minute shards settle at three as well.
    expect(wide(small).execution.e2e.shards).toHaveLength(3);
    const even = { ...small, e2eMinutes: { "e2e/a.spec.ts": 6, "e2e/b.spec.ts": 6, "e2e/c.spec.ts": 6, "e2e/sales.spec.ts": 6, "e2e/shell.spec.ts": 5 } };
    expect(wide(even).execution.e2e.shards).toHaveLength(5);
  });

  it("a database change needs every job", () => {
    expect(planOutputs(plan("supabase/migrations/001_first.sql"))).toMatchObject({ lane: "critical", database: "true", integration: "true", e2e: "true" });
  });

  it("a push to main and a release candidate need every job, whatever changed", () => {
    expect(planOutputs(plan("README.md", "shadow"))).toMatchObject({ database: "true", integration: "true", e2e: "true" });
    // One E2E job for a release, so one build is the evidence.
    expect(planOutputs(plan("README.md", "full", 1))).toMatchObject({ database: "true", e2e: "true", "e2e-shards": "[1]" });
  });

  it("reads a plan made before shards existed as one shard of everything", () => {
    const old = plan("components/ui/button.tsx");
    delete old.execution.e2e.shards;
    expect(planShards(old)).toEqual([old.execution.e2e.files]);
  });

  it("prints outputs and shard files for the workflow, and refuses a shard the plan does not have", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-ci-plan-"));
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify(plan("components/ui/button.tsx")));
    expect(runCiCli(["outputs", "--plan", path]).split("\n")).toContain("e2e-shards=[1,2,3]");
    expect(runCiCli(["shard-files", "--plan", path, "--shard", "1"])).toBe("e2e/a.spec.ts");
    expect(runCiCli(["shard-files", "--plan", path, "--shard", "2"])).toBe("e2e/b.spec.ts e2e/shell.spec.ts");
    expect(() => runCiCli(["shard-files", "--plan", path, "--shard", "4"])).toThrow(/--shard must be 1 to 3/);
    expect(() => runCiCli(["deploy", "--plan", path])).toThrow(/unknown command deploy/);
  });
});

describe("npm run check", () => {
  it("measures the branch from where it left origin/main, then main, and says so when it has neither", () => {
    const calls: string[] = [];
    const git = (known: string[]) => (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "merge-base" && known.includes(args[1])) return `base-of-${args[1]}`;
      throw new Error("no merge base");
    };
    expect(checkBase(git(["origin/main", "main"]), undefined)).toBe("base-of-origin/main");
    expect(checkBase(git(["main"]), undefined)).toBe("base-of-main");
    expect(checkBase(git(["abc"]), "abc")).toBe("base-of-abc");
    expect(() => checkBase(git([]), undefined)).toThrow(/no base: none of origin\/main, main/);
  });

  it("says which lane the change is in and what CI will hold it to", () => {
    const screen = describePlan(plan("app/sales/page.tsx")).join("\n");
    expect(screen).toContain("lane: screen (risk medium)");
    expect(screen).toContain("e2e: selected, 2 of 5 file(s)");
    expect(screen).toContain("pgtap: not needed (no database input changed");
    expect(screen).toContain("migration chain: not needed");

    const critical = describePlan(plan("supabase/migrations/001_first.sql")).join("\n");
    expect(critical).toContain("lane: critical (risk high)");
    expect(critical).toContain("everything, because: supabase/migrations/001_first.sql: database");
    expect(critical).toContain("migration chain: runs");
  });
});
