import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The workflow files as data: which events start them, which runs cancel which, what the required
 * gate depends on, and what they may never do.
 *
 * The concurrency and gate-name expressions are evaluated here for sample events by a small
 * evaluator that understands the subset of GitHub's expression syntax these files use (`||`, `&&`,
 * `==`, string literals and context paths). It refuses anything else, so a future expression it
 * cannot read fails this test instead of passing it. This proves the configuration; it is not a
 * GitHub run, and the live routing remains to be observed on the first pull request.
 */

const root = process.cwd();
const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const release = parse(readFileSync(join(root, ".github/workflows/release-gate.yml"), "utf8"));
const rawCi = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const rawRelease = readFileSync(join(root, ".github/workflows/release-gate.yml"), "utf8");

type Context = Record<string, unknown>;

function lookup(context: Context, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Context)[key] : undefined), context);
}

/** Evaluates one `${{ }}` body over the supported subset. */
function evaluate(expression: string, context: Context): unknown {
  const tokens = expression.match(/'[^']*'|\|\||&&|==|!=|[A-Za-z_][\w.-]*|\S/g) ?? [];
  let i = 0;
  const primary = (): unknown => {
    const token = tokens[i++];
    if (token === undefined) throw new Error(`unexpected end of ${expression}`);
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === "true" || token === "false") return token === "true";
    if (/^[A-Za-z_]/.test(token)) return lookup(context, token);
    throw new Error(`unsupported token ${token} in ${expression}`);
  };
  const equality = (): unknown => {
    let left = primary();
    while (tokens[i] === "==" || tokens[i] === "!=") {
      const op = tokens[i++];
      const right = primary();
      left = op === "==" ? left === right : left !== right;
    }
    return left;
  };
  const and = (): unknown => {
    let left = equality();
    while (tokens[i] === "&&") {
      i++;
      const right = equality();
      left = left ? right : left;
    }
    return left;
  };
  const or = (): unknown => {
    let left = and();
    while (tokens[i] === "||") {
      i++;
      const right = and();
      left = left ? left : right;
    }
    return left;
  };
  const value = or();
  if (i !== tokens.length) throw new Error(`could not read all of ${expression}`);
  return value;
}

function render(template: string, context: Context): string {
  return template.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, body) => String(evaluate(body, context) ?? ""));
}

function event(name: string, extra: Context = {}): Context {
  return { github: { workflow: "CI", event_name: name, run_id: extra.run_id ?? "1", event: extra.event ?? {}, ref: "refs/heads/x" }, inputs: extra.inputs ?? {} };
}

const pr = (number: number, run: string) => event("pull_request", { run_id: run, event: { pull_request: { number } } });
const push = (run: string) => event("push", { run_id: run });
const called = (run: string) => ({ ...event("workflow_dispatch", { run_id: run, inputs: { gate: "release" } }), github: { workflow: "Release Gate", event_name: "workflow_dispatch", run_id: run, event: {} } });

const group = (context: Context) => render(ci.concurrency.group, context);
const cancels = (context: Context) => render(String(ci.concurrency["cancel-in-progress"]), context) === "true";

