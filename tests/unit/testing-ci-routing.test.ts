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

  it("runs every suite on main each night, held to main's last commit", () => {
    expect(ci.on.schedule).toEqual([{ cron: "0 1 * * *" }]);
    const select = ci.jobs.plan.steps.find((step: { name?: string }) => step.name === "Select tests");
    // Not a pull request and not a release: everything runs, with the lane reported beside it.
    expect(render(select.env.MODE, event("schedule"))).toBe("shadow");
    const identity = ci.jobs.plan.steps.find((step: { id?: string }) => step.id === "identity");
    expect(identity.run).toContain('schedule) base="$(git rev-parse HEAD^1)" ;;');
    expect(cancels(event("schedule", { run_id: "30" }))).toBe(false);
    expect(render(ci.jobs.gate.name, event("schedule"))).toBe("Development Gate");
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
    expect(runs("e2e")).toContain("npx playwright test $SPECS");
  });

  it("every suite job hands its results to the gate, whatever happened", () => {
    for (const job of ["static", "database", "integration", "e2e"]) {
      // One E2E shard keeps the name the release workflow downloads; more than one are numbered.
      const upload = ci.jobs[job].steps.find((step: { with?: { name?: string } }) => step.with?.name?.startsWith(`results-${job}`));
      expect(upload, job).toBeDefined();
      expect(upload.if).toBe("always()");
    }
    const e2eUpload = ci.jobs.e2e.steps.find((step: { with?: { name?: string } }) => step.with?.name?.startsWith("results-e2e"));
    expect(e2eUpload.with.name).toBe("results-e2e${{ needs.plan.outputs.e2e-shard-total != '1' && format('-{0}', matrix.shard) || '' }}");
    expect(release.jobs.bind.steps.some((step: { with?: { name?: string } }) => step.with?.name === "results-e2e")).toBe(true);
  });

  it("holds a pull request to its lane, and runs everything on main and for a release", () => {
    const select = ci.jobs.plan.steps.find((step: { name?: string }) => step.name === "Select tests");
    const mode = (context: Context) => render(select.env.MODE, context);
    expect(mode(pr(7, "1"))).toBe("enforce");
    expect(mode(push("1"))).toBe("shadow");
    expect(mode(called("1"))).toBe("full");
    // One E2E job for a release, so one build is the evidence the candidate is bound to.
    expect(render(select.env.MAX_SHARDS, called("1"))).toBe("1");
    expect(render(select.env.MAX_SHARDS, pr(7, "1"))).toBe("8");
    expect(select.run).toContain('--mode "$MODE" --max-shards "$MAX_SHARDS"');
  });

  it("skips a suite job only on the plan's say-so, and never the static job or the gate", () => {
    const outputs = ci.jobs.plan.steps.find((step: { id?: string }) => step.id === "jobs");
    expect(outputs.run).toContain("node scripts/testing/ci.mjs outputs --plan oms-test/plan/plan.json");
    for (const job of ["database", "integration", "e2e"]) {
      expect(ci.jobs[job].needs).toBe("plan");
      expect(ci.jobs[job].if).toBe(`needs.plan.outputs.${job} == 'true'`);
      expect(ci.jobs.plan.outputs[job]).toBe(`\${{ steps.jobs.outputs.${job} }}`);
    }
    expect(ci.jobs.static.if).toBeUndefined();
    expect(ci.jobs.static.needs).toBeUndefined();
    expect(ci.jobs.gate.if).toBe("always()");
  });

  it("splits the E2E specs between jobs that each have their own stack, and lets every shard finish", () => {
    const e2e = ci.jobs.e2e;
    expect(e2e.strategy["fail-fast"]).toBe(false);
    expect(e2e.strategy.matrix.shard).toBe("${{ fromJSON(needs.plan.outputs.e2e-shards) }}");
    const specs = e2e.steps.find((step: { id?: string }) => step.id === "specs");
    expect(specs.run).toContain('node scripts/testing/ci.mjs shard-files --plan oms-test/plan/plan.json --shard "$SHARD"');
    const run = e2e.steps.find((step: { name?: string }) => step.name === "E2E");
    expect(run.env.OMS_E2E_RESULTS_NAME).toBe("e2e.playwright.shard-${{ matrix.shard }}-of-${{ needs.plan.outputs.e2e-shard-total }}.json");
    // Each shard starts its own stack and builds its own source before it runs anything.
    const names = e2e.steps.map((step: { name?: string; run?: string }) => step.name ?? step.run ?? "");
    expect(names.indexOf("Start Supabase")).toBeLessThan(names.indexOf("E2E"));
    expect(names.indexOf("npm run build")).toBeLessThan(names.indexOf("E2E"));
  });

  it("runs E2E on the database its own job just started, and never writes to it first", () => {
    // A reset before the run would repeat what `supabase start` did a moment earlier. That holds
    // only while nothing between the start and the run touches the database, so the steps between
    // them are pinned: the build, the record of it, and a listing, none of which opens it.
    const steps = ci.jobs.e2e.steps;
    const names = steps.map((step: { name?: string; run?: string }) => step.name ?? step.run ?? "");
    const run = steps.find((step: { name?: string }) => step.name === "E2E");
    expect(run.run).toBe("npx playwright test $SPECS");
    expect(names.slice(names.indexOf("Start Supabase") + 1, names.indexOf("E2E"))).toEqual(["Write local environment", "npm run build", "Record the tested build", "List E2E tests"]);
    const start = steps.find((step: { name?: string }) => step.name === "Start Supabase");
    // The browser downloads beside the stack's start, and a failed download still fails the job.
    expect(start.run).toContain('npx playwright install --with-deps chromium > "$RUNNER_TEMP/playwright-install.log" 2>&1 &');
    expect(start.run).toContain('wait "$browser" || { cat "$RUNNER_TEMP/playwright-install.log"; exit 1; }');
    // Nothing a step writes may land in the checkout: a release candidate's build is recorded
    // from a clean tree, and an untracked log would make it dirty.
    for (const step of steps) {
      // Every file a step redirects into: not `2>&1`, and `>>` counted once.
      for (const target of String(step.run ?? "").matchAll(/(?<![0-9&>])>>?\s*"?([^\s"&|>]+)/g)) {
        expect(target[1], step.name ?? step.run).toMatch(/^(oms-test\/|\$RUNNER_TEMP\/|\$GITHUB_OUTPUT$|\.env\.local$)/);
      }
    }
  });

  it("deals the migration chain's proofs out between jobs, and runs pgTAP, lint and advisors once", () => {
    const database = ci.jobs.database;
    expect(database.strategy["fail-fast"]).toBe(false);
    expect(database.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    const chain = database.steps.find((step: { run?: string }) => step.run?.includes("npm run test:migration-chain"));
    expect(chain.env.SHARD).toBe("${{ matrix.shard }}/${{ strategy.job-total }}");
    expect(chain.env.LOG).toBe("migration-chain.shard-${{ matrix.shard }}-of-${{ strategy.job-total }}.log");
    expect(chain.run).toContain('npm run test:migration-chain -- --shard "$SHARD" 2>&1 | tee "oms-test/results/$LOG"');
    expect(chain.if).toBeUndefined();
    for (const name of ["Migrations apply from a clean database", "pgTAP", "Database lint", "Database advisors"]) {
      expect(database.steps.find((step: { name?: string }) => step.name === name).if, name).toBe("matrix.shard == 1");
    }
    const upload = database.steps.find((step: { with?: { name?: string } }) => step.with?.name?.startsWith("results-database"));
    expect(upload.with.name).toBe("results-database-${{ matrix.shard }}");
  });

  it("starts every stack without the services no suite uses, and keeps the ones they do", () => {
    const excluded = String(ci.env.SUPABASE_EXCLUDE).split(",");
    expect(excluded).toEqual(["studio", "postgres-meta", "logflare", "vector", "edge-runtime", "imgproxy", "realtime"]);
    // The database always starts; these are the others the suites call.
    for (const needed of ["gotrue", "postgrest", "kong", "storage-api", "mailpit"]) expect(excluded).not.toContain(needed);
    for (const job of ["database", "integration", "e2e"]) {
      const start = ci.jobs[job].steps.find((step: { name?: string }) => step.name === "Start Supabase");
      expect(start.run, job).toContain('supabase start -x "$SUPABASE_EXCLUDE"');
    }
    // The local fast start leaves out the same services, so a suite that passes here passes there.
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    expect(scripts["db:start:fast"]).toBe(`supabase start -x ${ci.env.SUPABASE_EXCLUDE}`);
    expect(scripts["db:start"]).toBe("supabase start");
  });

  it("restores installed packages by the lockfile, and installs only on a miss", () => {
    for (const job of ["static", "database", "integration", "e2e"]) {
      const steps = ci.jobs[job].steps;
      const restore = steps.find((step: { id?: string }) => step.id === "packages");
      expect(restore.uses, job).toBe("actions/cache@v4");
      expect(restore.with).toEqual({ path: "node_modules", key: "node-modules-${{ runner.os }}-node22-${{ hashFiles('package-lock.json') }}" });
      const install = steps.find((step: { run?: string }) => step.run === "npm ci");
      expect(install.if, job).toBe("steps.packages.outputs.cache-hit != 'true'");
      expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(install));
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

  it("R2: never turns the benchmarks on inside the main suites, and runs each one alone for a release candidate", () => {
    // Benchmarks inside the main run left their samples in the shared database and broke 16 later
    // specs in a local release run; they belong in isolated passes after the main run.
    expect(rawCi).not.toMatch(/FV_BENCHMARK\s*:/);
    expect(ci.env.FV_BENCHMARK).toBeUndefined();
    for (const job of Object.values(ci.jobs as Record<string, { env?: object; steps: Array<{ env?: object }> }>)) {
      expect(job.env ?? {}).not.toHaveProperty("FV_BENCHMARK");
      for (const step of job.steps) expect(step.env ?? {}).not.toHaveProperty("FV_BENCHMARK");
    }
    for (const [job, main, suite] of [
      ["integration", "npm run test:integration", "integration"],
      ["e2e", "npx playwright test $SPECS", "e2e"],
    ] as const) {
      const steps = ci.jobs[job].steps;
      const mainIndex = steps.findIndex((step: { run?: string }) => step.run === main);
      const bench = steps.findIndex((step: { run?: string }) => step.run === `node scripts/testing/benchmarks.mjs --suite ${suite} --results oms-test/results`);
      expect(bench, job).toBeGreaterThan(mainIndex);
      expect(steps[bench].if).toBe("inputs.gate == 'release'");
      expect(steps.findIndex((step: { with?: { name?: string } }) => step.with?.name?.startsWith(`results-${job}`))).toBeGreaterThan(bench);
    }
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
    expect(listing("e2e", 'playwright test --list --reporter=json $SPECS > "oms-test/results/$LISTING"')).toBeLessThan(runIndex("e2e", "npx playwright test $SPECS"));
    const e2eListing = ci.jobs.e2e.steps.find((step: { name?: string }) => step.name === "List E2E tests");
    expect(e2eListing.env.LISTING).toBe("e2e.playwright-list.shard-${{ matrix.shard }}-of-${{ needs.plan.outputs.e2e-shard-total }}.json");
  });

  it("R4: plans the base's minimum from the base's own tree, on every event with a base selector", () => {
    const step = ci.jobs.plan.steps.find((entry: { name?: string }) => entry.name === "Plan with the approved base's rules");
    expect(step.if).toBeUndefined();
    // One command, which plans the base with its own selector or, without one, in full over its own
    // tree (select.mjs baselinePlan), and fails rather than fall back to the head.
    expect(step.run).toBe('node scripts/testing/select.mjs --baseline --base "$BASE" --head "$HEAD_SHA" --output oms-test/plan/base-plan.json');
    expect(step["continue-on-error"]).toBeUndefined();
    expect(ci.jobs.gate.steps.find((entry: { name?: string }) => entry.name === "Decide").run).toContain("--base-plan oms-test/plan/base-plan.json");
  });

  it("R4: a Release Gate run cannot start without the production base it is held to", () => {
    const input = release.on.workflow_dispatch.inputs.production_base;
    expect(input.required).toBe(true);
    expect(input.default).toBeUndefined();
    const steps = release.jobs.identity.steps;
    const check = steps.find((step: { name?: string }) => step.name === "Refuse anything but a full commit name").run;
    expect(check).toContain('[[ "$PRODUCTION_BASE" =~ ^[0-9a-f]{40}$ ]] || {');
    expect(check).not.toContain('-z "$PRODUCTION_BASE"');
    const record = steps.find((step: { name?: string }) => step.name === "Record the candidate").run;
    expect(record).toContain('--production-base "$PRODUCTION_BASE"');
    expect(record).not.toContain('[ -n "$PRODUCTION_BASE" ]');
    expect(release.jobs.suites.with.base).toBe("${{ inputs.production_base }}");
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
