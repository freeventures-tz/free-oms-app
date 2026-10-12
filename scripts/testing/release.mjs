#!/usr/bin/env node
/**
 * `npm run test:release -- --prepare --output <candidate.json> [--production-base <sha>] [--production-version <x.y.z>]
 *                          [--batch-base <sha>] [--batch-head <sha>] [--pr <n>]...`
 * `npm run test:release -- --manifest <candidate.json> --check-only`
 * `npm run test:release -- --manifest <candidate.json> [--results <dir>] [--keep-going]`
 * `npm run test:release -- --describe-artifact --output <artifact.json>`
 * `npm run test:release -- --manifest <candidate.json> --bind --gate-report <file> --artifact <file> --output <final.json> [--run-id <id>]`
 *
 * A release candidate is an identity, not a branch name: one commit, one tree, one set of migration
 * files, one version, one configuration and toolchain. `--prepare` writes that identity down.
 * `--manifest` compares the checkout against it and refuses on any drift, then runs every broad
 * suite (static, migration chain, pgTAP, database lint and advisors, integration, build and all three
 * responsive E2E projects, with the opt-in benchmarks on) and checks the identity again afterwards,
 * so nothing can change under a run that is still reported as the candidate's.
 *
 * Evidence is bound to the build it tested. The E2E step records that build (`--describe-artifact`);
 * a passing Release Gate on it produces the final manifest (`candidate-final.json` locally, `--bind`
 * in CI), which names the build and the decision. `--check-only` on a final manifest refuses any
 * other build, and an approval stands only on passing evidence for this commit and build.
 *
 * It never tags, merges, deploys, links a hosted project or applies a hosted migration. The
 * `approval` field is filled by the Owner's review, not by this script, and any drift invalidates it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, FULL_SHA, gitRunner, listFiles, parseArgs, readJson, repositoryFiles, selectorDigest, sha256 } from "./common.mjs";
import { evaluateGate, renderSummary } from "./gate.mjs";
import { readResults } from "./reports.mjs";
import { buildSteps, jobsFromOutcomes, runSteps, timingReport } from "./run.mjs";
import { baselinePlan, selectTests } from "./select.mjs";
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

/** The files Next's incremental cache writes for one prerendered route, beside its compiled code. */
const CACHE_ENTRY_SUFFIXES = {
  ".next/server/app": [".html", ".rsc", ".prefetch.rsc", ".meta", ".body"],
  ".next/server/pages": [".html", ".json"],
};

/**
 * The files under `.next/server` that a running server rewrites: the incremental cache's entry for
 * each route the build prerendered, as `.next/prerender-manifest.json` lists them. `next start`
 * writes these back after a revalidation (a server action's `revalidatePath` is enough), with the
 * same body and a re-serialised `.meta`, so they belong to the server's cache, not to the build. The
 * compiled code that produces them, and the manifest that names them, stay in the digest.
 */