describe("CI routing", () => {
  it("validates each pull-request update, drafts included, and pushes to main only", () => {
    expect(ci.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    expect(ci.on.pull_request.branches).toBeUndefined();
    expect(ci.on.push).toEqual({ branches: ["main"] });
    expect(ci.on.workflow_call.inputs.ref.required).toBe(true);
  });

  it("never checks out a fork's code with privileges", () => {
    for (const raw of [rawCi, rawRelease]) {
      expect(raw).not.toContain("pull_request_target");
      expect(raw).not.toMatch(/\bsecrets\./);
    }
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(release.permissions).toEqual({ contents: "read" });
  });

  it("a newer update to the same pull request cancels the older run", () => {
    expect(group(pr(7, "1"))).toBe(group(pr(7, "2")));
    expect(cancels(pr(7, "2"))).toBe(true);
  });

  it("an update to one pull request leaves another's run alone", () => {
    expect(group(pr(7, "1"))).not.toBe(group(pr(8, "2")));
  });

  it("pushes to main are never cancelled or queued behind each other", () => {
    expect(group(push("10"))).not.toBe(group(push("11")));
    expect(cancels(push("11"))).toBe(false);
  });

  it("a release run is never cancelled, and pull-request activity cannot reach its group", () => {
    expect(cancels(called("20"))).toBe(false);
    expect(group(called("20"))).not.toBe(group(called("21")));
    expect(group(called("20"))).not.toBe(group(pr(7, "20")));
    expect(release.concurrency).toBeUndefined();
    expect(release.on).toEqual({ workflow_dispatch: expect.any(Object) });
  });

  it("names the required check Development Gate for pull requests and pushes, Release Gate for candidates", () => {
    expect(render(ci.jobs.gate.name, pr(7, "1"))).toBe("Development Gate");
    expect(render(ci.jobs.gate.name, push("1"))).toBe("Development Gate");
    expect(render(ci.jobs.gate.name, called("1"))).toBe("Release Gate");
    expect(release.jobs.suites).toMatchObject({ uses: "./.github/workflows/ci.yml", with: { gate: "release" } });
  });

  it("the gate always runs, after every job, and decides from what they left", () => {
    expect(ci.jobs.gate.if).toBe("always()");
    expect(ci.jobs.gate.needs).toEqual(["plan", "static", "database", "integration", "e2e"]);
    const decide = ci.jobs.gate.steps.find((step: { name?: string }) => step.name === "Decide");
    expect(decide.run).toContain("node scripts/testing/gate.mjs");
    expect(decide.env.OMS_GATE_NEEDS).toBe("${{ toJSON(needs) }}");
  });

  it("uses continue-on-error only where the gate itself refuses the missing input", () => {
    for (const [jobName, job] of Object.entries(ci.jobs as Record<string, { steps: Array<Record<string, unknown>> }>)) {
      for (const step of job.steps) {
        if (step["continue-on-error"] === undefined) continue;
        expect(jobName).toBe("gate");
        expect(step.uses).toBe("actions/download-artifact@v4");
      }
    }
  });

  it("keeps every existing broad suite and its job name", () => {
    const runs = (job: string) => ci.jobs[job].steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(ci.jobs.static.name).toBe("Lint · Types · Unit · Build");
    for (const command of ["npm run lint", "npm run typecheck", "npm run test:unit", "npm run build"]) expect(runs("static")).toContain(command);
    expect(ci.jobs.database.name).toBe("Migrations · pgTAP · Advisors");
    for (const command of ["supabase db reset", "npm run test:migration-chain", "supabase test db", "supabase db lint --level warning", "node scripts/run-advisors.mjs"]) {
      expect(runs("database")).toContain(command);
    }
    expect(ci.jobs.integration.name).toBe("Auth & Data API integration");
    expect(runs("integration")).toContain("npm run test:integration");
    expect(ci.jobs.e2e.name).toBe("Responsive authentication E2E");
    expect(runs("e2e")).toContain("npm run build");
    expect(runs("e2e")).toContain("npm run test:e2e");
  });

  it("every suite job hands its results to the gate, whatever happened", () => {
    for (const job of ["static", "database", "integration", "e2e"]) {
      const upload = ci.jobs[job].steps.find((step: { with?: { name?: string } }) => step.with?.name === `results-${job}`);
      expect(upload, job).toBeDefined();
      expect(upload.if).toBe("always()");
    }
  });

  it("fails a pipeline on its first failing command, so a tee cannot hide a red suite", () => {
    expect(ci.defaults.run.shell).toBe("bash");
    expect(release.defaults.run.shell).toBe("bash");
  });

  it("deploys, migrates, tags and publishes nothing", () => {
    for (const raw of [rawCi, rawRelease]) {
      expect(raw).not.toMatch(/vercel\s+(deploy|--prod|promote)|supabase\s+(link|db push|functions deploy)|gh release|git tag|git push|npm publish/);
    }
  });

  it("R2: turns the benchmarks on for a release candidate and off otherwise", () => {
    expect(render(ci.env.FV_BENCHMARK, called("1"))).toBe("1");
    expect(render(ci.env.FV_BENCHMARK, pr(7, "1"))).toBe("");
    expect(render(ci.env.FV_BENCHMARK, push("1"))).toBe("");
  });

  it("R3: every test job lists its tests, without the results reporter, before it runs them", () => {
    const listing = (job: string, command: string) => {
      const steps = ci.jobs[job].steps;
      const index = steps.findIndex((step: { run?: string }) => step.run?.includes(command));
      expect(index, `${job} lists with ${command}`).toBeGreaterThan(-1);
      expect(steps[index].env.OMS_TEST_RESULTS_DIR).toBe("");
      return index;
    };
    const runIndex = (job: string, command: string) => ci.jobs[job].steps.findIndex((step: { run?: string }) => step.run === command);
    expect(listing("static", "vitest list --project unit --json=oms-test/results/unit.vitest-list.json")).toBeLessThan(runIndex("static", "npm run test:unit"));
    expect(listing("integration", "vitest list --project integration --json=oms-test/results/integration.vitest-list.json")).toBeLessThan(
      runIndex("integration", "npm run test:integration"),
    );
    expect(listing("e2e", "playwright test --list --reporter=json > oms-test/results/e2e.playwright-list.json")).toBeLessThan(runIndex("e2e", "npm run test:e2e"));
  });

  it("R4: plans the base's minimum from the base's own tree, on every event with a base selector", () => {
    const step = ci.jobs.plan.steps.find((entry: { name?: string }) => entry.name === "Plan with the approved base's rules");
    expect(step.if).toBeUndefined();
    expect(step.run).toContain('--inventory-rev "$BASE"');
    expect(step.run).toContain("--mode full");
    expect(step.run).toContain("--manifest .base-policy/scripts/testing/manifest.json");
  });

  it("R1: records the tested build after the E2E build, and binds it with the Release Gate decision", () => {
    const e2e = ci.jobs.e2e.steps;
    const build = e2e.findIndex((step: { run?: string }) => step.run === "npm run build");
    const record = e2e.findIndex((step: { run?: string }) => step.run?.includes("--describe-artifact --output oms-test/results/artifact.json"));
    expect(record).toBe(build + 1);
    // Unconditional: a Release Gate without the record refuses, and so must this check.
    expect(e2e[record].if).toBeUndefined();

    const bind = release.jobs.bind;
    expect(bind.needs).toEqual(["identity", "suites"]);
    expect(bind.if).toBe("always()");
    expect(bind.steps[0].run).toContain('[ "$SUITES" = success ]');
    const binding = bind.steps.find((step: { name?: string }) => step.name === "Bind the evidence");
    expect(binding.run).toContain("--bind");
    expect(binding.run).toContain("--gate-report oms-test/gate-report.json");
    expect(binding.run).toContain("--artifact oms-test/e2e/artifact.json");
  });

  it("the plan job keeps full history and checks it tests the pull request's real merge", () => {
    const checkout = ci.jobs.plan.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4");
    expect(checkout.with["fetch-depth"]).toBe(0);
    const identity = ci.jobs.plan.steps.find((step: { id?: string }) => step.id === "identity");
    expect(identity.run).toContain('"$(git rev-parse HEAD^2)" != "$PR_HEAD"');
  });
});
