/**
 * Small pieces the selector, the plan runner, the gate and the release check all share.
 *
 * Nothing here touches a database or the network. Git is reached only through a runner the caller
 * passes in, so every decision that depends on git can be tested with a fake one.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const PLAN_SCHEMA_VERSION = 1;

/** The three device tiers every responsive test runs on (playwright.config.ts). */
export const RESPONSIVE_PROJECTS = ["mobile", "tablet", "desktop"];

/** A full 40-character commit name. Abbreviations are refused: they can become ambiguous. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * JSON with keys sorted at every level, so the same plan always produces the same bytes and the
 * same digest, whatever order its fields were built in.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function toPosix(path) {
  return path.split(sep).join("/").replaceAll("\\", "/");
}

/**
 * A glob as a regular expression. Supports `**` (any depth, including none), `*` (within one path
 * segment), `?` and `{a,b}`. Deliberately small: the manifest is reviewed, and a pattern this does
 * not understand fails to match, which leaves the path unmapped and forces full coverage.
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else {
      out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** @param {string} path @param {string[]} globs */
export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Every file under `root` (repository-relative, POSIX separators), skipping generated folders. */
export function listFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) listFiles(root, full, out);
    else out.push(toPosix(relative(root, full)));
  }
  return out.sort();
}

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  ".worktrees",
  "playwright-report",
  "test-results",
  "coverage",
  "oms-test",
  ".base-policy",
]);

/**
 * The files the selector plans over: tracked files plus untracked ones git does not ignore, which
 * is what a commit (or, locally, the next commit) would hold. Ignored local files such as
 * `.env.local` or run fixtures never enter a plan.
 */
/** @param {(args: string[]) => string} git @returns {string[]} */
export function repositoryFiles(git) {
  return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .sort();
}

/** The test files a suite holds on disk, from the suite globs in the manifest. */
/** @param {string} root @param {any} manifest @param {string[]} [files] @returns {Record<string, string[]>} */
export function discoverInventory(root, manifest, files = listFiles(root)) {
  const inventory = {};
  for (const [suite, globs] of Object.entries(manifest.suites)) {
    inventory[suite] = files.filter((file) => matchesAny(file, globs)).sort();
  }
  return inventory;
}

/** Runs git and returns trimmed stdout, or throws with stderr. */
/** @param {string} cwd @returns {(args: string[]) => string} */
export function gitRunner(cwd) {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
    }
    return (result.stdout ?? "").replace(/\s+$/, "");
  };
}

/** Digest of the selector's own source and manifest, so a plan can be tied to the rules that made it. */
export function selectorDigest(root) {
  const dir = join(root, "scripts", "testing");
  const files = readdirSync(dir)
    .filter((name) => /\.(mjs|json)$/.test(name))
    .sort();
  return sha256(files.map((name) => `${name}\n${sha256(readFileSync(join(dir, name)))}`).join("\n"));
}

/** @param {string} path @returns {any} */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `--name value` and `--flag` pairs. Unknown shapes are kept, and each CLI refuses what it does not know. */
/** @param {string[]} argv @returns {Record<string, string | true>} */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return args;
}
