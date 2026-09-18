// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the standing-release workflow is allowed to be. It is the one workflow in this repository a public
 * event can start, so what matters is not only what it does but what it refuses to reach: a comment from
 * anyone but the Owner must run no job at all, and no job that holds `contents: write` may depend on a
 * guard it does not state itself.
 *
 * The Owner's identity here is a literal in YAML, which the controller cannot check at run time. So the
 * literal is compared with the release-evidence policy's owner, byte for byte, in both directions.
 */

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

const text = readFileSync(".github/workflows/release-normal-tag-automatic.yml", "utf8");
const automatic = parse(text) as Workflow;
const policy = JSON.parse(readFileSync("scripts/release/release-evidence-policy.json", "utf8")) as {
  owner: { login: string; id: number };
  authorization: { "standing-normal-below": string };
};

const ACTIVATED = "vars.RELEASE_NORMAL_PUBLICATION == 'enabled'";
const conjuncts = (condition: string | undefined) => (condition ?? "").split("&&").map((part) => part.replace(/\s+/g, " ").trim());
const OWNER_GUARD = [
  `github.event.comment.user.login == '${policy.owner.login}'`,
  `github.event.comment.user.id == ${policy.owner.id}`,
];

describe("the standing-release workflow", () => {
  it("runs only for a comment created on a pull request by the account the policy names as Owner", () => {
    expect(Object.keys(automatic.on)).toEqual(["issue_comment"]);
    expect(automatic.on.issue_comment).toEqual({ types: ["created"] });
    expect(automatic.permissions).toEqual({});

    // The guard is exactly the policy's Owner: the same login and the same numeric id, and both of them.
    // A login without an id would follow a renamed account; an id without a login would be unreadable.
    expect(conjuncts(automatic.jobs.evaluate.if)).toEqual(["github.event.issue.pull_request != null", ...OWNER_GUARD]);

    // And nothing else in the file names another account, so there is no second, weaker guard anywhere.
    const logins = [...text.matchAll(/comment\.user\.login == '([^']*)'/g)].map((m) => m[1]);
    const ids = [...text.matchAll(/comment\.user\.id == (\d+)/g)].map((m) => Number(m[1]));
    expect(new Set(logins)).toEqual(new Set([policy.owner.login]));
    expect(new Set(ids)).toEqual(new Set([policy.owner.id]));
    expect(logins.length).toBe(ids.length);
  });

  it("gives no job that can write a path that does not state the Owner guard itself", () => {
    for (const [id, job] of Object.entries(automatic.jobs)) {
      const writes = job.permissions?.contents === "write";
      if (!writes) continue;
      // Every writing job repeats the guard, so it is safe read on its own rather than by tracing `needs`.
      expect(conjuncts(job.if), id).toEqual(expect.arrayContaining(OWNER_GUARD));
      expect(conjuncts(job.if), id).toContain(ACTIVATED);
    }
    // The evaluation cannot write, and the publication is the shared writer, never steps of its own.
    expect(automatic.jobs.evaluate.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      deployments: "read",
    });
    expect(automatic.jobs.publish.uses).toBe("./.github/workflows/release-tag-writer.yml");
    expect(automatic.jobs.publish.steps).toBeUndefined();
    expect(automatic.jobs.publish.needs).toBe("evaluate");
    expect(automatic.jobs.publish.with).toEqual({ operation: "normal", "bundle-digest": "${{ needs.evaluate.outputs.bundle-digest }}" });
  });

  it("hands the controller the comment's id as data, and checks out main rather than the pull request", () => {
    const evaluate = automatic.jobs.evaluate;
    const checkout = evaluate.steps!.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    // A pull request's own code is never fetched, so it can never run: the release is main's, whatever the
    // branch the comment happens to sit beside contains.
    expect(checkout.with).toEqual({ ref: "main", "persist-credentials": false, "fetch-depth": 0 });

    const step = evaluate.steps!.find((s) => s.id === "evaluate")!;
    expect(step.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      ACCEPTANCE_COMMENT: "${{ github.event.comment.id }}",
      EVENT_PULL_REQUEST: "${{ github.event.issue.number }}",
    });
    // The comment's body, its author and its author association never reach the controller at all: the only
    // event values it receives are two numbers, and one of them exists only to be contradicted by the API.
    expect(JSON.stringify(step.env)).not.toMatch(/comment\.body|comment\.user|author_association|issue\.title/);

    const run = step.run!.replace(/\\\n\s*/g, "");
    expect(run).toContain("node scripts/release/controller.mjs evaluate-standing-release");
    for (const argument of [
      '--acceptance-comment "$ACCEPTANCE_COMMENT"',
      '--event-pull-request "$EVENT_PULL_REQUEST"',
      '--dispatch-run-id "$GITHUB_RUN_ID"',
      '--dispatch-run-attempt "$GITHUB_RUN_ATTEMPT"',
      "--main-ref origin/main",
    ]) {
      expect(run, argument).toContain(argument);
    }
    // No event value is expanded into a script anywhere in the file.
    for (const job of Object.values(automatic.jobs)) {
      for (const s of job.steps ?? []) if (s.run) expect(s.run).not.toContain("${{");
    }
  });

  it("bundles and publishes only for an eligible plan in an activated repository, and installs once", () => {
    const evaluate = automatic.jobs.evaluate;
    for (const s of evaluate.steps!.filter((s) => s.id === "bundle" || s.uses?.startsWith("actions/upload-artifact@"))) {
      expect(conjuncts(s.if)).toEqual([ACTIVATED, "steps.evaluate.outputs.decision == 'eligible'"]);
    }
    const installs = evaluate.steps!.filter((s) => /\bnpm\b/.test(s.run ?? ""));
    expect(installs.map((s) => s.run!.trim())).toEqual(["npm ci --ignore-scripts --no-audit --no-fund"]);
  });

  it("pins every action and runs no secret, deployment, migration or production credential", () => {
    for (const [id, job] of Object.entries(automatic.jobs)) {
      expect(Object.keys(job).filter((key) => ["secrets", "environment", "container", "services"].includes(key)), id).toEqual([]);
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses, id).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        const content = JSON.stringify({ run: step.run, uses: step.uses, with: step.with, env: step.env });
        expect(content, id).not.toMatch(/secrets\.|vercel|supabase|\bdeploy\b|\bmigrate\b|--linked|db push|curl|wget/i);
      }
    }
    // `pull_request_target` would give a fork's code this workflow's token. It is not here, at any level.
    expect(text).not.toContain("pull_request_target");
  });

  it("agrees with the controller about which workflow a standing release publishes through", async () => {
    const { AUTOMATIC_RELEASE_WORKFLOW, NORMAL_RELEASE_WORKFLOW, modeForVersion } = await import(
      "../../../scripts/release/lib/normal.mjs"
    );
    expect(AUTOMATIC_RELEASE_WORKFLOW.path).toBe(".github/workflows/release-normal-tag-automatic.yml");
    expect(AUTOMATIC_RELEASE_WORKFLOW.event).toBe("issue_comment");
    expect(AUTOMATIC_RELEASE_WORKFLOW.branch).toBe("main");

    // The policy's boundary and the controller's reading of it are the same boundary.
    const below = policy.authorization["standing-normal-below"];
    expect(below).toBe("1.0.0");
    for (const version of ["0.0.7", "0.1.0", "0.99.99"]) {
      expect(modeForVersion(version, below).workflow, version).toBe(AUTOMATIC_RELEASE_WORKFLOW);
    }
    for (const version of ["1.0.0", "1.0.1", "2.0.0"]) {
      expect(modeForVersion(version, below).workflow, version).toBe(NORMAL_RELEASE_WORKFLOW);
    }
  });
});
