/**
 * The application's release metadata: the version in package.json, the lockfile's top-level and root
 * package versions, and the newest release in the changelog.
 *
 * Metadata is read from two places. A commit's copy is immutable: it is what a candidate merge carries.
 * A working tree's copy is what a preparation edits. Either way the version in it is only a claim. The
 * last normal release comes from its annotated tag, and the next version from the accepted merges since
 * that tag. So a package version ahead of the last tag, which is what a merged but unreleased preparation
 * leaves, is labelled as exactly that and never calculated from.
 *
 * Edits change the version strings and nothing else. Each field is found in the text itself, so
 * indentation, key order, line endings and every other value stay byte for byte as they were.
 */

import semver from "semver";

import { parseChangelog } from "./changelog.mjs";
import { ControllerError } from "./errors.mjs";
import { nextVersion, NORMAL_VERSION } from "./version.mjs";

export const PACKAGE_FILE = "package.json";
export const LOCKFILE = "package-lock.json";
export const CHANGELOG_FILE = "CHANGELOG.md";

/** The only files a release preparation may change. */
export const METADATA_FILES = Object.freeze([PACKAGE_FILE, LOCKFILE, CHANGELOG_FILE]);

const BOM = "\uFEFF";
const PACKAGE_VERSION = ["version"];
const LOCK_VERSION = ["version"];
const LOCK_ROOT_VERSION = ["packages", "", "version"];

/**
 * Where the string values at `paths` sit in a JSON text, as `[start, end)` spans that include their
 * quotes. The text must already have parsed. A path that occurs more than once is reported with every
 * occurrence, and a value that is not a string with `null`.
 */
function valueSpans(text, paths) {
  const found = new Map(paths.map((path) => [JSON.stringify(path), []]));
  let i = text.startsWith(BOM) ? 1 : 0;

  const space = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i += 1;
  };
  const string = () => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i += 1;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
  };
  const value = (path) => {
    space();
    const spans = found.get(JSON.stringify(path));
    if (text[i] === '"') {
      const span = string();
      spans?.push(span);
      return;
    }
    spans?.push(null);
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i] === "{";
      const close = object ? "}" : "]";
      i += 1;
      space();
      if (text[i] === close) {
        i += 1;
        return;
      }
      for (let index = 0; ; index += 1) {
        space();
        let key = index;
        if (object) {
          key = string().value;
          space();
          i += 1;
        }
        value([...path, key]);
        space();
        const separator = text[i];
        i += 1;
        if (separator === close) return;
      }
    }
    while (i < text.length && !",}] \t\r\n".includes(text[i])) i += 1;
  };

  value([]);
  return found;
}

function parseJson(text) {
  try {
    return { ok: true, data: JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) };
  } catch (error) {
    return { ok: false, detail: `is not JSON (${error.message})` };
  }
}

/** The one string at a path, or a reason it cannot be used. */
function soleString(spans, path) {
  const list = spans.get(JSON.stringify(path));
  if (list.length === 0) return { ok: false, detail: `has no ${path.map((p) => JSON.stringify(p)).join(" → ")}` };
  if (list.length > 1) return { ok: false, detail: `has ${path.map((p) => JSON.stringify(p)).join(" → ")} more than once` };
  if (list[0] === null) return { ok: false, detail: `has a ${path.map((p) => JSON.stringify(p)).join(" → ")} that is not a string` };
  return { ok: true, span: list[0], value: list[0].value };
}

/** package.json's name and version, or why they cannot be read. */
export function readPackage(text) {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, detail: `${PACKAGE_FILE} ${parsed.detail}` };
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return { ok: false, detail: `${PACKAGE_FILE} is not a JSON object` };
  }
  const spans = valueSpans(text, [PACKAGE_VERSION, ["name"]]);
  const version = soleString(spans, PACKAGE_VERSION);
  if (!version.ok) return { ok: false, detail: `${PACKAGE_FILE} ${version.detail}` };
  const name = soleString(spans, ["name"]);
  return { ok: true, name: name.ok ? name.value : null, version: version.value };
}

/** The lockfile's name and versions, top-level and root package, or why they cannot be read. */
export function readLockfile(text) {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, detail: `${LOCKFILE} ${parsed.detail}` };
  const data = parsed.data;
  if (!data || typeof data !== "object" || !(data.lockfileVersion >= 2) || typeof data.packages?.[""] !== "object") {
    return { ok: false, detail: `${LOCKFILE} must be lockfileVersion 2 or later, with a root package` };
  }
  const spans = valueSpans(text, [LOCK_VERSION, LOCK_ROOT_VERSION, ["name"], ["packages", "", "name"]]);
  for (const path of [LOCK_VERSION, LOCK_ROOT_VERSION]) {
    const field = soleString(spans, path);
    if (!field.ok) return { ok: false, detail: `${LOCKFILE} ${field.detail}` };
  }
  const name = soleString(spans, ["name"]);
  const rootName = soleString(spans, ["packages", "", "name"]);
  return {
    ok: true,
    name: name.ok ? name.value : null,
    rootName: rootName.ok ? rootName.value : null,
    version: soleString(spans, LOCK_VERSION).value,
    rootVersion: soleString(spans, LOCK_ROOT_VERSION).value,
  };
}

/**
 * The text with the strings at `paths` set to `version`, and nothing else changed. The result is parsed
 * again and compared with the original, so an edit that touched anything else cannot be returned.
 */
