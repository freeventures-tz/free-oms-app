/**
 * The packages the controller imports, and every package they need, exactly as the lockfile pins them.
 *
 * The build-tag workflow installs dependencies once, in its evaluation job, which cannot write, with
 * lifecycle scripts disabled. The jobs that write install nothing: they receive these directories in a
 * bundle whose digest they check, and run the controller with them.
 */

import { ControllerError } from "./errors.mjs";

/** Every bare import in scripts/release. A test fails if the sources import anything else. */
export const CONTROLLER_PACKAGES = Object.freeze(["conventional-commits-parser", "semver"]);

/**
 * The `node_modules/...` paths the controller needs, resolved the way Node resolves them: beside the
 * importing package first, then beside each of its parents.
 */
export function runtimeClosure(lockfile, roots = CONTROLLER_PACKAGES) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || !(lockfile.lockfileVersion >= 2)) {
    throw new ControllerError("lockfile_unsupported", "package-lock.json must be lockfileVersion 2 or later");
  }

  const resolve = (from, name) => {
    let dir = from;
    for (;;) {
      const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      if (!dir) return null;
      const parent = dir.lastIndexOf("/node_modules/");
      dir = parent < 0 ? "" : dir.slice(0, parent);
    }
  };

  const seen = new Set();
  const queue = roots.map((name) => {
    const path = resolve("", name);
    if (!path) throw new ControllerError("lockfile_missing_package", `the lockfile does not install ${name}`);
    return path;
  });

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = packages[path];
    if (entry.link) {
      throw new ControllerError("lockfile_link_unsupported", `${path} is a link, not an installed package`);
    }
    if (entry.hasInstallScript) {
      throw new ControllerError(
        "dependency_install_script",
        `${path} has an install script, and the bundle is installed with lifecycle scripts disabled`,
      );
    }
    const optional = new Set([
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.entries(entry.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta?.optional)
        .map(([name]) => name),
    ]);
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const dependency = resolve(path, name);
      if (dependency) queue.push(dependency);
      else if (!optional.has(name)) {
        throw new ControllerError("lockfile_missing_package", `the lockfile does not install ${name}, which ${path} needs`);
      }
    }
  }

  return [...seen].sort();
}
