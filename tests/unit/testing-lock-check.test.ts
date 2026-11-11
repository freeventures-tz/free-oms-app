import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lockProblems } from "@/scripts/testing/lock-check.mjs";

/**
 * The lockfile check CI runs before it reads its package cache.
 *
 * A cache hit skips `npm ci`, and `npm ci` is what refuses a lockfile that no longer matches
 * `package.json`. Without this check a dependency changed in `package.json` alone would be tested
 * against whatever was installed before, and pass.
 */

const pkg = {
  name: "app",
  version: "1.2.3",
  dependencies: { next: "16.3.0", zod: "^4.4.3" },
  devDependencies: { vitest: "^4.1.10" },
};
const lock = {
  name: "app",
  version: "1.2.3",
  lockfileVersion: 3,
  packages: {
    "": { name: "app", version: "1.2.3", dependencies: { next: "16.3.0", zod: "^4.4.3" }, devDependencies: { vitest: "^4.1.10" } },
    "node_modules/next": { version: "16.3.0" },
    "node_modules/zod": { version: "4.4.3" },
    "node_modules/vitest": { version: "4.1.10" },
  },
};

describe("the lockfile check", () => {
  it("passes when the two files agree", () => {
    expect(lockProblems(pkg, lock)).toEqual([]);
  });

  it("refuses a dependency changed in package.json with the lockfile left alone", () => {
    const bumped = { ...pkg, dependencies: { ...pkg.dependencies, next: "16.4.0" } };
    expect(lockProblems(bumped, lock)).toEqual(["dependencies: next is 16.4.0 in package.json and 16.3.0 in package-lock.json"]);
  });

  it("refuses a dependency added to, or removed from, package.json alone", () => {
    const added = { ...pkg, dependencies: { ...pkg.dependencies, lodash: "^4.17.21" } };
    expect(lockProblems(added, lock)).toEqual(["dependencies: lodash@^4.17.21 is in package.json and not in package-lock.json"]);
    const removed = { ...pkg, devDependencies: {} };
    expect(lockProblems(removed, lock)).toEqual(["devDependencies: vitest@^4.1.10 is in package-lock.json and not in package.json"]);
  });

  it("refuses a dependency moved between kinds, which changes what a production install holds", () => {
    const moved = { ...pkg, dependencies: { next: "16.3.0" }, devDependencies: { ...pkg.devDependencies, zod: "^4.4.3" } };
    expect(lockProblems(moved, lock)).toEqual([
      "dependencies: zod@^4.4.3 is in package-lock.json and not in package.json",
      "devDependencies: zod@^4.4.3 is in package.json and not in package-lock.json",
    ]);
  });

  it("refuses a version changed in one file only", () => {
    expect(lockProblems({ ...pkg, version: "1.2.4" }, lock)).toEqual([
      "version: package.json says 1.2.4, package-lock.json says 1.2.3",
      "version: package.json says 1.2.4, package-lock.json's header says 1.2.3",
    ]);
  });

  it("refuses a lockfile that names a dependency and holds no installed entry for it", () => {
    const { "node_modules/zod": _dropped, ...rest } = lock.packages;
    expect(_dropped).toBeDefined();
    expect(lockProblems(pkg, { ...lock, packages: rest })).toEqual(["dependencies: package-lock.json holds no installed entry for zod"]);
  });

  it("refuses a lockfile with no root entry at all", () => {
    expect(lockProblems(pkg, { lockfileVersion: 1 })[0]).toMatch(/has no root entry/);
  });

  it("agrees with this repository's own files", () => {
    const read = (name: string) => JSON.parse(readFileSync(join(process.cwd(), name), "utf8"));
    expect(lockProblems(read("package.json"), read("package-lock.json"))).toEqual([]);
  });
});