function withVersion(text, file, paths, version) {
  const spans = valueSpans(text, paths);
  const edits = paths.map((path) => {
    const field = soleString(spans, path);
    if (!field.ok) throw new ControllerError("metadata_unreadable", `${file} ${field.detail}`);
    return field.span;
  });
  let result = text;
  for (const span of [...edits].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, span.start)}${JSON.stringify(version)}${result.slice(span.end)}`;
  }

  const expected = parseJson(text).data;
  for (const path of paths) {
    let parent = expected;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path[path.length - 1]] = version;
  }
  const actual = parseJson(result);
  if (!actual.ok || JSON.stringify(actual.data) !== JSON.stringify(expected)) {
    throw new ControllerError("metadata_edit_unverified", `${file}: setting the version would have changed more than the version`);
  }
  return result;
}

export const setPackageVersion = (text, version) => withVersion(text, PACKAGE_FILE, [PACKAGE_VERSION], version);

export const setLockfileVersion = (text, version) =>
  withVersion(text, LOCKFILE, [LOCK_VERSION, LOCK_ROOT_VERSION], version);

/**
 * The three files as one set of claims, from any source. `read(name)` returns a file's text or null.
 * `problems` lists why the set cannot be trusted as one version, each `unreadable` or `inconsistent`;
 * the fields hold whatever could be read.
 */
export function readMetadata(read) {
  const texts = Object.fromEntries(METADATA_FILES.map((name) => [name, read(name)]));
  const metadata = {
    texts,
    packageVersion: null,
    lockfileVersion: null,
    lockfileRootVersion: null,
    changelogVersion: null,
    changelog: null,
    present: texts[PACKAGE_FILE] !== null,
    problems: [],
  };
  const problem = (code, detail) => metadata.problems.push({ code, detail });

  let pkg = null;
  if (texts[PACKAGE_FILE] === null) problem("unreadable", `${PACKAGE_FILE} is missing`);
  else {
    pkg = readPackage(texts[PACKAGE_FILE]);
    if (pkg.ok) metadata.packageVersion = pkg.version;
    else problem("unreadable", pkg.detail);
  }

  if (texts[LOCKFILE] === null) problem("unreadable", `${LOCKFILE} is missing`);
  else {
    const lock = readLockfile(texts[LOCKFILE]);
    if (!lock.ok) problem("unreadable", lock.detail);
    else {
      metadata.lockfileVersion = lock.version;
      metadata.lockfileRootVersion = lock.rootVersion;
      if (pkg?.ok) {
        if (lock.version !== pkg.version || lock.rootVersion !== pkg.version) {
          problem(
            "inconsistent",
            `${PACKAGE_FILE} says ${pkg.version}, but ${LOCKFILE} says ${lock.version} and its root package ${lock.rootVersion}`,
          );
        }
        if (lock.name !== pkg.name || lock.rootName !== pkg.name) {
          problem("inconsistent", `${LOCKFILE} does not name the package ${JSON.stringify(pkg.name)} at its top level and its root`);
        }
      }
    }
  }

  if (texts[CHANGELOG_FILE] === null) problem("unreadable", `${CHANGELOG_FILE} is missing`);
  else {
    metadata.changelog = parseChangelog(texts[CHANGELOG_FILE]);
    metadata.changelogVersion = metadata.changelog.sections[0]?.version ?? null;
    for (const detail of metadata.changelog.problems) problem("inconsistent", `${CHANGELOG_FILE} ${detail}`);
  }
  return metadata;
}

/** The metadata of a commit, read from Git's objects. */
export function readCommitMetadata(git, sha) {
  return readMetadata((name) => git.fileAt(sha, name));
}

/**
 * How a package version stands against the last normal release, as a label. It says what the version
 * claims; it never changes what is calculated.
 */
export function describeMetadata(metadata, baseVersion) {
  const summary = {
    packageVersion: metadata.packageVersion,
    lockfileVersion: metadata.lockfileVersion,
    lockfileRootVersion: metadata.lockfileRootVersion,
    changelogVersion: metadata.changelogVersion,
    relation: null,
  };
  const version = metadata.packageVersion;
  if (version === null) summary.relation = metadata.present ? "unreadable" : "absent";
  else if (!NORMAL_VERSION.test(version)) summary.relation = "not_a_normal_version";
  else if (metadata.lockfileVersion !== null && (metadata.lockfileVersion !== version || metadata.lockfileRootVersion !== version)) {
    summary.relation = "inconsistent";
  } else {
    const order = semver.compare(version, baseVersion);
    summary.relation = order === 0 ? "last_normal_release" : order > 0 ? "ahead_of_last_normal_release" : "behind_last_normal_release";
  }
  return summary;
}

/**
 * The versions one normal release can reach from `baseVersion` under the policy: patch, minor, and
 * breaking, which is minor during 0.x and major after it. `1.0.0` by stable-contract acceptance is not
 * among them: preparation does not take that acceptance.
 */
export function oneReleaseFrom(baseVersion) {
  const versions = ["patch", "minor", "breaking"].map(
    (highest) => nextVersion({ baseVersion, highest, stableContractAcceptance: null }).version,
  );
  return [...new Set(versions)];
}

/**
 * Whether a version ahead of the last normal release can be a preparation that merged and has not been
 * released: one release step from it, and no higher than what the accepted merges now calculate.
 */
export function isPendingVersion(version, baseVersion, target) {
  return (
    NORMAL_VERSION.test(version) &&
    oneReleaseFrom(baseVersion).includes(version) &&
    semver.gt(version, baseVersion) &&
    semver.lte(version, target)
  );
}