/** @param {string} root @returns {(path: string) => boolean} */
export function runtimeCacheFiles(root) {
  const manifestPath = join(root, ".next", "prerender-manifest.json");
  if (!existsSync(manifestPath)) return () => false;
  const stems = Object.keys(readJson(manifestPath).routes ?? {}).map((route) => (route === "/" ? "index" : route.replace(/^\//, "")));
  const exact = new Set();
  const segmentDirs = [];
  for (const [dir, suffixes] of Object.entries(CACHE_ENTRY_SUFFIXES)) {
    for (const stem of stems) {
      for (const suffix of suffixes) exact.add(`${dir}/${stem}${suffix}`);
    }
  }
  for (const stem of stems) segmentDirs.push(`.next/server/app/${stem}.segments/`);
  return (path) => exact.has(path) || segmentDirs.some((prefix) => path.startsWith(prefix));
}

/**
 * Digest of the built app: every file under .next/server and .next/static, path by path, the build
 * id and the prerender manifest, leaving out only the incremental cache a running server rewrites
 * (`runtimeCacheFiles`). Without that exclusion the build recorded before E2E was a different
 * artifact once E2E had served it, so no later check could match the build that was tested.
 */
export function artifactDigest(root) {
  const hash = createHash("sha256");
  const isCache = runtimeCacheFiles(root);
  let count = 0;
  let cacheFiles = 0;
  for (const dir of [".next/server", ".next/static"]) {
    const full = join(root, dir);
    if (!existsSync(full)) return null;
    for (const file of listFiles(full)) {
      if (isCache(`${dir}/${file}`)) {
        cacheFiles++;
        continue;
      }
      hash.update(`${dir}/${file}\0`);
      hash.update(readFileSync(join(full, file)));
      count++;
    }
  }
  const buildId = join(root, ".next", "BUILD_ID");
  if (existsSync(buildId)) hash.update(`BUILD_ID\0${readFileSync(buildId)}`);
  const prerender = join(root, ".next", "prerender-manifest.json");
  if (existsSync(prerender)) hash.update(`prerender-manifest.json\0${readFileSync(prerender)}`);
  return { digest: hash.digest("hex"), files: count, cacheFiles };
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

/**
 * The build in `.next`, named: the commit and tree it was built from, whether the tree was clean,
 * its digest, and digests of the public build values it was built with. Null when there is no build.
 */
/** @param {string} root @param {(args: string[]) => string} git @param {Record<string, string | undefined>} [env] @returns {any} */
export function describeArtifact(root, git, env = process.env) {
  const built = artifactDigest(root);
  if (!built) return null;
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    clean: git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    digest: built.digest,
    files: built.files,
    cacheFiles: built.cacheFiles,
    buildEnvironment: Object.fromEntries(
      Object.keys(env)
        .filter((name) => name.startsWith("NEXT_PUBLIC_"))
        .sort()
        .map((name) => [name, sha256(env[name] ?? "")]),
    ),
  };
}

/**
 * Every reason the checkout cannot be treated as the manifest's candidate.
 *
 * Once a manifest names the build that was tested (`artifact`), the checkout's build must be that
 * build. An approval stands only while nothing has drifted and while the manifest holds passing
 * Release Gate evidence for exactly this commit and build.
 */
/** @param {any} manifest @param {any} described @param {{ artifact?: any }} [current] @returns {string[]} */
export function candidateRefusals(manifest, described, { artifact = null } = {}) {
  const refusals = [];
  if (manifest?.kind !== MANIFEST_KIND) refusals.push(`not a ${MANIFEST_KIND} manifest`);
  if (manifest?.schemaVersion !== 1) refusals.push("manifest schema is not 1");
  if (!FULL_SHA.test(manifest?.identity?.candidate?.commit ?? "")) refusals.push("manifest names no full candidate commit");
  if (!described.clean) refusals.push(`the working tree is not clean: ${described.dirtyPaths.slice(0, 10).join(", ")}`);
  refusals.push(...described.metadata.map((problem) => `metadata: ${problem}`));
  const drift = identityDrift(manifest?.identity ?? {}, described.identity).map((line) => `drift: ${line}`);
  if (manifest?.artifact) {
    if (!artifact) {
      drift.push("drift: the manifest names a tested build, and this checkout has no build (a fresh build is a different artifact)");
    } else {
      for (const key of ["commit", "digest", "files"]) {
        if (artifact[key] !== manifest.artifact[key]) drift.push(`drift: artifact.${key}: recorded ${JSON.stringify(manifest.artifact[key])}, found ${JSON.stringify(artifact[key])}`);
      }
      drift.push(...identityDrift(manifest.artifact.buildEnvironment ?? {}, artifact.buildEnvironment ?? {}, "artifact.buildEnvironment").map((line) => `drift: ${line}`));
    }
  }
  refusals.push(...drift);
  if (manifest?.approval) {
    if (drift.length > 0) refusals.push("the recorded approval no longer applies: the identity it approved has changed");
    const passing = (manifest.evidence ?? []).some(
      (entry) =>
        entry.pass === true &&
        entry.gate === "Release Gate" &&
        entry.head === manifest.identity?.candidate?.commit &&
        manifest.artifact &&
        entry.artifactDigest === manifest.artifact.digest,
    );
    if (!passing) refusals.push("the recorded approval has no passing Release Gate evidence for this commit and build");
  }
  if (manifest?.identity?.migrations?.count < (manifest?.minimums?.migrations ?? 0)) refusals.push("fewer migrations than the released history requires");
  return refusals;
}

/**
 * How the build in `.next` now differs from the one recorded before E2E served it. Empty when it is
 * the same build, which is what lets a later check, or a deployment, name the build that was tested.
 */
/** @param {any} recorded @param {any} current @returns {string[]} */
export function artifactDrift(recorded, current) {
  if (!current) return ["the tested build is gone from .next"];
  return ["commit", "digest", "files"]
    .filter((key) => current[key] !== recorded[key])
    .map((key) => `artifact.${key}: recorded ${JSON.stringify(recorded[key])}, found ${JSON.stringify(current[key])}`);
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

/**
 * The final manifest: the prepared one, plus the build that was tested and the Release Gate decision
 * that tested it. Refused unless that decision passed, for this commit, on this build.
 */
/** @param {any} manifest @param {{ artifact: any, decision: any, source: string, runId?: string | null }} evidence @returns {{ refusals: string[], final: any }} */
export function bindEvidence(manifest, { artifact, decision, source, runId = null }) {
  const commit = manifest?.identity?.candidate?.commit;
  const refusals = [];
  if (!decision) refusals.push("no Release Gate decision");
  else {
    if (decision.gate !== "Release Gate") refusals.push(`the decision is a ${decision.gate}, not a Release Gate`);
    if (decision.pass !== true) refusals.push("the Release Gate did not pass");
    if (decision.head !== commit) refusals.push(`the Release Gate tested ${decision.head}, not ${commit}`);
  }
  if (!artifact) refusals.push("no tested build was recorded");
  else {
    if (artifact.commit !== commit) refusals.push(`the recorded build is of ${artifact.commit}, not ${commit}`);
    if (artifact.clean !== true) refusals.push("the recorded build was made from a working tree with changes");
    if (decision?.artifact && decision.artifact.digest !== artifact.digest) refusals.push("the gate saw a different build from the one recorded here");
  }
  if (manifest?.artifact && artifact && manifest.artifact.digest !== artifact.digest) refusals.push("the manifest already names a different build");
  if (refusals.length > 0) return { refusals, final: null };
  return {
    refusals,
    final: {
      ...manifest,
      artifact: { commit: artifact.commit, tree: artifact.tree, digest: artifact.digest, files: artifact.files, buildEnvironment: artifact.buildEnvironment },
      evidence: [
        ...(manifest.evidence ?? []),
        {
          gate: decision.gate,
          pass: decision.pass,
          head: decision.head,
          artifactDigest: artifact.digest,
          decisionDigest: sha256(canonicalJson(decision)),
          source,
          runId,
        },
      ],
      approval: null,
    },
  };
}

function option(args, name) {
  return typeof args[name] === "string" ? args[name] : null;
}

export function runReleaseCli(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const known = new Set([
    "prepare", "output", "manifest", "check-only", "results", "keep-going",
    "production-base", "production-version", "batch-base", "batch-head", "pr",
    "describe-artifact", "bind", "gate-report", "artifact", "run-id",
  ]);
  for (const name of Object.keys(args)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  const git = gitRunner(root);
  const env = testEnvironment(root);

  if (args["describe-artifact"] === true) {
    const output = option(args, "output");
    if (!output) throw new Error("--output <artifact.json> is required");
    const artifact = describeArtifact(root, git, env);
    if (!artifact) throw new Error("there is no build in .next to describe; run npm run build first");
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, `${canonicalJson(artifact)}\n`);
    return { described: artifact };
  }

  const described = describeCandidate(root, git, env);
  const minimums = readJson(join(root, "scripts/testing/manifest.json")).minimums;

  if (args.prepare === true) {
    const output = option(args, "output");
    if (!output) throw new Error("--output <candidate.json> is required");
    if (!described.clean) throw new Error(`the working tree is not clean: ${described.dirtyPaths.slice(0, 10).join(", ")}`);
    if (described.metadata.length > 0) throw new Error(described.metadata.join("; "));
    if (described.identity.migrations.count < minimums.migrations) throw new Error("fewer migrations than the released history requires");
    const manifest = prepareManifest(described, {
      minimums,
      productionBase: option(args, "production-base"),
      productionVersion: option(args, "production-version"),
      batchBase: option(args, "batch-base"),
      batchHead: option(args, "batch-head"),
      pullRequests: option(args, "pr") ? [option(args, "pr")] : [],
    });
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, `${canonicalJson(manifest)}\n`);
    return { prepared: manifest };
  }

  const manifestPath = option(args, "manifest");
  if (!manifestPath) throw new Error("--prepare, --describe-artifact or --manifest <candidate.json> is required");
  const manifest = readJson(manifestPath);

  // CI: bind the Release Gate's decision and the E2E job's recorded build to the manifest.
  if (args.bind === true) {
    const output = option(args, "output");
    const gateReport = option(args, "gate-report");
    const artifactPath = option(args, "artifact");
    if (!output || !gateReport || !artifactPath) throw new Error("--bind needs --gate-report, --artifact and --output");
    const before = candidateRefusals(manifest, described);
    const decision = existsSync(gateReport) ? readJson(gateReport) : null;
    const artifact = existsSync(artifactPath) ? readJson(artifactPath) : null;
    const { refusals, final } = bindEvidence(manifest, { artifact, decision, source: "ci", runId: option(args, "run-id") });
    const all = [...before, ...refusals];
    if (all.length > 0) throw new Error(`evidence refused:\n  - ${all.join("\n  - ")}`);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, `${canonicalJson(final)}\n`);
    return { bound: final };
  }

  const before = candidateRefusals(manifest, described, { artifact: describeArtifact(root, git, env) });
  if (before.length > 0) throw new Error(`candidate refused:\n  - ${before.join("\n  - ")}`);
  if (args["check-only"] === true) return { checked: true };
  if (manifest.artifact) throw new Error("this manifest already holds a tested build; prepare a new one to test again");

  const files = repositoryFiles(git).filter((path) => existsSync(join(root, path)));
  const { edges, unresolved } = buildGraph(files, (path) => readFileSync(join(root, path), "utf8"));
  const plan = selectTests({
    manifest: readJson(join(root, "scripts/testing/manifest.json")),
    files,
    edges,
    unresolved,
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

  // The approved base's minimum, planned over its own tree. A candidate without a production base
  // has none, and is refused before anything runs rather than gated against its own rules.
  let basePlan;
  try {
    basePlan = baselinePlan({ root, git, base: manifest.production.base, head: manifest.identity.candidate.commit });
  } catch (error) {
    throw new Error(`candidate refused: no baseline: ${error.message}`);
  }

  const resultsDir = resolve(root, option(args, "results") ?? "oms-test/release");
  const { steps } = buildSteps(plan, "release");
  const { ok, outcomes } = runSteps(steps, { root, resultsDir, keepGoing: args["keep-going"] === true });

  const after = candidateRefusals(manifest, describeCandidate(root, git, testEnvironment(root)));
  const { reports, listings, artifact, problems } = readResults(resultsDir, root);
  const served = artifact ? artifactDrift(artifact, describeArtifact(root, git, env)) : [];
  const decision = evaluateGate({
    plan,
    basePlan,
    jobs: { plan: { result: "success" }, ...jobsFromOutcomes(outcomes, plan.expectedJobs) },
    reports,
    listings,
    artifact,
    reportProblems: [...problems, ...[...after, ...served].map((line) => `identity changed during the run: ${line}`)],
    knownSkips: readJson(join(root, "scripts/testing/known-skips.json")).skips,
    expect: { head: manifest.identity.candidate.commit, selectorDigest: selectorDigest(root) },
    gate: "Release Gate",
  });
  const { refusals, final } = bindEvidence(manifest, { artifact, decision, source: "local" });
  const evidence = {
    candidate: manifest.identity.candidate,
    manifestDigest: sha256(canonicalJson(manifest)),
    artifact,
    benchmarks: true,
    timing: timingReport(outcomes, []),
    decision,
    bindRefusals: refusals,
  };
  writeFileSync(join(resultsDir, "release-evidence.json"), `${canonicalJson(evidence)}\n`);
  if (final) writeFileSync(join(resultsDir, "candidate-final.json"), `${canonicalJson(final)}\n`);
  return { ok: ok && decision.pass && Boolean(final), evidence, decision };
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = runReleaseCli(process.argv.slice(2));
    if (result.prepared) {
      console.log(`test:release: candidate ${result.prepared.identity.candidate.commit} written`);
      process.exit(0);
    }
    if (result.described) {
      console.log(`test:release: build ${result.described.digest} of ${result.described.commit} recorded`);
      process.exit(0);
    }
    if (result.bound) {
      console.log(`test:release: evidence bound to candidate ${result.bound.identity.candidate.commit}`);
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
