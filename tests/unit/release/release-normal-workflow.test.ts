// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the normal-release workflow is allowed to be, and what a tag can start in this repository. The
 * controller cannot prove either: who can start the workflow, which job holds which token, what runs beside
 * it, and which workflows a tag push, a tag creation or a release would trigger. These are checked as parsed
 * YAML under GitHub's documented trigger rules. GitHub's own evaluation, and the Vercel and Supabase
 * integrations outside this repository, are not simulated: inspecting those is an activation prerequisite.
 */

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string> | string;
  concurrency?: unknown;
  steps?: Step[];
  "runs-on"?: string;
};
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

const load = (file: string) => {
  const text = readFileSync(`.github/workflows/${file}`, "utf8");
  return { file, text, workflow: parse(text) as Workflow };
};
const workflows = readdirSync(".github/workflows")
  .filter((file) => /\.ya?ml$/.test(file))
  .map(load);
const normal = load("release-normal-tag.yml");
const writer = load("release-tag-writer.yml");

const ACTIVATED = "vars.RELEASE_NORMAL_PUBLICATION == 'enabled'";
const conjuncts = (condition: string | undefined) => (condition ?? "").split("&&").map((part) => part.replace(/\s+/g, " ").trim());

/** GitHub's filter glob: `**` matches anything, `*` anything but `/`. */
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").split("\u0000").join(".*")}$`);

type Event =
  | { name: "push"; ref: string }
  | { name: "create"; refType: "tag" | "branch" }
  | { name: "release"; action: string }
  | { name: "pull_request" }
  | { name: "workflow_run"; workflow: string; branch: string }
  | { name: "workflow_dispatch" };

/**
 * Whether a workflow's `on` starts a run for an event, under GitHub's rules: a push filter that names only
 * branches never matches a tag push, and one that names only tags never matches a branch push.
 */
