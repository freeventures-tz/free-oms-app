import { describe, expect, it } from "vitest";

import {
  candidateRefusals,
  changelogVersion,
  describeCandidate,
  identityDrift,
  metadataProblems,
  prepareManifest,
} from "@/scripts/testing/release.mjs";

/**
 * A release candidate is an identity: commit, tree, version, migrations, released history,
 * configuration, toolchain and public build values. These cases change one of them after the
 * manifest was written and require the check to notice, and to withdraw any approval recorded
 * against the old identity.
 *
 * The last block reads THIS repository, so the transition's own metadata (package, both lockfile
 * fields and the changelog) and its migration history are checked by the same function a release
 * would use.
 */

const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);

function fakeGit(status = "") {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key === "status --porcelain=v1 --untracked-files=all") return status;
    if (key === "rev-parse HEAD") return COMMIT;
    if (key === "rev-parse HEAD^{tree}") return TREE;
    throw new Error(`unexpected git ${key}`);
  };
}

const root = process.cwd();
const described = describeCandidate(root, fakeGit(), { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
const manifest = prepareManifest(described, { minimums: { migrations: 55 } });

describe("release candidate identity", () => {
  it("accepts the checkout it was written from", () => {
    expect(candidateRefusals(manifest, described)).toEqual([]);
  });

  it("refuses a dirty working tree", () => {
    const dirty = describeCandidate(root, fakeGit(" M lib/money.ts"), { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(candidateRefusals(manifest, dirty)[0]).toBe("the working tree is not clean: lib/money.ts");
  });

  it("refuses a changed migration, by name", () => {
    const changed = structuredClone(described);
    changed.identity.migrations.files[54].sha256 = "0".repeat(64);
    const refusals = candidateRefusals(manifest, changed);
    expect(refusals).toEqual(["drift: migrations.files.54.sha256: recorded " + JSON.stringify(described.identity.migrations.files[54].sha256) + ', found "' + "0".repeat(64) + '"']);
  });

  it("refuses a different commit, configuration, toolchain or public build value", () => {
    for (const mutate of [
      (d: typeof described) => (d.identity.candidate.commit = "d".repeat(40)),
      (d: typeof described) => (d.identity.configuration["supabase/config.toml"] = "0"),
      (d: typeof described) => (d.identity.toolchain.node = "0.0.0"),
      (d: typeof described) => (d.identity.buildEnvironment.NEXT_PUBLIC_SUPABASE_URL = "0"),
      (d: typeof described) => (d.identity.testPolicy.selectorDigest = "0"),
    ]) {
      const changed = structuredClone(described);
      mutate(changed);
      expect(candidateRefusals(manifest, changed)).toHaveLength(1);
    }
  });

  it("refuses an added migration file", () => {
    const added = structuredClone(described);
    added.identity.migrations.files.push({ file: "20991231000000_new.sql", sha256: "1".repeat(64) });
    added.identity.migrations.count += 1;
    expect(candidateRefusals(manifest, added).length).toBeGreaterThan(0);
  });

  it("withdraws a recorded approval when the identity drifts", () => {
    const approved = { ...manifest, approval: { approver: "Owner", operations: ["merge"] } };
    const changed = structuredClone(described);
    changed.identity.version.package = "9.9.9";
    expect(candidateRefusals(approved, changed)).toContain("the recorded approval no longer applies: the identity it approved has changed");
  });

  it("refuses anything that is not a candidate manifest", () => {
    expect(candidateRefusals({ ...manifest, kind: "other" }, described)[0]).toMatch(/not a free-oms-release-candidate manifest/);
  });

  it("reports drift path by path", () => {
    expect(identityDrift({ a: { b: 1, c: [1, 2] } }, { a: { b: 2, c: [1, 2, 3] } })).toEqual([
      "a.b: recorded 1, found 2",
      "a.c.2: recorded undefined, found 3",
    ]);
  });

  it("finds version disagreements between package, lockfile and changelog", () => {
    expect(changelogVersion("# Changelog\n\n## [1.2.3] — 2026-01-01\n\n## [1.2.2]")).toBe("1.2.3");
    expect(
      metadataProblems({
        pkg: { version: "1.2.3" },
        lock: { version: "1.2.3", packages: { "": { version: "1.2.2" } } },
        changelog: "## [1.2.2] — x",
      }),
    ).toEqual([
      "package-lock.json root package version 1.2.2 is not 1.2.3",
      "CHANGELOG.md's newest entry is 1.2.2, not 1.2.3",
    ]);
  });

  it("records public build values only as digests, and no secret at all", () => {
    const withSecret = describeCandidate(root, fakeGit(), {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SECRET_KEY: "sb_secret_never_recorded",
    });
    expect(Object.keys(withSecret.identity.buildEnvironment)).toEqual(["NEXT_PUBLIC_SUPABASE_URL"]);
    expect(JSON.stringify(withSecret)).not.toContain("sb_secret_never_recorded");
    expect(JSON.stringify(withSecret)).not.toContain("127.0.0.1:54321");
  });
});

describe("this repository as a candidate", () => {
  it("has consistent 0.12.3 metadata across package, both lockfile fields and the changelog", () => {
    expect(described.metadata).toEqual([]);
    expect(described.identity.version).toEqual({ package: "0.12.3", lockfile: "0.12.3", lockfileRoot: "0.12.3", changelog: "0.12.3" });
  });

  it("holds all 55 migrations, the report migration among them, and the released manifests", () => {
    expect(described.identity.migrations.count).toBe(55);
    expect(described.identity.migrations.files.at(-1).file).toBe("20261006000100_report_imprest_section.sql");
    expect(described.identity.releasedHistory.map((entry: { file: string }) => entry.file)).toContain("v0121_migration_manifest.txt");
  });
});
