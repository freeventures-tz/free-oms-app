#!/usr/bin/env node
/**
 * `npm run test:release -- --prepare --output <candidate.json> [--production-base <sha>] [--production-version <x.y.z>]
 *                          [--batch-base <sha>] [--batch-head <sha>] [--pr <n>]...`
 * `npm run test:release -- --manifest <candidate.json> --check-only`
 * `npm run test:release -- --manifest <candidate.json> [--results <dir>] [--benchmarks]`
 *
 * A release candidate is an identity, not a branch name: one commit, one tree, one set of migration
 * files, one version, one configuration and toolchain. `--prepare` writes that identity down.
 * `--manifest` compares the checkout against it and refuses on any drift, then runs every broad
 * suite (static, migration chain, pgTAP, database lint and advisors, integration, build and all three
 * responsive E2E projects) and checks the identity again afterwards, so nothing can change under a
 * run that is still reported as the candidate's.
 *
 * It never tags, merges, deploys, links a hosted project or applies a hosted migration. The
 * `approval` field is filled by the Owner's review, not by this script, and any drift invalidates it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, FULL_SHA, gitRunner, listFiles, parseArgs, readJson, repositoryFiles, selectorDigest, sha256 } from "./common.mjs";
import { evaluateGate, renderSummary } from "./gate.mjs";
import { readResults } from "./reports.mjs";
import { buildSteps, jobsFromOutcomes, runSteps, timingReport } from "./run.mjs";
import { selectTests } from "./select.mjs";
import { buildGraph } from "./graph.mjs";
import { testEnvironment } from "./target-guard.mjs";

export const MANIFEST_KIND = "free-oms-release-candidate";

/** The files whose bytes decide how the app is built, configured, tested and migrated. */
export const CONFIGURATION_FILES = [
  ".env.example",
  "next.config.ts",
  "proxy.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.mts",
  "playwright.config.ts",
  "supabase/config.toml",
  "supabase/advisors.sql",
];

function fileDigest(root, path) {
  return sha256(readFileSync(join(root, path)));
}

/** The first `## [x.y.z]` heading in CHANGELOG.md. */
/** @param {string} text @returns {string | null} */
export function changelogVersion(text) {
  return text.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] ?? null;
}

/** Problems with the release metadata that make the candidate unreleasable as it stands. */
/** @param {any} files @returns {string[]} */
export function metadataProblems({ pkg, lock, changelog }) {
  const problems = [];
  const version = pkg.version;
  if (lock.version !== version) problems.push(`package-lock.json version ${lock.version} is not ${version}`);
  if (lock.packages?.[""]?.version !== version) problems.push(`package-lock.json root package version ${lock.packages?.[""]?.version} is not ${version}`);
  if (changelogVersion(changelog) !== version) problems.push(`CHANGELOG.md's newest entry is ${changelogVersion(changelog)}, not ${version}`);
  return problems;
}

/** Digest of the built app, from every file under .next/server and .next/static, path by path. */
export function artifactDigest(root) {
  const hash = createHash("sha256");
  let count = 0;
  for (const dir of [".next/server", ".next/static"]) {
    const full = join(root, dir);
    if (!existsSync(full)) return null;
    for (const file of listFiles(full)) {
      hash.update(`${dir}/${file}\0`);
      hash.update(readFileSync(join(full, file)));
      count++;
    }
  }
  const buildId = join(root, ".next", "BUILD_ID");
  if (existsSync(buildId)) hash.update(`BUILD_ID\0${readFileSync(buildId)}`);
  return { digest: hash.digest("hex"), files: count };
}

