#!/usr/bin/env node
/**
 * `npm run test:select -- --base <sha> --head <sha> [--mode shadow|full|enforce] [--worktree] --output <plan.json>`
 *
 * Decides which tests a change needs, from the diff, the import graph and the reviewed manifest, and
 * writes that decision down as a plan. It never touches a database.
 *
 * The plan has two halves. `selection` is what the rules say the change needs. `execution` is what a
 * gate will require to have run. In shadow and full mode `execution` is every suite, and `selection`
 * is reported beside it so the rules keep being measured against full runs. In enforce mode
 * (pull requests, and `npm run check`) `execution` follows the change's lane:
 *
 *   docs       documentation only: the static checks
 *   tests      test files only: the static checks, and the changed HTTP or E2E tests
 *   screen     one area's screens: static, that area's E2E specs and the E2E smoke specs
 *   app-wide   shared interface, layout or wording: static and every E2E spec
 *   critical   anything a rule marks high-risk, and every doubt: every suite, as before
 *
 * The database suites (pgTAP, the migration chain, lint and advisors) and the HTTP suite run
 * against the database alone. Their inputs all sit behind full-coverage rules, so outside the
 * critical lane those inputs are byte-identical to the base, whose own run already stands.
 *
 * Every doubt resolves to full coverage, with the reason written into the plan: an unknown or
 * missing base, a shallow clone, a path no rule names, a rename or deletion, an unexpected test
 * inventory, a stale or malformed manifest, or any error inside the selector itself.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FULL_SHA,
  PLAN_SCHEMA_VERSION,
  RESPONSIVE_PROJECTS,
  canonicalJson,
  discoverInventory,
  gitRunner,
  repositoryFiles,
  matchesAny,
  parseArgs,
  readJson,
  selectorDigest,
  sha256,
} from "./common.mjs";
import { partitionShards } from "./ci.mjs";
import { buildGraph, reverseClosure } from "./graph.mjs";

export const SUITES = ["unit", "integration", "e2e", "pgtap"];
export const EXPECTED_JOBS = ["static", "database", "integration", "e2e"];
const KNOWN_STATUSES = new Set(["A", "M", "D", "R", "C", "T"]);
const RISK_ORDER = ["low", "medium", "high"];

/**
 * Problems with the manifest itself, judged against the tests actually on disk. Each one forces full
 * coverage of the suite it names, because a selection built on a stale map is not a selection.
 */
/** @param {any} manifest @param {Record<string, string[]>} inventory @returns {Array<{ suite: string, reason: string }>} */
export function validateManifest(manifest, inventory) {
  const problems = [];
  if (manifest?.version !== 1) problems.push({ suite: "*", reason: "manifest version is not 1" });
  for (const suite of SUITES) {
    if (!Array.isArray(manifest?.suites?.[suite])) problems.push({ suite: "*", reason: `manifest has no ${suite} suite globs` });
  }
  if (problems.length > 0) return problems;

  for (const suite of ["integration", "e2e"]) {
    const classified = classifiedFiles(manifest, suite);
    for (const file of inventory[suite]) {
      if (!classified.has(file)) problems.push({ suite, reason: `${file} is in no reviewed group and is not marked independent` });
    }
    for (const file of classified) {
      if (!inventory[suite].includes(file)) problems.push({ suite, reason: `manifest names ${file}, which does not exist` });
    }
  }
  for (const suite of ["pgtap", "integration", "e2e"]) {
    for (const file of manifest.smoke?.[suite] ?? []) {
      if (!inventory[suite].includes(file)) problems.push({ suite, reason: `smoke test ${file} does not exist` });
    }
  }
  for (const [name, domain] of Object.entries(manifest.domains ?? {})) {
    if (!RISK_ORDER.includes(domain.risk)) problems.push({ suite: "*", reason: `domain ${name} has no valid risk` });
    for (const file of domain.e2e ?? []) {
      if (!inventory.e2e.includes(file)) problems.push({ suite: "e2e", reason: `domain ${name} names ${file}, which does not exist` });
    }
  }
  return problems;
}

function classifiedFiles(manifest, suite) {
  const out = new Set(manifest.independent?.[suite] ?? []);
  for (const group of Object.values(manifest.groups?.[suite] ?? {})) for (const file of group.files) out.add(file);
  return out;
}