function triggers(on: Record<string, unknown>, event: Event) {
  if (!Object.hasOwn(on, event.name)) return false;
  const filter = (on[event.name] ?? {}) as Record<string, string[] | undefined>;
  switch (event.name) {
    case "push": {
      const hasBranches = filter.branches !== undefined || filter["branches-ignore"] !== undefined;
      const hasTags = filter.tags !== undefined || filter["tags-ignore"] !== undefined;
      const tag = event.ref.startsWith("refs/tags/");
      const name = event.ref.replace(/^refs\/(heads|tags)\//, "");
      if (tag) {
        if (!hasTags && hasBranches) return false;
        if (filter.tags) return filter.tags.some((p) => glob(p).test(name));
        if (filter["tags-ignore"]) return !filter["tags-ignore"].some((p) => glob(p).test(name));
        return true;
      }
      if (!hasBranches && hasTags) return false;
      if (filter.branches) return filter.branches.some((p) => glob(p).test(name));
      if (filter["branches-ignore"]) return !filter["branches-ignore"].some((p) => glob(p).test(name));
      return true;
    }
    case "workflow_run": {
      const f = filter as { workflows?: string[]; branches?: string[] };
      return (f.workflows ?? []).includes(event.workflow) && (!f.branches || f.branches.some((p) => glob(p).test(event.branch)));
    }
    default:
      return true;
  }
}

const started = (event: Event) => workflows.filter(({ workflow }) => triggers(workflow.on, event)).map(({ file }) => file).sort();

/** Every job a workflow can run, following calls to reusable workflows in this repository. */
function reachableJobs(file: string): Array<{ file: string; id: string; job: Job }> {
  const { workflow } = load(file);
  return Object.entries(workflow.jobs).flatMap(([id, job]) =>
    job.uses?.startsWith("./.github/workflows/")
      ? [{ file, id, job }, ...reachableJobs(job.uses.slice("./.github/workflows/".length))]
      : [{ file, id, job }],
  );
}

const ALLOWED_ACTIONS = /^(actions\/(checkout|setup-node|upload-artifact|download-artifact)|supabase\/setup-cli)@/;
const HOSTED = /secrets\.|vercel|--linked|db push|supabase link|--project-ref|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|bootstrap[:-]director|\bdeploy\b|psql|curl|wget/i;

describe("the normal-release workflow", () => {
  it("is started only by hand, with the request as typed string inputs, and runs only from main", () => {
    expect(Object.keys(normal.workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = (normal.workflow.on.workflow_dispatch as { inputs: Record<string, { required: boolean; type: string; default?: string }> }).inputs;
    expect(Object.keys(inputs)).toEqual([
      "sha",
      "version",
      "preparation-pr",
      "deployment",
      "review",
      "production-acceptance",
      "owner-approval",
      "hosted-migration",
    ]);
    for (const [name, input] of Object.entries(inputs)) {
      expect(input.type, name).toBe("string");
      expect(input.required, name).toBe(true);
      expect(input.default, name).toBe(name === "hosted-migration" ? "none" : undefined);
    }
    expect(normal.workflow.permissions).toEqual({});
    expect(conjuncts(normal.workflow.jobs.evaluate.if)).toEqual([
      "github.event_name == 'workflow_dispatch'",
      "github.ref == 'refs/heads/main'",
    ]);
  });

  it("evaluates in a job that can only read, passing the inputs as data and the runner's run and attempt as the dispatch", () => {
    const evaluate = normal.workflow.jobs.evaluate;
    expect(evaluate.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read", deployments: "read" });
    const step = evaluate.steps!.find((s) => s.id === "evaluate")!;
    expect(step.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      RELEASE_SHA: "${{ inputs.sha }}",
      RELEASE_VERSION: "${{ inputs.version }}",
      PREPARATION_PR: "${{ inputs.preparation-pr }}",
      DEPLOYMENT: "${{ inputs.deployment }}",
      REVIEW_RECORD: "${{ inputs.review }}",
      ACCEPTANCE_RECORD: "${{ inputs.production-acceptance }}",
      APPROVAL_RECORD: "${{ inputs.owner-approval }}",
      HOSTED_MIGRATION_RECORD: "${{ inputs.hosted-migration }}",
    });
    const run = step.run!.replace(/\\\n\s*/g, "");
    expect(run).toContain("node scripts/release/controller.mjs evaluate-release");
    for (const argument of [
      '--sha "$RELEASE_SHA"',
      '--version "$RELEASE_VERSION"',
      '--preparation-pr "$PREPARATION_PR"',
      '--deployment "$DEPLOYMENT"',
      '--review "$REVIEW_RECORD"',
      '--production-acceptance "$ACCEPTANCE_RECORD"',
      '--owner-approval "$APPROVAL_RECORD"',
      '--hosted-migration "$HOSTED_MIGRATION_RECORD"',
      '--dispatch-run-id "$GITHUB_RUN_ID"',
      '--dispatch-run-attempt "$GITHUB_RUN_ATTEMPT"',
      "--main-ref origin/main",
    ]) {
      expect(run, argument).toContain(argument);
    }
    for (const { text, file } of [normal, writer]) {
      for (const job of Object.values(parse(text).jobs as Record<string, Job>)) {
        for (const s of job.steps ?? []) if (s.run) expect(s.run, file).not.toContain("${{");
      }
    }
    // The bundle is made only for an eligible plan in an activated repository.
    for (const s of evaluate.steps!.filter((s) => s.id === "bundle" || s.uses?.startsWith("actions/upload-artifact@"))) {
      expect(conjuncts(s.if)).toEqual([ACTIVATED, "steps.evaluate.outputs.decision == 'eligible'"]);
    }
    const installs = evaluate.steps!.filter((s) => /\bnpm\b/.test(s.run ?? ""));
    expect(installs.map((s) => s.run!.trim())).toEqual(["npm ci --ignore-scripts --no-audit --no-fund"]);
  });

  it("publishes only through the shared tag writer, only when eligible and activated, with the writer's lock", () => {
    const publish = normal.workflow.jobs.publish;
    expect(publish.uses).toBe("./.github/workflows/release-tag-writer.yml");
    expect(publish.steps).toBeUndefined();
    expect(publish.needs).toBe("evaluate");
    expect(conjuncts(publish.if)).toEqual(["needs.evaluate.outputs.decision == 'eligible'", ACTIVATED]);
    expect(publish.with).toEqual({ operation: "normal", "bundle-digest": "${{ needs.evaluate.outputs.bundle-digest }}" });
    expect(publish.permissions).toEqual({ contents: "write", actions: "read", "pull-requests": "read", deployments: "read" });

    const write = writer.workflow.jobs.write;
    expect(write.concurrency).toEqual({ group: "release-tag-writer", "cancel-in-progress": false, queue: "max" });
    expect(write.permissions).toEqual({ contents: "write", actions: "read", "pull-requests": "read", deployments: "read" });
    const step = write.steps!.find((s) => s.id === "write")!;
    expect(step.env?.RELEASE_NORMAL_PUBLICATION).toBe("${{ vars.RELEASE_NORMAL_PUBLICATION }}");
    const normalCase = /\n\s*normal\)\n([\s\S]*?);;/.exec(step.run!)![1].replace(/\\\n\s*/g, "");
    expect(normalCase.trim().split(/\s+/).slice(0, 3)).toEqual(["node", "scripts/release/controller.mjs", "publish-release"]);
    for (const argument of [
      '--plan "$RUNNER_TEMP/bundle/release-plan.json"',
      '--dispatch-run-id "$GITHUB_RUN_ID"',
      '--dispatch-run-attempt "$GITHUB_RUN_ATTEMPT"',
      "--main-ref origin/main",
    ]) {
      expect(normalCase, argument).toContain(argument);
    }
    // The writer's other operation is unchanged and anything else is refused.
    expect(step.run).toMatch(/\n\s*build\)\n\s*node scripts\/release\/controller\.mjs publish-reconciled-builds \\\n/);
    expect(step.run).toMatch(/\*\)\n[^;]*exit 2/);
    // The writer installs nothing and runs only main's controller from a bundle whose digest it checked.
    const download = write.steps!.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"));
    const verify = write.steps!.findIndex((s) => s.run?.includes("sha256sum --check --strict"));
    expect(verify).toBeGreaterThan(download);
    for (const s of write.steps!) {
      expect(s.run ?? "").not.toMatch(/\b(npm|npx|yarn|pnpm|corepack)\b/);
      expect(s.uses ?? "").not.toMatch(/^actions\/cache@/);
    }
  });

  it("pins every action it uses and runs no secret, deployment, migration or production credential", () => {
    for (const { file, workflow } of [normal, writer]) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        // No secret, environment or other credential reaches a job; its scopes are asserted exactly above. The
        // steps name a deployment and a hosted migration record as evidence to read, never as work to do.
        expect(Object.keys(job).filter((key) => ["secrets", "environment", "container", "services"].includes(key)), `${file}#${id}`).toEqual([]);
        for (const step of job.steps ?? []) {
          if (step.uses) expect(step.uses, file).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
          const content = JSON.stringify({ run: step.run, uses: step.uses, with: step.with, env: step.env });
          expect(content, `${file}#${id}`).not.toMatch(/secrets\.|vercel|supabase|\bdeploy\b|\bmigrate\b|pull_request_target|--linked|db push|curl|wget/i);
        }
      }
      expect(Object.keys(workflow.on), file).not.toContain("pull_request_target");
    }
  });
});

