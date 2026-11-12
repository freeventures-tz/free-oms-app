import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactDigest,
  artifactDrift,
  bindEvidence,
  candidateRefusals,
  changelogVersion,
  describeArtifact,
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

describe("R1: evidence is bound to the build it tested", () => {
  const artifact = { commit: COMMIT, tree: TREE, clean: true, digest: "a".repeat(64), files: 120, buildEnvironment: { NEXT_PUBLIC_SUPABASE_URL: "x" } };
  const passing = { gate: "Release Gate", pass: true, head: COMMIT, artifact, refusals: [] };

  it("binds a passing Release Gate and its build into the final manifest", () => {
    const { refusals, final } = bindEvidence(manifest, { artifact, decision: passing, source: "local" });
    expect(refusals).toEqual([]);
    expect(final.artifact).toEqual({ commit: COMMIT, tree: TREE, digest: artifact.digest, files: 120, buildEnvironment: artifact.buildEnvironment });
    expect(final.evidence).toEqual([expect.objectContaining({ gate: "Release Gate", pass: true, head: COMMIT, artifactDigest: artifact.digest, source: "local" })]);
    expect(final.approval).toBeNull();
    // The final manifest accepts the same build and refuses any other.
    expect(candidateRefusals(final, described, { artifact })).toEqual([]);
  });

  it("refuses to bind a failed gate, a Development Gate, another commit, or a build from a dirty tree", () => {
    const bind = (overrides: { artifact?: unknown; decision?: unknown }) =>
      bindEvidence(manifest, { artifact, decision: passing, source: "ci", ...overrides }).refusals;
    expect(bind({ decision: { ...passing, pass: false } })).toContain("the Release Gate did not pass");
    expect(bind({ decision: { ...passing, gate: "Development Gate" } })).toContain("the decision is a Development Gate, not a Release Gate");
    expect(bind({ decision: { ...passing, head: "d".repeat(40) } })).toContain(`the Release Gate tested ${"d".repeat(40)}, not ${COMMIT}`);
    expect(bind({ artifact: { ...artifact, clean: false } })).toContain("the recorded build was made from a working tree with changes");
    expect(bind({ artifact: null })).toContain("no tested build was recorded");
    expect(bind({ decision: { ...passing, artifact: { ...artifact, digest: "b".repeat(64) } } })).toContain(
      "the gate saw a different build from the one recorded here",
    );
  });

  it("refuses a different build than the one the final manifest names (the review's altered-artifact probe)", () => {
    const { final } = bindEvidence(manifest, { artifact, decision: passing, source: "local" });
    const altered = { ...artifact, digest: "c".repeat(64) };
    expect(candidateRefusals(final, described, { artifact: altered })).toEqual([
      `drift: artifact.digest: recorded "${"a".repeat(64)}", found "${"c".repeat(64)}"`,
    ]);
    expect(candidateRefusals(final, described, { artifact: null })[0]).toMatch(/has no build/);
    const otherEnv = { ...artifact, buildEnvironment: { NEXT_PUBLIC_SUPABASE_URL: "y" } };
    expect(candidateRefusals(final, described, { artifact: otherEnv })).toHaveLength(1);
  });

  it("withdraws an approval when the build drifts, and refuses an approval with no passing evidence", () => {
    const { final } = bindEvidence(manifest, { artifact, decision: passing, source: "local" });
    const approved = { ...final, approval: { approver: "Owner", operations: ["promote"] } };
    expect(candidateRefusals(approved, described, { artifact })).toEqual([]);
    expect(candidateRefusals(approved, described, { artifact: { ...artifact, digest: "c".repeat(64) } })).toContain(
      "the recorded approval no longer applies: the identity it approved has changed",
    );
    const noEvidence = { ...manifest, approval: { approver: "Owner" } };
    expect(candidateRefusals(noEvidence, described)).toContain("the recorded approval has no passing Release Gate evidence for this commit and build");
    const failedEvidence = { ...approved, evidence: [{ ...approved.evidence[0], pass: false }] };
    expect(candidateRefusals(failedEvidence, described, { artifact })).toContain(
      "the recorded approval has no passing Release Gate evidence for this commit and build",
    );
  });

  it("describes a build by commit, cleanliness, digest and public build values only", () => {
    const root = mkdtempSync(join(tmpdir(), "oms-artifact-"));
    expect(describeArtifact(root, fakeGit(), {})).toBeNull();
    for (const dir of [".next/server", ".next/static"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, ".next/server/page.js"), "one");
    writeFileSync(join(root, ".next/static/chunk.js"), "two");
    const first = describeArtifact(root, fakeGit(), { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "never" });
    expect(first).toMatchObject({ commit: COMMIT, tree: TREE, clean: true, files: 2 });
    expect(Object.keys(first.buildEnvironment)).toEqual(["NEXT_PUBLIC_SUPABASE_URL"]);
    writeFileSync(join(root, ".next/static/chunk.js"), "changed");
    expect(describeArtifact(root, fakeGit(), {}).digest).not.toBe(first.digest);
    expect(describeArtifact(root, fakeGit(" M lib/money.ts"), {}).clean).toBe(false);
  });
});

/**
 * Review HOLD on `972d4f3`: the build recorded before E2E (`bce31c60…`) was described as `bad0e845…`
 * after E2E had served it, though nothing was rebuilt. `next start` had rewritten two files of its
 * incremental cache, `favicon.ico.meta` and `manifest.webmanifest.meta`, after a revalidation: same
 * bodies, the `.meta` re-serialised. Putting the build-time bytes back gave `bce31c60…` exactly. The
 * bytes below are the ones observed.
 */