/** Adds every group that shares a member with the selection, repeatedly, until nothing changes. */
/** @param {Iterable<string>} selected @param {any} groups @param {Record<string, string[]>} reasons @returns {Set<string>} */
export function expandGroups(selected, groups, reasons) {
  const out = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, group] of Object.entries(groups ?? {})) {
      const trigger = group.files.find((file) => out.has(file));
      if (!trigger) continue;
      for (const file of group.files) {
        if (!out.has(file)) {
          out.add(file);
          addReason(reasons, file, `group ${name} (shares state with ${trigger})`);
          changed = true;
        }
      }
    }
  }
  return out;
}

function addReason(reasons, file, reason) {
  if (!reasons[file]) reasons[file] = [];
  if (!reasons[file].includes(reason)) reasons[file].push(reason);
}

function suiteOf(path, manifest) {
  return SUITES.find((suite) => matchesAny(path, manifest.suites[suite])) ?? null;
}

/**
 * The pure decision. Everything it needs is passed in, so the rules can be tested with examples
 * written from the specification rather than from this code.
 *
 *   changes   [{ status, path, oldPath? }] between base and head (and the working tree, locally)
 *   files     every file in the checkout being planned
 *   edges     the import graph's forward edges (graph.mjs)
 *   identity  { base, head, ... } plus `problems`: identity doubts found while collecting it
 */
