// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the build-tag workflows are allowed to be. The controller cannot prove any of this about the
 * workflows that run it: which events reach it, which job holds which token, what runs beside that
 * token, whether writers share one lock, and whether an unactivated repository can write at all.
 * These are checked as parsed YAML; GitHub's own evaluation of the workflows is not simulated.
 */

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Concurrency = { group?: string; "cancel-in-progress"?: boolean; queue?: string };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string> | string;
  concurrency?: Concurrency | string;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: unknown; jobs: Record<string, Job> };

const load = (file: string) => {
  const text = readFileSync(`.github/workflows/${file}`, "utf8");
  return { file, text, workflow: parse(text) as Workflow };
};

const workflows = readdirSync(".github/workflows")
  .filter((file) => /\.ya?ml$/.test(file))
  .map(load);
const build = load("release-build-tag.yml");
const writer = load("release-tag-writer.yml");
const release = [build, writer];

const ACTIVATED = "vars.RELEASE_BUILD_PUBLICATION == 'enabled'";
const WRITER_CALL = "./.github/workflows/release-tag-writer.yml";

/** The top-level `&&` parts of a condition, with whitespace normalised. */
const conjuncts = (condition: string | undefined) =>
  (condition ?? "").split("&&").map((part) => part.replace(/\s+/g, " ").trim());

const everyJob = () =>
  workflows.flatMap(({ file, workflow }) => Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, job })));

