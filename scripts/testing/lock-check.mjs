#!/usr/bin/env node
/**
 * `node scripts/testing/lock-check.mjs`
 *
 * Refuses when `package.json` and `package-lock.json` disagree about what is installed.
 *
 * `npm ci` makes this check itself, and fails when the two are out of step. CI restores
 * `node_modules` from a cache and skips `npm ci` on a hit, so without this a pull request that
 * changed a dependency in `package.json` and left the lockfile alone could be tested against the
 * previous installation and pass. This runs in every job before the cache is read, needs nothing
 * installed, and takes milliseconds.
 *
 * What it compares is what npm writes into the lockfile's root entry (`packages[""]`): the name,
 * the version, and every dependency range of every kind. A direct dependency the lockfile holds no
 * installed entry for is refused as well.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Every way the lockfile disagrees with the manifest. Empty means they agree. */
/** @param {any} pkg @param {any} lock @returns {string[]} */
export function lockProblems(pkg, lock) {
  const problems = [];
  const root = lock?.packages?.[""];
  if (!root) return ["package-lock.json has no root entry (packages[\"\"]): it is not a lockfile npm ci can install"];

  for (const field of ["name", "version"]) {
    if ((pkg?.[field] ?? null) !== (root[field] ?? null)) {
      problems.push(`${field}: package.json says ${pkg?.[field] ?? "(none)"}, package-lock.json says ${root[field] ?? "(none)"}`);
    }
    if ((pkg?.[field] ?? null) !== (lock[field] ?? null)) {
      problems.push(`${field}: package.json says ${pkg?.[field] ?? "(none)"}, package-lock.json's header says ${lock[field] ?? "(none)"}`);
    }
  }

  for (const kind of KINDS) {
    const wanted = pkg?.[kind] ?? {};
    const locked = root[kind] ?? {};
    for (const name of [...new Set([...Object.keys(wanted), ...Object.keys(locked)])].sort()) {
      if (!(name in locked)) problems.push(`${kind}: ${name}@${wanted[name]} is in package.json and not in package-lock.json`);
      else if (!(name in wanted)) problems.push(`${kind}: ${name}@${locked[name]} is in package-lock.json and not in package.json`);
      else if (wanted[name] !== locked[name]) problems.push(`${kind}: ${name} is ${wanted[name]} in package.json and ${locked[name]} in package-lock.json`);
    }
    if (kind === "peerDependencies") continue;
    for (const name of Object.keys(wanted)) {
      if (name in locked && !lock.packages[`node_modules/${name}`]) problems.push(`${kind}: package-lock.json holds no installed entry for ${name}`);
    }
  }
  return problems;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const read = (name) => JSON.parse(readFileSync(resolve(process.cwd(), name), "utf8"));
  let problems;
  try {
    problems = lockProblems(read("package.json"), read("package-lock.json"));
  } catch (error) {
    problems = [`cannot read the manifest or the lockfile: ${error.message}`];
  }
  if (problems.length > 0) {
    console.error("lock-check refused: package.json and package-lock.json disagree. Run `npm install` and commit the lockfile.");
    for (const line of problems) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log("lock-check: package.json and package-lock.json agree");
}
