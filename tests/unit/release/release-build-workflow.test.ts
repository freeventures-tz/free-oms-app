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
const NORMAL_ACTIVATED = "vars.RELEASE_NORMAL_PUBLICATION == 'enabled'";
const WRITER_CALL = "./.github/workflows/release-tag-writer.yml";

/** The top-level `&&` parts of a condition, with whitespace normalised. */
const conjuncts = (condition: string | undefined) =>
  (condition ?? "").split("&&").map((part) => part.replace(/\s+/g, " ").trim());

/** The top-level `||` alternatives of a condition, each unparenthesised and split into its `&&` parts. */
const alternatives = (condition: string | undefined) =>
  (condition ?? "").split("||").map((alternative) => conjuncts(alternative.trim().replace(/^\(([\s\S]*)\)$/, "$1")));

const everyJob = () =>
  workflows.flatMap(({ file, workflow }) => Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, job })));

describe("the build-tag workflows", () => {
  it("run when CI completes on main or by a recovery dispatch that takes no input; nothing is triggered by a tag, a release or a pull request", () => {
    expect(build.workflow.on).toEqual({
      workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(Object.keys(writer.workflow.on)).toEqual(["workflow_call"]);

    for (const { file, workflow } of workflows) {
      for (const [event, filter] of Object.entries(workflow.on)) {
        expect(["push", "pull_request", "issue_comment", "workflow_run", "workflow_call", "workflow_dispatch"], `${file} ${event}`).toContain(event);
        if (event === "push") expect((filter as Record<string, unknown>)?.tags, file).toBeUndefined();
        // The recovery dispatch, and the Owner's normal-release dispatch (release-normal-workflow.test.ts).
        if (event === "workflow_dispatch") expect(["release-build-tag.yml", "release-normal-tag.yml"]).toContain(file);
        // The standing route, guarded by the Owner id inside it (release-standing-workflow.test.ts).
        if (event === "issue_comment") expect([file, filter]).toEqual(["release-normal-tag-automatic.yml", { types: ["created"] }]);
      }
    }
    const ci = load("ci.yml").workflow;
    expect(ci.on).toEqual({ push: { branches: ["**"] }, pull_request: null });
  });

  it("reconciles only for a push to main by this repository's CI or a dispatch from main, in a job that can only read", () => {
    const evaluate = build.workflow.jobs.evaluate;
    expect(build.workflow.permissions).toEqual({});
    expect(alternatives(evaluate.if)).toEqual([
      ["github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'"],
      [
        "github.event_name == 'workflow_run'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.path == '.github/workflows/ci.yml'",
        "github.event.workflow_run.repository.full_name == github.repository",
        "github.event.workflow_run.head_repository.full_name == github.repository",
      ],
    ]);
    expect(evaluate.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
  });

  it("reconciles the whole window on every run, passing a CI completion only as its trigger; the window is the controller's, not an input", () => {
    const step = build.workflow.jobs.evaluate.steps!.find((s) => s.id === "evaluate")!;
    expect(step.run).toContain("node scripts/release/controller.mjs reconcile-builds");
    expect(step.run).toMatch(/if \[ "\$GITHUB_EVENT_NAME" = "workflow_run" \]; then\n\s*trigger=\(--sha "\$HEAD_SHA" --run-id "\$RUN_ID"\)\n\s*fi\n/);
    expect(step.run).toContain('"${trigger[@]}"');
    expect(step.env).toMatchObject({
      HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
      RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(step.run).toMatch(/case "\$code" in 0\|4\) ;; \*\) exit "\$code" ;; esac/);
    for (const { file, text } of release) expect(text, file).not.toContain("--since");
  });

  it("gives contents: write to exactly one job that runs steps — the writer — under one lock that never cancels or replaces a waiting writer", () => {
    const writing = everyJob().filter(({ job }) => typeof job.permissions === "object" && job.permissions.contents === "write");
    expect(writing.map(({ file, id }) => `${file}#${id}`).sort()).toEqual([
      "release-build-tag.yml#publish",
      "release-normal-tag-automatic.yml#publish",
      "release-normal-tag.yml#publish",
      "release-tag-writer.yml#write",
    ]);
    // Both callers are calls to the one writer, with no steps of their own.
    for (const { file, id, job } of writing.filter(({ file }) => file !== "release-tag-writer.yml")) {
      expect(job.uses, `${file}#${id}`).toBe(WRITER_CALL);
      expect(job.steps, `${file}#${id}`).toBeUndefined();
    }

    const write = writer.workflow.jobs.write;
    expect(writer.workflow.permissions).toEqual({});
    // Deployments are read by the writer's normal operation.
    expect(write.permissions).toEqual({ contents: "write", actions: "read", "pull-requests": "read", deployments: "read" });
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
    // Each caller of the writer is gated on the activation of the operation it asks for.
    for (const { file, id, job } of everyJob().filter(({ job }) => job.uses === WRITER_CALL)) {
      const operation = job.with?.operation;
      expect(["build", "normal"], `${file}#${id}`).toContain(operation);
      expect(conjuncts(job.if), `${file}#${id}`).toContain(operation === "normal" ? NORMAL_ACTIVATED : ACTIVATED);
    }

    const controllerSteps = [
      ...writer.workflow.jobs.write.steps!.filter((s) => s.run?.includes("publish-reconciled-builds")),
      ...jobs.status.steps!.filter((s) => s.run?.includes("write-reconciled-statuses")),
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
    expect(step.run).toMatch(/\n\s*build\)\n\s*node scripts\/release\/controller\.mjs publish-reconciled-builds \\\n/);
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
      // Parsed, so the comments that describe what is absent are not mistaken for it. Permissions are left out:
      // the read-only `deployments` scope is named like a deployment, and every job's scopes are asserted above.
      const content = JSON.stringify({
        ...workflow,
        jobs: Object.fromEntries(Object.entries(workflow.jobs).map(([id, job]) => [id, { ...job, permissions: undefined }])),
      });
      expect(content, file).not.toMatch(/secrets\.|vercel|supabase|deploy|migrat|pull_request_target/i);
    }
  });
});
