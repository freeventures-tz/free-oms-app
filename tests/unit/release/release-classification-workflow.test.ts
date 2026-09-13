// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * What the pull-request classification workflow is allowed to be. The controller cannot prove any of
 * this about the workflow that runs it: which events start it, what its token may do, whether PR
 * text ever reaches a shell, and whether an action can change under it.
 */

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: unknown; permissions?: Record<string, string>; jobs: Record<string, Job> };

const text = readFileSync(".github/workflows/release-classification.yml", "utf8");
const workflow = parse(text) as Workflow;
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((job) => job.steps);

describe("the release classification workflow", () => {
  it("runs for a pull request being opened, edited, reopened or updated, and for nothing else", () => {
    expect(workflow.on).toEqual({
      pull_request: { types: ["opened", "edited", "reopened", "synchronize"] },
    });
  });

  it("grants read-only contents and nothing else, at the workflow and at every job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of jobs) {
      expect(job.permissions ?? { contents: "read" }).toEqual({ contents: "read" });
    }
  });

  it("pins every action to a full commit sha", () => {
    const uses = steps.map((step) => step.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it("hands the title and body over as environment data and never expands an expression inside a script", () => {
    for (const step of steps) {
      if (step.run) expect(step.run).not.toContain("${{");
    }
    const classify = steps.find((step) => step.run?.includes("check-pr-title"));
    expect(classify?.env).toEqual({
      PR_TITLE: "${{ github.event.pull_request.title }}",
      PR_BODY: "${{ github.event.pull_request.body }}",
    });
    expect(classify?.run).toContain("--title-env PR_TITLE");
    expect(classify?.run).toContain("--body-env PR_BODY");
  });

  it("reads no secret or token and leaves no credential in the checkout", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
    expect(text).not.toMatch(/pull_request_target|workflow_run/);
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("installs the pinned dependencies without running lifecycle scripts or restoring a cache", () => {
    expect(steps.some((step) => step.run?.includes("npm ci --ignore-scripts"))).toBe(true);
    for (const step of steps) {
      expect(step.with?.cache).toBeUndefined();
    }
  });
});

describe("the existing CI workflow", () => {
  it("keeps its branch filters and gains no tag, release or deployment trigger", () => {
    const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Workflow;
    expect(ci.on).toEqual({ push: { branches: ["**"] }, pull_request: null });
  });
});