/** Every `uses:` line in the workflows, which pins the actions a CI run executes. */
function workflowActions(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const uses = new Set();
  for (const name of readdirSync(dir).sort()) {
    for (const match of readFileSync(join(dir, name), "utf8").matchAll(/uses:\s*([^\s#]+)/g)) uses.add(match[1]);
  }
  return [...uses].sort();
}

/** The identity of the checkout as it stands. Refuses a dirty tree, which has no commit to name. */
/** @param {string} root @param {(args: string[]) => string} git @param {Record<string, string | undefined>} [env] @returns {any} */
export function describeCandidate(root, git, env = process.env) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const pkg = readJson(join(root, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const migrationDir = join(root, "supabase", "migrations");
  const migrations = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: fileDigest(root, `supabase/migrations/${file}`) }));
  const releaseDir = join(root, "supabase", "release-checks");
  const releasedHistory = readdirSync(releaseDir)
    .filter((name) => statSync(join(releaseDir, name)).isFile())
    .sort()
    .map((file) => ({ file, sha256: fileDigest(root, `supabase/release-checks/${file}`) }));
  const workflows = existsSync(join(root, ".github", "workflows"))
    ? readdirSync(join(root, ".github", "workflows")).sort().map((name) => `.github/workflows/${name}`)
    : [];

  return {
    clean: status === "",
    dirtyPaths: status === "" ? [] : status.split("\n").map((line) => line.slice(3)),
    identity: {
      candidate: { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
      version: { package: pkg.version, lockfile: lock.version, lockfileRoot: lock.packages?.[""]?.version ?? null, changelog: changelogVersion(changelog) },
      migrations: { count: migrations.length, files: migrations },
      releasedHistory,
      configuration: Object.fromEntries(
        [...CONFIGURATION_FILES, ...workflows].filter((path) => existsSync(join(root, path))).map((path) => [path, fileDigest(root, path)]),
      ),
      toolchain: {
        node: process.versions.node,
        supabaseCli: pkg.devDependencies?.supabase ?? null,
        next: pkg.dependencies?.next ?? null,
        playwright: lock.packages?.["node_modules/@playwright/test"]?.version ?? null,
        vitest: lock.packages?.["node_modules/vitest"]?.version ?? null,
        actions: workflowActions(root),
      },
      // Public build-time values only, and only as digests: an artifact built against a test stack
      // is not the production artifact, and this is how a reviewer tells them apart. Secrets are
      // never read here.
      buildEnvironment: Object.fromEntries(
        Object.keys(env)
          .filter((name) => name.startsWith("NEXT_PUBLIC_"))
          .sort()
          .map((name) => [name, sha256(env[name] ?? "")]),
      ),
      testPolicy: { selectorDigest: selectorDigest(root) },
    },
    metadata: metadataProblems({ pkg, lock, changelog }),
  };
}

/** Each difference between what the manifest recorded and what the checkout holds. */
/** @param {any} expected @param {any} actual @param {string} [path] @returns {string[]} */
export function identityDrift(expected, actual, path = "") {
  const drift = [];
  if (expected === actual) return drift;
  if (typeof expected !== "object" || typeof actual !== "object" || expected === null || actual === null) {
    drift.push(`${path || "(root)"}: recorded ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
    return drift;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    drift.push(`${path}: shape changed`);
    return drift;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) drift.push(...identityDrift(expected[key], actual[key], path ? `${path}.${key}` : key));
  return drift;
}

/** Every reason the checkout cannot be treated as the manifest's candidate. */
/** @param {any} manifest @param {any} described @returns {string[]} */
export function candidateRefusals(manifest, described) {
  const refusals = [];
  if (manifest?.kind !== MANIFEST_KIND) refusals.push(`not a ${MANIFEST_KIND} manifest`);
  if (manifest?.schemaVersion !== 1) refusals.push("manifest schema is not 1");
  if (!FULL_SHA.test(manifest?.identity?.candidate?.commit ?? "")) refusals.push("manifest names no full candidate commit");
  if (!described.clean) refusals.push(`the working tree is not clean: ${described.dirtyPaths.slice(0, 10).join(", ")}`);
  refusals.push(...described.metadata.map((problem) => `metadata: ${problem}`));
  const drift = identityDrift(manifest?.identity ?? {}, described.identity);
  refusals.push(...drift.map((line) => `drift: ${line}`));
  if (drift.length > 0 && manifest?.approval) refusals.push("the recorded approval no longer applies: the identity it approved has changed");
  if (manifest?.identity?.migrations?.count < (manifest?.minimums?.migrations ?? 0)) refusals.push("fewer migrations than the released history requires");
  return refusals;
}

/** @param {any} described @param {any} [extra] @returns {any} */
export function prepareManifest(described, extra = {}) {
  return {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    identity: described.identity,
    minimums: extra.minimums ?? {},
    production: { base: extra.productionBase ?? null, version: extra.productionVersion ?? null },
    batch: { base: extra.batchBase ?? null, head: extra.batchHead ?? null, pullRequests: extra.pullRequests ?? [] },
    artifact: null,
    evidence: [],
    approval: null,
  };
}

export function runReleaseCli(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const known = new Set([
    "prepare", "output", "manifest", "check-only", "results", "benchmarks",
    "production-base", "production-version", "batch-base", "batch-head", "pr",
  ]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  const git = gitRunner(root);
  const described = describeCandidate(root, git, testEnvironment(root));
  const minimums = readJson(join(root, "scripts/testing/manifest.json")).minimums;

  if (args.prepare === true) {
    if (typeof args.output !== "string") throw new Error("--output <candidate.json> is required");
    if (!described.clean) throw new Error(`the working tree is not clean: ${described.dirtyPaths.slice(0, 10).join(", ")}`);
    if (described.metadata.length > 0) throw new Error(described.metadata.join("; "));
    if (described.identity.migrations.count < minimums.migrations) throw new Error("fewer migrations than the released history requires");
    const manifest = prepareManifest(described, {
      minimums,
      productionBase: typeof args["production-base"] === "string" ? args["production-base"] : null,
      productionVersion: typeof args["production-version"] === "string" ? args["production-version"] : null,
      batchBase: typeof args["batch-base"] === "string" ? args["batch-base"] : null,
      batchHead: typeof args["batch-head"] === "string" ? args["batch-head"] : null,
      pullRequests: typeof args.pr === "string" ? [args.pr] : [],
    });
    writeFileSync(args.output, `${canonicalJson(manifest)}\n`);
    return { prepared: manifest };
  }

  if (typeof args.manifest !== "string") throw new Error("--prepare or --manifest <candidate.json> is required");
  const manifest = readJson(args.manifest);
  const before = candidateRefusals(manifest, described);
  if (before.length > 0) throw new Error(`candidate refused:\n  - ${before.join("\n  - ")}`);
  if (args["check-only"] === true) return { checked: true };

  const files = repositoryFiles(git).filter((path) => existsSync(join(root, path)));
  const { edges } = buildGraph(files, (path) => readFileSync(join(root, path), "utf8"));
  const plan = selectTests({
    manifest: readJson(join(root, "scripts/testing/manifest.json")),
    files,
    edges,
    changes: [],
    mode: "full",
    identity: {
      base: manifest.production.base,
      head: manifest.identity.candidate.commit,
      executedCommit: described.identity.candidate.commit,
      proven: false,
      problems: [],
    },
    selector: { selectorDigest: selectorDigest(root) },
  });

  const resultsDir = resolve(root, typeof args.results === "string" ? args.results : "oms-test/release");
  const { steps } = buildSteps(plan, "release", { benchmarks: args.benchmarks === true });
  const { ok, outcomes } = runSteps(steps, { root, resultsDir });
  const artifact = artifactDigest(root);

  const after = candidateRefusals(manifest, describeCandidate(root, git, testEnvironment(root)));
  const { reports, problems } = readResults(resultsDir, root);
  const decision = evaluateGate({
    plan,
    jobs: jobsFromOutcomes(outcomes, plan.expectedJobs),
    reports,
    reportProblems: [...problems, ...after.map((line) => `identity changed during the run: ${line}`)],
    knownSkips: readJson(join(root, "scripts/testing/known-skips.json")).skips,
    expect: { head: manifest.identity.candidate.commit, selectorDigest: selectorDigest(root) },
    gate: "Release Gate",
  });
  const evidence = {
    candidate: manifest.identity.candidate,
    manifestDigest: sha256(canonicalJson(manifest)),
    artifact,
    benchmarks: args.benchmarks === true,
    timing: timingReport(outcomes, []),
    decision,
  };
  writeFileSync(join(resultsDir, "release-evidence.json"), `${canonicalJson(evidence)}\n`);
  return { ok: ok && decision.pass, evidence, decision };
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = runReleaseCli(process.argv.slice(2));
    if (result.prepared) {
      console.log(`test:release: candidate ${result.prepared.identity.candidate.commit} written`);
      process.exit(0);
    }
    if (result.checked) {
      console.log("test:release: the checkout is the manifest's candidate");
      process.exit(0);
    }
    console.log(renderSummary(result.decision));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`test:release refused: ${error.message}`);
    process.exit(2);
  }
}
