// @vitest-environment node
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY, REPOSITORY_ID, useBuildFixture } from "./support/build-harness";
import { runController } from "./support/run-controller";

/**
 * The writing jobs install nothing. They receive main's controller and exactly the packages
 * `runtime-dependencies` lists, prepared by a job that cannot write. This proves the list is complete
 * and nothing more.
 */

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".mjs") ? [join(dir, entry.name)] : [],
  );

const packageOf = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

describe("the writer bundle", { timeout: 180_000 }, () => {
  it("lists exactly the packages the controller imports, with everything the lockfile installs for them", async () => {
    const imports = new Set(
      sourceFiles("scripts/release").flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)]
          .map((match) => match[1])
          .filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."))
          .map(packageOf),
      ),
    );

    const listed = await runController(["runtime-dependencies", "--format", "json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const { roots, paths } = JSON.parse(listed.stdout) as { roots: string[]; paths: string[] };

    expect([...imports].sort()).toEqual([...roots].sort());
    expect(paths).toEqual([
      "node_modules/@simple-libs/stream-utils",
      "node_modules/argue-cli",
      "node_modules/conventional-commits-parser",
      "node_modules/semver",
    ]);

    const lines = await runController(["runtime-dependencies"]);
    expect(lines.stdout).toBe(`${paths.join("\n")}\n`);
  });

  describe("run from the bundle alone", () => {
    const fixture = useBuildFixture();

    it("evaluates and publishes with nothing but main's controller and the listed packages", async () => {
      const bundle = mkdtempSync(join(tmpdir(), "release-bundle-"));
      try {
        cpSync("scripts/release", join(bundle, "scripts/release"), { recursive: true });
        const listed = await runController(["runtime-dependencies"]);
        for (const path of listed.stdout.split("\n").filter(Boolean)) {
          cpSync(path, join(bundle, path), { recursive: true });
        }
        const controller = join(bundle, "scripts/release/controller.mjs");

        // A package the bundle does not carry cannot be resolved from it.
        expect(() =>
          execFileSync(process.execPath, ["--input-type=module", "-e", "await import('@testing-library/jest-dom')"], {
            cwd: join(bundle, "scripts/release"),
            stdio: "pipe",
          }),
        ).toThrow();

        const { state } = fixture;
        const { pr33 } = fixture.releasedHistory();
        const run = fixture.ci(pr33.mergeSha);
        state.checkout.sync();
        const scope = ["--repo", REPOSITORY, "--repo-id", String(REPOSITORY_ID), "--main-ref", "origin/main", "--path", state.checkout.dir];
        const options = { cwd: bundle, controller, env: fixture.environment("enabled") };

        const evaluation = await runController(
          ["evaluate-build", ...scope, "--sha", pr33.mergeSha, "--run-id", String(run), "--format", "json"],
          options,
        );
        expect(evaluation.code, evaluation.stderr).toBe(0);

        const plan = fixture.writePlan(JSON.parse(evaluation.stdout));
        const publication = await runController(["publish-build", ...scope, "--plan", plan, "--format", "json"], options);
        expect(publication.code, publication.stderr).toBe(0);
        expect(JSON.parse(publication.stdout)).toMatchObject({ decision: "tagged", tag: { name: "v0.0.7-dev.1" } });
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    });
  });
});