describe("a build that has been served", () => {
  const BUILT_META =
    '{"status":200,"headers":{"cache-control":"public, max-age=0, must-revalidate","content-type":"image/x-icon","x-next-cache-tags":"_N_T_/layout,_N_T_/favicon.ico/layout,_N_T_/favicon.ico/route,_N_T_/favicon.ico"}}';
  const SERVED_META = `{
  "headers": {
    "cache-control": "public, max-age=0, must-revalidate",
    "content-type": "image/x-icon",
    "x-next-cache-tags": "_N_T_/layout,_N_T_/favicon.ico/layout,_N_T_/favicon.ico/route,_N_T_/favicon.ico"
  },
  "status": 200
}`;

  function built(routes: string[] = ["/_global-error", "/favicon.ico", "/manifest.webmanifest"]) {
    const root = mkdtempSync(join(tmpdir(), "oms-served-"));
    const write = (path: string, body: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    write(".next/BUILD_ID", "mW0btgZ6EkvkqP7VI2Cjb");
    write(".next/prerender-manifest.json", JSON.stringify({ version: 4, routes: Object.fromEntries(routes.map((r) => [r, {}])), dynamicRoutes: {} }));
    write(".next/server/app/favicon.ico/route.js", "compiled favicon route");
    write(".next/server/app/favicon.ico.body", "icon bytes");
    write(".next/server/app/favicon.ico.meta", BUILT_META);
    write(".next/server/app/manifest.webmanifest.body", '{"name":"Free Ventures OMS"}');
    write(".next/server/app/manifest.webmanifest.meta", '{"status":200}');
    write(".next/server/app/_global-error.html", "<html>error</html>");
    write(".next/server/app/_global-error.rsc", "rsc");
    write(".next/server/app/_global-error.segments/_full.segment.rsc", "segment");
    write(".next/server/app/orders/page.js", "compiled orders page");
    write(".next/server/pages/500.html", "<html>500</html>");
    write(".next/static/chunks/main.js", "client chunk");
    return { root, write };
  }

  it("is the same artifact after the server rewrites its incremental cache", () => {
    const { root, write } = built();
    const before = artifactDigest(root)!;
    expect(before).toMatchObject({ files: 4, cacheFiles: 7 });

    write(".next/server/app/favicon.ico.meta", SERVED_META);
    write(".next/server/app/manifest.webmanifest.meta", '{\n  "status": 200\n}');
    write(".next/server/app/_global-error.segments/_full.segment.rsc", "regenerated segment");
    write(".next/server/app/_global-error.html", "<html>regenerated</html>");
    expect(artifactDigest(root)).toEqual(before);

    const recorded = describeArtifact(root, fakeGit(), {});
    expect(artifactDrift(recorded, describeArtifact(root, fakeGit(), {}))).toEqual([]);
  });

  it("is a different artifact when compiled code, the build id or an unlisted page changes", () => {
    for (const [path, body] of [
      [".next/server/app/favicon.ico/route.js", "tampered favicon route"],
      [".next/server/app/orders/page.js", "tampered orders page"],
      [".next/server/pages/500.html", "<html>tampered</html>"],
      [".next/static/chunks/main.js", "tampered chunk"],
      [".next/BUILD_ID", "another build"],
      // Named like a cache entry, but for a route the build did not prerender: it is the build's.
      [".next/server/app/orders.html", "<html>not prerendered</html>"],
    ]) {
      const { root, write } = built();
      const before = artifactDigest(root)!;
      write(path, body);
      expect(artifactDigest(root)!.digest, path).not.toBe(before.digest);
    }
  });

  it("is a different artifact when the prerender manifest names another route to leave out", () => {
    const { root } = built();
    const widened = built(["/_global-error", "/favicon.ico", "/manifest.webmanifest", "/orders"]);
    widened.write(".next/server/app/orders.html", "<html>hidden?</html>");
    // The same files, the manifest aside: listing a route moves its files out of the digest, and the
    // manifest that does it is itself in the digest, so the build is not the recorded one.
    expect(artifactDigest(widened.root)!.digest).not.toBe(artifactDigest(root)!.digest);
  });

  it("names how the build in .next differs from the one recorded", () => {
    const { root, write } = built();
    const recorded = describeArtifact(root, fakeGit(), {});
    write(".next/server/app/orders/page.js", "rebuilt");
    const drift = artifactDrift(recorded, describeArtifact(root, fakeGit(), {}));
    expect(drift).toEqual([expect.stringMatching(/^artifact\.digest: recorded "[0-9a-f]{64}", found "[0-9a-f]{64}"$/)]);
    expect(artifactDrift(recorded, null)).toEqual(["the tested build is gone from .next"]);
    expect(artifactDrift(recorded, { ...recorded, commit: "d".repeat(40) })).toEqual([
      `artifact.commit: recorded "${COMMIT}", found "${"d".repeat(40)}"`,
    ]);
  });
});

describe("this repository as a candidate", () => {
  it("has consistent 0.12.4 metadata across package, both lockfile fields and the changelog", () => {
    expect(described.metadata).toEqual([]);
    expect(described.identity.version).toEqual({ package: "0.12.4", lockfile: "0.12.4", lockfileRoot: "0.12.4", changelog: "0.12.4" });
  });

  it("holds all 55 migrations, the report migration among them, and the released manifests", () => {
    expect(described.identity.migrations.count).toBe(55);
    expect(described.identity.migrations.files.at(-1).file).toBe("20261006000100_report_imprest_section.sql");
    expect(described.identity.releasedHistory.map((entry: { file: string }) => entry.file)).toContain("v0121_migration_manifest.txt");
  });
});
