#!/usr/bin/env node
/**
 * `npm run test:select -- --base <sha> --head <sha> [--mode shadow|full|enforce] [--worktree] --output <plan.json>`
 *
 * Decides which tests a change needs, from the diff, the import graph and the reviewed manifest, and
 * writes that decision down as a plan. It never touches a database.
 *
 * The plan has two halves. `selection` is what the rules say the change needs. `execution` is what a
 * gate will require to have run. Until the Owner activates selective enforcement, `execution` is the
 * full suite every time and `selection` is reported beside it (shadow mode), so the rules can be
 * measured against full runs before anything depends on them.
 *
 * Every doubt resolves to full coverage, with the reason written into the plan: an unknown or
 * missing base, a shallow clone, a path no rule names, a rename or deletion, an unexpected test
 * inventory, a stale or malformed manifest, or any error inside the selector itself.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
export function selectTests({ manifest, files, edges, changes, mode = "shadow", identity = {}, selector = {} }) {
  if (!["shadow", "full", "enforce"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode === "enforce" && manifest?.activation?.selectiveEnforcement !== true) {
    throw new Error("selective enforcement is not activated; plan with --mode shadow or --mode full");
  }

  const inventory = discoverInventory(".", manifest, files);
  const fullReasons = [...(identity.problems ?? [])];
  const suiteFull = Object.fromEntries(SUITES.map((suite) => [suite, []]));
  const reasons = Object.fromEntries(SUITES.map((suite) => [suite, {}]));
  const selected = Object.fromEntries(SUITES.map((suite) => [suite, new Set()]));
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
        }
        if (suite !== "unit") raise("medium");
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
    for (const reached of reverseClosure(edges, [path])) {
      const suite = suiteOf(reached, manifest);
      if (!suite || reached === path || !inventory[suite].includes(reached)) continue;
      selected[suite].add(reached);
      addReason(reasons[suite], reached, `imports ${path}`);
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
  selection.migrationChain = { mode: "full", reason: "the historical chain always runs in full" };
  selection.advisors = { mode: "full", reason: "database lint and advisors always run" };

  const enforced = mode === "enforce" && manifest.activation?.selectiveEnforcement === true;
  const execution = {};
  for (const suite of SUITES) {
    execution[suite] = enforced
      ? { mode: selection[suite].mode, files: selection[suite].files }
      : { mode: "full", files: inventory[suite] };
  }
  execution.migrationChain = { mode: "full" };
  execution.advisors = { mode: "full" };
  execution.projects = RESPONSIVE_PROJECTS;

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode,
    executionPolicy: enforced
      ? "selective enforcement (Owner-activated)"
      : "full execution; the selection is reported in shadow",
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
    expectedJobs: EXPECTED_JOBS,
  };
  return { ...plan, digest: planDigest(plan) };
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
    expectedJobs: EXPECTED_JOBS,
  };
  return { ...plan, digest: planDigest(plan) };
}

/** @param {string[]} argv @returns {any} */
export function runSelectCli(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const known = new Set(["base", "head", "mode", "output", "worktree", "manifest"]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  if (!args.output || args.output === true) throw new Error("--output <plan.json> is required");

  const manifestPath = typeof args.manifest === "string" ? args.manifest : resolve(root, "scripts/testing/manifest.json");
  const manifest = readJson(manifestPath);
  const git = gitRunner(root);
  const files = repositoryFiles(git).filter((path) => existsSync(resolve(root, path)));
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
    const { edges } = buildGraph(files, readText);
    plan = selectTests({
      manifest,
      files,
      edges,
      changes,
      mode: typeof args.mode === "string" ? args.mode : "shadow",
      identity,
      selector: {
        selectorDigest: selectorDigest(root),
        manifestDigest: sha256(readFileSync(manifestPath)),
        manifestVersion: manifest.version,
      },
    });
  } catch (error) {
    if (/selective enforcement is not activated|unknown mode/.test(error.message)) throw error;
    plan = fallbackPlan({ manifest, files, reason: `selector error: ${error.message}` });
  }

  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${canonicalJson(plan)}
`);
  return plan;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const plan = runSelectCli(process.argv.slice(2));
    const line = (suite) => `${suite}: ${plan.selection[suite].mode} (${plan.selection[suite].files.length} of ${plan.inventory[suite].length})`;
    console.log(`test:select · risk ${plan.risk} · ${plan.executionPolicy}`);
    for (const suite of SUITES) console.log(`  ${line(suite)}`);
    for (const reason of plan.fullReasons) console.log(`  full because: ${reason}`);
  } catch (error) {
    console.error(`test:select refused: ${error.message}`);
    process.exit(2);
  }
}