describe("what a tag can start", () => {
  it("starts no workflow when a tag is pushed, created or released; a push to main starts only CI", () => {
    expect(started({ name: "push", ref: "refs/tags/v0.0.7" })).toEqual([]);
    expect(started({ name: "push", ref: "refs/tags/v0.0.7-dev.1" })).toEqual([]);
    expect(started({ name: "create", refType: "tag" })).toEqual([]);
    expect(started({ name: "release", action: "published" })).toEqual([]);
    expect(started({ name: "push", ref: "refs/heads/main" })).toEqual(["ci.yml"]);
    expect(started({ name: "workflow_run", workflow: "CI", branch: "main" })).toEqual(["release-build-tag.yml"]);
    expect(started({ name: "workflow_dispatch" })).toEqual(["release-build-tag.yml", "release-normal-tag.yml"]);
    expect(started({ name: "pull_request" })).toEqual(["ci.yml", "release-classification.yml"]);

    // The evaluator is not vacuous: a workflow that did listen for tags would be found.
    expect(triggers({ push: { tags: ["v*"] } }, { name: "push", ref: "refs/tags/v0.0.7" })).toBe(true);
    expect(triggers({ push: null } as Record<string, unknown>, { name: "push", ref: "refs/tags/v0.0.7" })).toBe(true);
    expect(triggers({ push: { branches: ["**"] } }, { name: "push", ref: "refs/tags/v0.0.7" })).toBe(false);
    expect(triggers({ push: { branches: ["**"] } }, { name: "push", ref: "refs/heads/release/v0.0.7" })).toBe(true);
    for (const { file, workflow } of workflows) {
      for (const event of ["create", "release", "delete", "deployment", "deployment_status", "registry_package", "repository_dispatch"]) {
        expect(Object.keys(workflow.on), `${file} ${event}`).not.toContain(event);
      }
    }
  });

  it("runs nothing hosted in any workflow a branch push, a CI completion or a dispatch can start", () => {
    const events: Event[] = [
      { name: "push", ref: "refs/heads/main" },
      { name: "workflow_run", workflow: "CI", branch: "main" },
      { name: "workflow_dispatch" },
      { name: "pull_request" },
    ];
    const files = [...new Set(events.flatMap(started))].sort();
    expect(files).toEqual(["ci.yml", "release-build-tag.yml", "release-classification.yml", "release-normal-tag.yml"]);
    const jobs = files.flatMap(reachableJobs);
    expect(jobs.map(({ file, id }) => `${file}#${id}`)).toContain("release-tag-writer.yml#write");
    for (const { file, id, job } of jobs) {
      for (const step of job.steps ?? []) {
        const where = `${file}#${id} ${step.name ?? step.uses ?? step.run}`;
        if (step.uses) expect(step.uses, where).toMatch(ALLOWED_ACTIONS);
        expect(`${step.run ?? ""}\n${JSON.stringify(step.env ?? {})}\n${JSON.stringify(step.with ?? {})}`, where).not.toMatch(HOSTED);
      }
    }
    // The only database commands start, reset and test the job's own local stack.
    const database = jobs.flatMap(({ job }) => (job.steps ?? []).map((step) => step.run ?? "")).filter((run) => /\bsupabase\b/.test(run));
    for (const run of database) expect(run.trim()).toMatch(/^supabase (start|db reset|test db|db lint --level warning|status -o env)|NEXT_PUBLIC_SUPABASE_URL/);
  });
});