/** @param {any} options @returns {any} */
export function selectTests({ manifest, files, edges, changes, unresolved = [], mode = "shadow", identity = {}, selector = {}, maxShards = 1 }) {
  if (!["shadow", "full", "enforce"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  // With the manifest's switch off, an enforce plan requires everything. One edit to the manifest
  // returns every gate to full execution, and that edit forces full coverage by itself.

  const inventory = discoverInventory(".", manifest, files);
  const fullReasons = [...(identity.problems ?? [])];
  const suiteFull = Object.fromEntries(SUITES.map((suite) => [suite, []]));
  const reasons = Object.fromEntries(SUITES.map((suite) => [suite, {}]));
  const selected = Object.fromEntries(SUITES.map((suite) => [suite, new Set()]));
  // Test files the change itself reaches: a changed or new test, or one that imports a changed
  // file. The mandatory smoke files are not in here, because they are picked for every change,
  // including one that cannot alter what they prove.
  const reached = Object.fromEntries(SUITES.map((suite) => [suite, new Set()]));
  // Whether anything the application serves changed, as opposed to documentation or a test file.
  let appChanged = false;
  const domains = new Set();
  let risk = "low";
  const raise = (level) => {
    if (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(risk)) risk = level;
  };

  for (const problem of validateManifest(manifest, inventory)) {
    if (problem.suite === "*") fullReasons.push(`manifest: ${problem.reason}`);
    else suiteFull[problem.suite].push(`manifest: ${problem.reason}`);
  }

  if (mode === "full") fullReasons.push("full coverage requested");

  // An import the graph could not resolve is a dependency the selector cannot follow. Test files
  // are left out: a test that imports something missing fails on its own, and the selector's own
  // tests hold imports inside fixture strings.
  const testGlobs = SUITES.flatMap((suite) => manifest.suites?.[suite] ?? []);
  for (const entry of unresolved) {
    if (matchesAny(entry.from, testGlobs)) continue;
    fullReasons.push(`${entry.from} imports ${entry.specifier}, which the import graph cannot resolve`);
  }
  if (changes.length === 0 && !identity.proven) {
    fullReasons.push("no changed paths, and the base and head identities are not proven");
  }

  const sourcesChanged = [];
  for (const change of changes) {
    if (!KNOWN_STATUSES.has(change.status)) {
      fullReasons.push(`unrecognised change status ${change.status} on ${change.path}`);
      continue;
    }
    const paths = [change.path, change.oldPath].filter(Boolean);
    const allDocs = paths.every((path) => matchesAny(path, manifest.docsOnly ?? []));
    if ((change.status === "D" || change.status === "R" || change.status === "C") && !allDocs) {
      fullReasons.push(
        `${change.status === "D" ? "deleted" : "renamed or copied"} ${paths.join(" -> ")}: ` +
          "dependants in the base snapshot and replacement coverage need review",
      );
    }
    for (const path of paths) {
      if (matchesAny(path, manifest.docsOnly ?? [])) continue;
      const forced = (manifest.forceFull ?? []).find((rule) => matchesAny(path, [rule.pattern]));
      if (forced) {
        fullReasons.push(`${path}: ${forced.reason}`);
        continue;
      }
      const suite = suiteOf(path, manifest);
      if (suite) {
        if (inventory[suite].includes(path)) {
          selected[suite].add(path);
          addReason(reasons[suite], path, "changed or new test");
          reached[suite].add(path);
        }
        if (suite !== "unit") raise("medium");
        sourcesChanged.push(path);
        continue;
      }
      // Shared interface, layout and wording reach every screen, so every E2E spec runs. They
      // cannot reach the database, so they do not force the other suites.
      appChanged = true;
      const wide = (manifest.appWide ?? []).find((rule) => matchesAny(path, [rule.pattern]));
      if (wide) {
        suiteFull.e2e.push(`${path}: ${wide.reason}`);
        raise("medium");
        sourcesChanged.push(path);
        continue;
      }
      const owners = Object.entries(manifest.domains ?? {}).filter(([, domain]) => matchesAny(path, domain.sources));
      if (owners.length === 0) {
        fullReasons.push(`${path} is not mapped by any reviewed rule`);
        continue;
      }
      for (const [name, domain] of owners) {
        domains.add(name);
        raise(domain.risk);
        for (const spec of domain.e2e ?? []) {
          selected.e2e.add(spec);
          addReason(reasons.e2e, spec, `domain ${name} (${path})`);
        }
      }
      sourcesChanged.push(path);
    }
  }

  // Import-graph dependants of each changed source, one changed file at a time so each reason names
  // the file that pulled the test in.
  for (const path of sourcesChanged) {
    for (const dependant of reverseClosure(edges, [path])) {
      if (dependant === path) continue;
      const suite = suiteOf(dependant, manifest);
      if (suite) {
        if (!inventory[suite].includes(dependant)) continue;
        selected[suite].add(dependant);
        addReason(reasons[suite], dependant, `imports ${path}`);
        reached[suite].add(dependant);
        continue;
      }
      // An application file that imports the change carries it to that file's screens. E2E specs
      // import no application code, so this is how a change deep in one area reaches the specs of
      // every area that uses it. A shared or high-risk file that imports it reaches every screen.
      const shared = [...(manifest.forceFull ?? []), ...(manifest.appWide ?? [])].find((rule) => matchesAny(dependant, [rule.pattern]));
      if (shared) {
        const note = `${dependant} imports ${path}: ${shared.reason}`;
        if (!suiteFull.e2e.includes(note)) suiteFull.e2e.push(note);
        raise("medium");
        continue;
      }
      for (const [name, domain] of Object.entries(manifest.domains ?? {})) {
        if (!matchesAny(dependant, domain.sources)) continue;
        domains.add(name);
        raise(domain.risk);
        for (const spec of domain.e2e ?? []) {
          selected.e2e.add(spec);
          addReason(reasons.e2e, spec, `domain ${name} (${dependant} imports ${path})`);
        }
      }
    }
  }

  for (const suite of ["pgtap", "integration", "e2e"]) {
    for (const file of manifest.smoke?.[suite] ?? []) {
      if (!inventory[suite].includes(file)) continue;
      selected[suite].add(file);
      addReason(reasons[suite], file, "mandatory smoke");
    }
  }

  for (const suite of ["integration", "e2e"]) {
    selected[suite] = expandGroups(selected[suite], manifest.groups?.[suite], reasons[suite]);
    const classified = classifiedFiles(manifest, suite);
    const unknown = [...selected[suite]].filter((file) => !classified.has(file));
    if (unknown.length > 0) suiteFull[suite].push(`no reviewed grouping for ${unknown.join(", ")}`);
  }
  suiteFull.pgtap.push("pgTAP file selection is not implemented; every database test runs");

  if (fullReasons.length > 0) raise("high");

  const selection = {};
  for (const suite of SUITES) {
    const full = fullReasons.length > 0 || suiteFull[suite].length > 0;
    const files = full ? inventory[suite] : [...selected[suite]].sort();
    selection[suite] = {
      mode: full ? "full" : "selected",
      files,
      excluded: inventory[suite].filter((file) => !files.includes(file)),
      fullReasons: full ? [...fullReasons, ...suiteFull[suite]] : [],
      reasons: Object.fromEntries(
        files.map((file) => [file, full ? ["full coverage"] : [...(reasons[suite][file] ?? [])].sort()]),
      ),
    };
  }
  // The chain takes twenty minutes and checks released migrations; locally it runs for high-risk
  // changes, which include every change under supabase/. CI and release candidates always run it.
  selection.migrationChain =
    risk === "high"
      ? { mode: "full", reason: "high risk: the historical chain runs in full" }
      : { mode: "not selected", reason: "no migration, release check or other high-risk path changed; CI and every release candidate still run it" };
  selection.advisors = { mode: "full", reason: "database lint and advisors always run" };

  const enforced = mode === "enforce" && manifest.activation?.selectiveEnforcement === true;
  const everything = !enforced || fullReasons.length > 0;
  const testsChanged = SUITES.some((suite) => reached[suite].size > 0);
  const lane =
    fullReasons.length > 0 ? "critical" : selection.e2e.mode === "full" ? "app-wide" : appChanged ? "screen" : testsChanged ? "tests" : "docs";

  const all = (suite) => ({ mode: "full", files: inventory[suite] });
  const none = (reason) => ({ mode: "none", files: [], reason });
  const execution = {};
  // The unit suite takes under a minute and needs no database, so it always runs whole.
  execution.unit = all("unit");
  if (everything) {
    for (const suite of ["integration", "e2e", "pgtap"]) execution[suite] = all(suite);
    execution.migrationChain = { mode: "full" };
    execution.advisors = { mode: "full" };
  } else {
    // Every database input (migrations, pgTAP files, the stack's configuration, the chain and
    // advisor scripts) sits behind a full-coverage rule, so here they are byte-identical to the
    // base and the base's own run stands for them.
    const sameDatabase = "no database input changed: migrations, database tests and stack configuration are identical to the base";
    execution.pgtap = none(sameDatabase);
    execution.migrationChain = { mode: "none", reason: sameDatabase };
    execution.advisors = { mode: "none", reason: sameDatabase };
    // The HTTP suite calls the database's API, never the application. It runs whole when the
    // change reaches one of its files, because its files share one database and one order.
    execution.integration =
      reached.integration.size > 0 || suiteFull.integration.length > 0
        ? all("integration")
        : none("no integration test changed and none imports a changed file; the suite calls the database's API, which is unchanged");
    if (appChanged || selection.e2e.mode === "full") {
      execution.e2e = { mode: selection.e2e.mode, files: selection.e2e.files };
    } else {
      // Nothing the application serves changed, so the smoke specs have nothing new to prove. A
      // changed or new spec still runs, with whatever shares its state.
      const own = [...expandGroups(reached.e2e, manifest.groups?.e2e, {})].sort();
      execution.e2e = own.length > 0 ? { mode: "selected", files: own } : none("nothing the application serves changed");
    }
  }
  if (execution.e2e.mode !== "none") {
    execution.e2e.shards = partitionShards(execution.e2e.files, manifest.e2eMinutes ?? {}, {
      maxShards,
      groups: Object.values(manifest.groups?.e2e ?? {}).map((group) => group.files),
    });
  }
  execution.projects = RESPONSIVE_PROJECTS;
  const expectedJobs = [
    "static",
    ...(execution.pgtap.mode !== "none" || execution.migrationChain.mode !== "none" ? ["database"] : []),
    ...(execution.integration.mode !== "none" ? ["integration"] : []),
    ...(execution.e2e.mode !== "none" ? ["e2e"] : []),
  ];

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode,
    executionPolicy: enforced
      ? `selective enforcement: ${lane} lane`
      : mode === "enforce"
        ? "full execution; selective enforcement is switched off in the manifest"
        : "full execution; the selection is reported in shadow",
    lane,
    identity: { ...identity, problems: identity.problems ?? [] },
    selector,
    changes: [...changes].sort((a, b) => a.path.localeCompare(b.path)),
    risk,
    domains: [...domains].sort(),
    fullReasons,
    selection,
    execution,
    inventory,
    minimums: manifest.minimums ?? {},
    retiredTests: manifest.retiredTests ?? [],
    benchmarks: benchmarkEntries(manifest),
    expectedJobs,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** The manifest's benchmark files, so the gate can tell when one ran inside a main suite. */
/** @param {any} manifest */
function benchmarkEntries(manifest) {
  return {
    e2e: (manifest?.benchmarks?.e2e ?? []).map((entry) => ({ file: entry.file, grep: entry.grep ?? "" })),
    integration: (manifest?.benchmarks?.integration ?? []).map((entry) => ({ file: entry.file })),
  };
}

/**
 * Approved minimums for bases that predate this selector, keyed by the base's full SHA.
 *
 * Such a base has no manifest of its own, and the change's manifest is the change's to edit, so
 * neither can say what the base requires. Each record here says it instead: which files count as
 * tests (the base's own runner configuration, not the manifest's globs), how many of each the base
 * holds, and the numeric floors. The floors were measured on runs of the change that introduced this
 * selector, whose pgTAP files, migrations and migration-chain source are identical to the base's.
 * Every count that can be read off the base's tree is checked against it before the record is used.
 */
export const BOOTSTRAP_BASELINES = {
  // v0.12.2 on main, the base of issue #99.
  "2938b3cbaf367069d3b23ff1dbbb793412f8b3af": {
    tree: "8d35ee599f654df75a1ce2fc2e8dbb5ec07802cf",
    suites: {
      // vitest.config.mts, project unit
      unit: ["tests/unit/**/*.test.{ts,tsx}"],
      // vitest.config.mts, project integration
      integration: ["tests/integration/**/*.test.ts"],
      // playwright.config.ts: testDir ./e2e with Playwright's default testMatch
      e2e: ["e2e/**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
      // supabase test db
      pgtap: ["supabase/tests/**/*.sql"],
    },
    counts: { unit: 57, integration: 33, e2e: 25, pgtap: 28 },
    migrations: ["supabase/migrations/*.sql"],
    minimums: {
      migrations: 55,
      pgtapFiles: 28,
      pgtapAssertions: 1926,
      migrationChainCounterexamples: 155,
      responsiveProjects: ["mobile", "tablet", "desktop"],
    },
  },
  // v0.12.3 on main (#100), the base #99 was rebased onto. #100 added two unit files and changed no
  // pgTAP file, migration or migration-chain source, so the floors are the ones measured above.
  "61664cfdfde469955c35a862234c857db7246cfe": {
    tree: "b2a6e667f27f82073d3e1493d25034746984941e",
    suites: {
      // vitest.config.mts, project unit
      unit: ["tests/unit/**/*.test.{ts,tsx}"],
      // vitest.config.mts, project integration
      integration: ["tests/integration/**/*.test.ts"],
      // playwright.config.ts: testDir ./e2e with Playwright's default testMatch
      e2e: ["e2e/**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
      // supabase test db
      pgtap: ["supabase/tests/**/*.sql"],
    },
    counts: { unit: 59, integration: 33, e2e: 25, pgtap: 28 },
    migrations: ["supabase/migrations/*.sql"],
    minimums: {
      migrations: 55,
      pgtapFiles: 28,
      pgtapAssertions: 1926,
      migrationChainCounterexamples: 155,
      responsiveProjects: ["mobile", "tablet", "desktop"],
    },
  },
};

/**
 * The approved base's minimum for a change, planned over the base's own tree.
 *
 * A base that holds a selector plans itself, with its own selector and manifest. A base that holds
 * none (the change that introduces this selector merges into one) is planned from its record in
 * `bootstrap`, never from the change's manifest: every test the record's patterns find in the base's
 * tree is required, and the record's floors hold. A base with no record, or whose tree disagrees with
 * its record, has no baseline. So does a base that is not a full SHA in this clone's history. Each
 * throws, and the gate then refuses rather than measure the head against itself.
 */
/** @param {{ root: string, git: (args: string[]) => string, base: string, head: string, run?: typeof spawnSync, bootstrap?: Record<string, any> }} options @returns {any} */
export function baselinePlan({ root, git, base, head, run = spawnSync, bootstrap = BOOTSTRAP_BASELINES }) {
  if (!FULL_SHA.test(base ?? "")) throw new Error(`the base ${base || "(none)"} is not a full commit SHA`);
  try {
    git(["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    throw new Error(`the base ${base} is not in this clone's history`);
  }

  const policy = git(["ls-tree", "-r", "--name-only", "-z", base, "scripts/testing"]).split("\0").filter(Boolean);
  if (!policy.includes("scripts/testing/select.mjs")) return bootstrapPlan({ git, base, head, record: bootstrap[base] });

  // The base's own selector runs from a copy of its scripts/testing, over the base's tree.
  const dir = mkdtempSync(join(tmpdir(), "oms-base-policy-"));
  try {
    for (const path of policy) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${git(["show", `${base}:${path}`])}\n`);
    }
    const output = join(dir, "base-plan.json");
    const result = run(
      process.execPath,
      [join(dir, "scripts/testing/select.mjs"), "--base", base, "--head", head, "--mode", "full", "--inventory-rev", base, "--manifest", join(dir, "scripts/testing/manifest.json"), "--output", output],
      { cwd: root, encoding: "utf8", shell: false },
    );
    if (result.error || result.status !== 0) throw new Error(`the base's selector failed: ${(result.stderr ?? result.error?.message ?? "").trim()}`);
    return readJson(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The base plan for a base with no selector, from its approved record. Throws when there is no
 * record, or when the base's tree no longer matches what the record was approved against.
 */
/** @param {{ git: (args: string[]) => string, base: string, head: string, record: any }} options @returns {any} */
function bootstrapPlan({ git, base, head, record }) {
  if (!record) throw new Error(`the base ${base} has no selector and no approved bootstrap record, so its minimum is unknown`);
  const tree = git(["rev-parse", `${base}^{tree}`]);
  if (tree !== record.tree) throw new Error(`the base ${base} has tree ${tree}, not the approved ${record.tree}`);

  const files = revisionFiles(git, base);
  const inventory = Object.fromEntries(SUITES.map((suite) => [suite, files.filter((file) => matchesAny(file, record.suites[suite])).sort()]));
  const migrations = files.filter((file) => matchesAny(file, record.migrations)).length;
  const disagreements = [
    ...SUITES.filter((suite) => inventory[suite].length !== record.counts[suite]).map(
      (suite) => `${suite} holds ${inventory[suite].length} files, the record ${record.counts[suite]}`,
    ),
    ...(migrations !== record.minimums.migrations ? [`the tree holds ${migrations} migrations, the record ${record.minimums.migrations}`] : []),
    ...(inventory.pgtap.length !== record.minimums.pgtapFiles ? [`the tree holds ${inventory.pgtap.length} pgTAP files, the record's floor is ${record.minimums.pgtapFiles}`] : []),
  ];
  if (disagreements.length > 0) throw new Error(`the base ${base} disagrees with its approved record: ${disagreements.join("; ")}`);

  const reason = "the base has no selector: its approved bootstrap record names the tests and floors";
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode: "full",
    executionPolicy: "full execution; the base's approved bootstrap record",
    lane: "critical",
    identity: { base, head, inventoryRev: base, baseTree: tree, problems: [] },
    selector: { bootstrapRecord: sha256(canonicalJson(record)) },
    changes: [],
    risk: "high",
    domains: [],
    fullReasons: [reason],
    selection: {
      ...Object.fromEntries(SUITES.map((suite) => [suite, { mode: "full", files: inventory[suite], excluded: [], fullReasons: [reason], reasons: {} }])),
      migrationChain: { mode: "full" },
      advisors: { mode: "full" },
    },
    execution: {
      ...Object.fromEntries(SUITES.map((suite) => [suite, { mode: "full", files: inventory[suite] }])),
      migrationChain: { mode: "full" },
      advisors: { mode: "full" },
      projects: RESPONSIVE_PROJECTS,
    },
    inventory,
    minimums: record.minimums,
    retiredTests: [],
    benchmarks: { e2e: [], integration: [] },
    expectedJobs: EXPECTED_JOBS,
    baseline: `${reason}, checked against the base's tree`,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** Every file in a commit's tree, without needing it checked out. */
/** @param {(args: string[]) => string} git @param {string} rev @returns {string[]} */
export function revisionFiles(git, rev) {
  return git(["ls-tree", "-r", "--name-only", "-z", rev])
    .split("\0")
    .filter(Boolean)
    .sort();
}

/** @param {any} plan @returns {string} */
export function planDigest(plan) {
  const rest = { ...plan };
  delete rest.digest;
  return sha256(canonicalJson(rest));
}

/** Parses `git diff --name-status -z` output. */
/** @param {string} raw @returns {Array<{ status: string, path: string, oldPath?: string }>} */
export function parseNameStatus(raw) {
  const parts = raw.split("\0").filter((part) => part !== "");
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0];
    if (status === "R" || status === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      changes.push({ status, path, oldPath });
    } else {
      changes.push({ status, path: parts[i++] });
    }
  }
  return changes;
}

/** Parses `git status --porcelain=v1 -z --untracked-files=all` into changes with diff-like statuses. */
/** @param {string} raw @returns {Array<{ status: string, path: string, oldPath?: string }>} */
export function parsePorcelain(raw) {
  const parts = raw.split("\0").filter((part) => part !== "");
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const entry = parts[i++];
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      changes.push({ status: "R", path, oldPath: parts[i++] });
    } else if (xy === "??" || xy.includes("A")) {
      changes.push({ status: "A", path });
    } else if (xy.includes("D")) {
      changes.push({ status: "D", path });
    } else {
      changes.push({ status: "M", path });
    }
  }
  return changes;
}

/**
 * Collects the identity and the changes from git. Each doubt becomes an identity problem, which the
 * selector turns into full coverage; nothing here guesses a base.
 */
/** @param {{ git: (args: string[]) => string, base?: string, head?: string, worktree?: boolean, readFile: (path: string) => string | Buffer }} options @returns {{ identity: any, changes: any[] }} */
export function collectIdentity({ git, base, head, worktree = false, readFile }) {
  const problems = [];
  /** @type {any} */
  const identity = { base: base ?? null, head: head ?? null };
  let changes = [];

  try {
    identity.executedCommit = git(["rev-parse", "HEAD"]);
  } catch (error) {
    problems.push(`the checkout's own commit cannot be read: ${error.message}`);
  }
  try {
    if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
      problems.push("the clone is shallow, so ancestry is incomplete");
    }
  } catch {
    problems.push("cannot tell whether the clone is shallow");
  }

  for (const [name, value] of [["base", base], ["head", head]]) {
    if (!value) problems.push(`no ${name} commit was given`);
    else if (!FULL_SHA.test(value)) problems.push(`${name} ${value} is not a full 40-character commit name`);
  }

  if (FULL_SHA.test(base ?? "") && FULL_SHA.test(head ?? "")) {
    try {
      git(["cat-file", "-e", `${base}^{commit}`]);
      git(["cat-file", "-e", `${head}^{commit}`]);
      identity.baseTree = git(["rev-parse", `${base}^{tree}`]);
      identity.headTree = git(["rev-parse", `${head}^{tree}`]);
      identity.mergeBase = git(["merge-base", base, head]);
      changes = parseNameStatus(git(["diff", "--name-status", "-M", "-z", base, head]));
    } catch (error) {
      problems.push(`base or head is missing from the clone's history: ${error.message}`);
    }
  }

  if (identity.executedCommit && head && identity.executedCommit !== head) {
    problems.push(`the checkout is at ${identity.executedCommit}, not at head ${head}`);
  }

  identity.worktreeDigest = null;
  if (worktree) {
    try {
      const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const local = parsePorcelain(status);
      const hash = createHash("sha256").update(status);
      for (const change of local) {
        if (change.status !== "D") hash.update(`\0${change.path}\0${sha256(readFile(change.path))}`);
      }
      identity.worktreeDigest = hash.digest("hex");
      const known = new Set(changes.map((change) => change.path));
      for (const change of local) if (!known.has(change.path)) changes.push(change);
    } catch (error) {
      problems.push(`the working tree cannot be read: ${error.message}`);
    }
  }

  identity.proven = problems.length === 0;
  identity.problems = problems;
  return { identity, changes };
}

/** A plan that requires every test, for when even the selector could not run. */
/** @param {any} options @returns {any} */
export function fallbackPlan({ manifest, files, reason, identity = {} }) {
  const inventory = discoverInventory(".", manifest, files);
  const suites = Object.fromEntries(
    SUITES.map((suite) => [
      suite,
      { mode: "full", files: inventory[suite], excluded: [], fullReasons: [reason], reasons: {} },
    ]),
  );
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode: "full",
    executionPolicy: "full execution; the selector failed",
    lane: "critical",
    identity: { ...identity, problems: [...(identity.problems ?? []), reason] },
    selector: {},
    changes: [],
    risk: "high",
    domains: [],
    fullReasons: [reason],
    selection: { ...suites, migrationChain: { mode: "full" }, advisors: { mode: "full" } },
    execution: {
      ...Object.fromEntries(SUITES.map((suite) => [suite, { mode: "full", files: inventory[suite] }])),
      migrationChain: { mode: "full" },
      advisors: { mode: "full" },
      projects: RESPONSIVE_PROJECTS,
    },
    inventory,
    minimums: manifest.minimums ?? {},
    retiredTests: manifest.retiredTests ?? [],
    benchmarks: benchmarkEntries(manifest),
    expectedJobs: EXPECTED_JOBS,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** @param {string[]} argv @returns {any} */
export function runSelectCli(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const known = new Set(["base", "head", "mode", "output", "worktree", "manifest", "inventory-rev", "baseline", "max-shards"]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  if (!args.output || args.output === true) throw new Error("--output <plan.json> is required");
  // How many parallel E2E jobs the caller can run. One by default: a local run has one stack.
  const maxShards = args["max-shards"] === undefined ? 1 : Number(args["max-shards"]);
  if (!Number.isInteger(maxShards) || maxShards < 1) throw new Error("--max-shards must be a whole number, 1 or more");

  const manifestPath = typeof args.manifest === "string" ? args.manifest : resolve(root, "scripts/testing/manifest.json");
  const manifest = readJson(manifestPath);
  const git = gitRunner(root);

  // --baseline writes the approved base's plan (baselinePlan) instead of the head's. It never falls
  // back: a base it cannot plan is an error, and the gate refuses a run without a baseline.
  if (args.baseline === true) {
    const plan = baselinePlan({ root, git, base: String(args.base ?? ""), head: String(args.head ?? "") });
    mkdirSync(dirname(resolve(args.output)), { recursive: true });
    writeFileSync(args.output, `${canonicalJson(plan)}\n`);
    return plan;
  }

  // --inventory-rev plans over another commit's tree, unchecked out: CI uses it to take the approved
  // base's own test inventory, so tests a pull request deletes still count against it. Only a full
  // plan can be made that way, because the import graph needs the files' contents.
  const inventoryRev = typeof args["inventory-rev"] === "string" ? args["inventory-rev"] : null;
  if (inventoryRev && args.mode !== "full") throw new Error("--inventory-rev needs --mode full");
  const files = inventoryRev ? revisionFiles(git, inventoryRev) : repositoryFiles(git).filter((path) => existsSync(resolve(root, path)));
  const readText = (path) => readFileSync(resolve(root, path), "utf8");

  let plan;
  try {
    const { identity, changes } = collectIdentity({
      git,
      base: typeof args.base === "string" ? args.base : undefined,
      head: typeof args.head === "string" ? args.head : undefined,
      worktree: args.worktree === true,
      readFile: (path) => readFileSync(resolve(root, path)),
    });
    // The gate checks that a base plan was made over the base it holds the change to.
    if (inventoryRev) identity.inventoryRev = inventoryRev;
    const { edges, unresolved } = inventoryRev ? { edges: new Map(), unresolved: [] } : buildGraph(files, readText);
    plan = selectTests({
      manifest,
      files,
      edges,
      changes,
      unresolved,
      mode: typeof args.mode === "string" ? args.mode : "shadow",
      maxShards,
      identity,
      selector: {
        selectorDigest: selectorDigest(root),
        manifestDigest: sha256(readFileSync(manifestPath)),
        manifestVersion: manifest.version,
      },
    });
  } catch (error) {
    if (/selective enforcement is not activated|unknown mode/.test(error.message)) throw error;
    plan = fallbackPlan({
      manifest,
      files,
      reason: `selector error: ${error.message}`,
      identity: inventoryRev ? { base: args.base, head: args.head, inventoryRev } : {},
    });
  }

  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${canonicalJson(plan)}\n`);
  return plan;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const plan = runSelectCli(process.argv.slice(2));
    const line = (suite) => `${suite}: ${plan.selection[suite].mode} (${plan.selection[suite].files.length} of ${plan.inventory[suite].length})`;
    console.log(`test:select · risk ${plan.risk} · ${plan.executionPolicy}`);
    for (const suite of SUITES) console.log(`  ${line(suite)}`);
    if (plan.mode === "enforce") {
      const runs = (suite) => `${suite} ${plan.execution[suite].mode === "none" ? "not needed" : `${plan.execution[suite].files.length} file(s)`}`;
      console.log(`  will run: ${SUITES.map(runs).join(" · ")} · jobs ${plan.expectedJobs.join(", ")}`);
    }
    for (const reason of plan.fullReasons) console.log(`  full because: ${reason}`);
  } catch (error) {
    console.error(`test:select refused: ${error.message}`);
    process.exit(2);
  }
}