describe("the build-tag workflows", () => {
  it("run only when CI completes on main; nothing is triggered by a tag, a release, a pull request or by hand", () => {
    expect(build.workflow.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] } });
    expect(Object.keys(writer.workflow.on)).toEqual(["workflow_call"]);

    for (const { file, workflow } of workflows) {
      for (const [event, filter] of Object.entries(workflow.on)) {
        expect(["push", "pull_request", "workflow_run", "workflow_call"], `${file} ${event}`).toContain(event);
        if (event === "push") expect((filter as Record<string, unknown>)?.tags, file).toBeUndefined();
      }
    }
    const ci = load("ci.yml").workflow;
    expect(ci.on).toEqual({ push: { branches: ["**"] }, pull_request: null });
  });

  it("evaluates only a push to main by this repository's CI, in a job that can only read", () => {
    const evaluate = build.workflow.jobs.evaluate;
    expect(build.workflow.permissions).toEqual({});
    expect(conjuncts(evaluate.if)).toEqual([
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
      "github.event.workflow_run.repository.full_name == github.repository",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ]);
    expect(evaluate.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
  });

  it("gives contents: write to exactly one job that runs steps — the writer — under one lock that never cancels or replaces a waiting writer", () => {
    const writing = everyJob().filter(({ job }) => typeof job.permissions === "object" && job.permissions.contents === "write");
    expect(writing.map(({ file, id }) => `${file}#${id}`).sort()).toEqual([
      "release-build-tag.yml#publish",
      "release-tag-writer.yml#write",
    ]);
    const caller = build.workflow.jobs.publish;
    expect(caller.uses).toBe(WRITER_CALL);
    expect(caller.steps).toBeUndefined();

    const write = writer.workflow.jobs.write;
    expect(writer.workflow.permissions).toEqual({});
    expect(write.permissions).toEqual({ contents: "write", actions: "read", "pull-requests": "read" });
    expect(write.concurrency).toEqual({ group: "release-tag-writer", "cancel-in-progress": false, queue: "max" });
    for (const { file, workflow } of workflows) expect(workflow.concurrency, file).toBeUndefined();

    const statusWriters = everyJob().filter(({ job }) => typeof job.permissions === "object" && job.permissions.statuses === "write");
    expect(statusWriters.map(({ file, id }) => `${file}#${id}`)).toEqual(["release-build-tag.yml#status"]);
    // Every scope a job does not name is none. The status job reads what it evaluates again, with its
    // full history, and writes statuses alone.
    expect(build.workflow.jobs.status.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    const statusCheckout = build.workflow.jobs.status.steps!.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(statusCheckout?.with?.["fetch-depth"]).toBe(0);

    // Tags and statuses are written under the one lock, so a status is never decided while a tag is created.
    const lock = { group: "release-tag-writer", "cancel-in-progress": false, queue: "max" };
    const lockedWriters = everyJob().filter(({ job }) => {
      const granted = typeof job.permissions === "object" ? job.permissions : {};
      return job.steps !== undefined && (granted.contents === "write" || granted.statuses === "write");
    });
    expect(lockedWriters.map(({ file, id }) => `${file}#${id}`).sort()).toEqual([
      "release-build-tag.yml#status",
      "release-tag-writer.yml#write",
    ]);
    for (const { file, id, job } of lockedWriters) expect(job.concurrency, `${file}#${id}`).toEqual(lock);

    for (const { file, id, job } of everyJob()) {
      expect(job.permissions, `${file}#${id}`).not.toBe("write-all");
    }
  });

  it("lets nothing write in a repository that has not activated publication, and tells the controller the setting too", () => {
    const { jobs } = build.workflow;
    expect(conjuncts(jobs.publish.if)).toEqual(["needs.evaluate.outputs.decision == 'eligible'", ACTIVATED]);
    expect(conjuncts(jobs.status.if)).toContain(ACTIVATED);
    for (const step of jobs.evaluate.steps!.filter((s) => s.id === "bundle" || s.uses?.startsWith("actions/upload-artifact@"))) {
      expect(step.if).toBe(ACTIVATED);
    }
    for (const { file, id, job } of everyJob().filter(({ job }) => job.uses === WRITER_CALL)) {
      expect(conjuncts(job.if), `${file}#${id}`).toContain(ACTIVATED);
    }

    const controllerSteps = [
      ...writer.workflow.jobs.write.steps!.filter((s) => s.run?.includes("publish-build")),
      ...jobs.status.steps!.filter((s) => s.run?.includes("write-build-status")),
    ];
    expect(controllerSteps).toHaveLength(2);
    for (const step of controllerSteps) {
      expect(step.env?.RELEASE_BUILD_PUBLICATION).toBe("${{ vars.RELEASE_BUILD_PUBLICATION }}");
    }
  });

  it("runs no pull-request or application code while it can write: no checkout of the evaluated commit, no install, no cache, and a bundle whose digest is checked first", () => {
    const writingJobs = [writer.workflow.jobs.write, build.workflow.jobs.status];
    for (const job of writingJobs) {
      const steps = job.steps!;
      const download = steps.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"));
      const verify = steps.findIndex((s) => s.run?.includes("sha256sum --check --strict"));
      const firstNode = steps.findIndex((s) => /\bnode\b/.test(s.run ?? ""));
      expect(download).toBeGreaterThanOrEqual(0);
      expect(steps[download].with?.name).toBe("release-controller-bundle");
      expect(verify).toBeGreaterThan(download);
      expect(firstNode).toBeGreaterThan(verify);
      for (const step of steps) {
        expect(step.run ?? "").not.toMatch(/\b(npm|npx|yarn|pnpm|corepack)\b/);
        expect(step.uses ?? "").not.toMatch(/^actions\/cache@/);
        expect(step.with?.cache).toBeUndefined();
        for (const invocation of (step.run ?? "").match(/\bnode\s+\S+/g) ?? []) {
          expect(invocation).toBe("node scripts/release/controller.mjs");
        }
      }
    }

    for (const { job } of [writer, build].flatMap(({ workflow }) => Object.values(workflow.jobs).map((job) => ({ job })))) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.ref).toBeUndefined();
          expect(step.with?.["persist-credentials"]).toBe(false);
        }
        if (step.run) expect(step.run).not.toContain("${{");
      }
    }

    const evaluateSteps = build.workflow.jobs.evaluate.steps!;
    const installs = evaluateSteps.filter((s) => /\bnpm\b/.test(s.run ?? ""));
    expect(installs.map((s) => s.run!.trim())).toEqual(["npm ci --ignore-scripts --no-audit --no-fund"]);
  });

  it("dispatches the writer's operation from a fixed list, and refuses any other", () => {
    const step = writer.workflow.jobs.write.steps!.find((s) => s.id === "write")!;
    expect(step.env?.OPERATION).toBe("${{ inputs.operation }}");
    expect(step.run).toContain('case "$OPERATION" in');
    expect(step.run).toMatch(/\n\s*build\)\n/);
    expect(step.run).toMatch(/\*\)\n[^;]*exit 2/);
  });

  it("pins every action to a full commit and uses no secret, deployment, database or production credential", () => {
    for (const { file, workflow } of release) {
      for (const job of Object.values(workflow.jobs)) {
        if (job.uses) expect(job.uses, file).toBe(WRITER_CALL);
        for (const step of job.steps ?? []) {
          if (step.uses) expect(step.uses, file).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
      }
      // Parsed, so the comments that describe what is absent are not mistaken for it.
      const content = JSON.stringify(workflow);
      expect(content, file).not.toMatch(/secrets\.|vercel|supabase|deploy|migrat|pull_request_target/i);
    }
  });
});
