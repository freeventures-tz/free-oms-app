/**
 * Whether an exact merge passed its own final-merge CI, read from GitHub rather than taken from the
 * event that announced it.
 *
 * Final-merge CI is a run of this repository's CI workflow, for a push to main, whose head is exactly
 * the commit. A pull-request run, a run of a synthetic merge commit, a run on another branch or from a
 * fork, and a run of another workflow are not final-merge CI, whatever they concluded. Every page of
 * runs and jobs is read.
 *
 * An attempt passes when it concluded success and every required job ran in that attempt exactly once,
 * for this commit and this run, and concluded success. Every attempt of every run is judged on its own
 * jobs. The run's latest attempt decides whether the commit is eligible now. An earlier attempt is the
 * evidence an existing build tag may cite: a tag made from an attempt that passed stays proven when a
 * later re-run fails, and a tag citing an attempt that did not pass is never proven by a later one.
 *
 * A job that failed in an earlier attempt and passed when the same run was retried is an accepted flaky
 * retry: it satisfies the gate and stays on the record. Nothing else stands in for a failed job — not a
 * passing job of another commit or another run, and not an explanation of why it failed.
 */

import { ControllerError } from "./errors.mjs";

export const FINAL_MERGE_CI = Object.freeze({
  workflowFile: "ci.yml",
  workflowPath: ".github/workflows/ci.yml",
  event: "push",
  branch: "main",
  /** The `name:` of every job in ci.yml. A test fails if the two lists ever disagree. */
  requiredJobs: Object.freeze([
    "Lint · Types · Unit · Build",
    "Migrations · pgTAP · Advisors",
    "Auth & Data API integration",
    "Responsive authentication E2E",
  ]),
});

const MAX_ATTEMPTS = 100;

const GATE_FAILURES = Object.freeze({
  missing: { code: "required_gate_missing", verb: "did not run" },
  ambiguous: { code: "required_gate_ambiguous", verb: "ran more than once" },
  skipped: { code: "required_gate_skipped", verb: "was skipped" },
  cancelled: { code: "required_gate_cancelled", verb: "was cancelled" },
  failed: { code: "required_gate_failed", verb: "failed" },
});

/** Every way a run differs from final-merge CI for this commit. Empty when it is final-merge CI. */
function runMismatches(run, { repository, repositoryId, workflowId, sha }) {
  const found = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) {
      found.push(`its ${label} is ${JSON.stringify(actual ?? null)}, not ${JSON.stringify(expected)}`);
    }
  };
  if (!Number.isSafeInteger(run?.id)) found.push("it has no run id");
  expect("repository", run?.repository?.full_name, repository);
  if (repositoryId !== null) expect("repository id", run?.repository?.id, repositoryId);
  expect("head repository", run?.head_repository?.full_name, repository);
  expect("workflow id", run?.workflow_id, workflowId);
  expect("workflow path", run?.path, FINAL_MERGE_CI.workflowPath);
  expect("event", run?.event, FINAL_MERGE_CI.event);
  expect("branch", run?.head_branch, FINAL_MERGE_CI.branch);
  expect("head commit", run?.head_sha, sha);
  return found;
}

/** Each required gate's result in one attempt, from that attempt's own jobs. */
function gateResults(counted, attempt) {
  return FINAL_MERGE_CI.requiredJobs.map((name) => {
    const executions = counted.filter((job) => job.name === name && job.run_attempt === attempt);
    if (executions.length === 0) return { name, result: "missing", conclusion: null };
    if (executions.length > 1) return { name, result: "ambiguous", conclusion: null };
    const [job] = executions;
    if (job.status !== "completed") return { name, result: "incomplete", conclusion: null };
    const conclusion = job.conclusion ?? null;
    const result =
      conclusion === "success"
        ? "success"
        : conclusion === "skipped"
          ? "skipped"
          : conclusion === "cancelled"
            ? "cancelled"
            : "failed";
    return { name, result, conclusion };
  });
}

async function evaluateRun(github, run, sha) {
  const attempt = run.run_attempt;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new ControllerError("github_response_invalid", `run ${run.id} reports attempt ${JSON.stringify(attempt)}`);
  }

  const counted = [];
  const ignoredJobs = [];
  for (const job of await github.workflowRunJobs(run.id)) {
    if (job?.run_id === run.id && job?.head_sha === sha && Number.isInteger(job?.run_attempt)) {
      counted.push(job);
    } else {
      ignoredJobs.push({
        name: job?.name ?? null,
        runId: job?.run_id ?? null,
        headSha: job?.head_sha ?? null,
        attempt: job?.run_attempt ?? null,
      });
    }
  }

  // An attempt GitHub cannot describe has an unknown status, and so did not pass.
  const attempts = [];
  for (let n = 1; n <= attempt; n += 1) {
    const snapshot = n === attempt ? run : await github.workflowRunAttempt(run.id, n);
    const status = snapshot?.status ?? null;
    const conclusion = snapshot?.conclusion ?? null;
    const gates = gateResults(counted, n);
    attempts.push({
      attempt: n,
      status,
      conclusion,
      satisfied: status === "completed" && conclusion === "success" && gates.every((gate) => gate.result === "success"),
      gates,
      unsuccessfulJobs: counted
        .filter((job) => job.run_attempt === n && job.conclusion !== "success")
        .map((job) => ({ name: job.name, conclusion: job.conclusion ?? job.status ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  const latest = attempts[attempt - 1];

  const acceptedFlakes = latest.gates
    .filter((gate) => gate.result === "success")
    .flatMap((gate) => {
      const unsuccessful = counted
        .filter((job) => job.name === gate.name && job.run_attempt < attempt && job.conclusion !== "success")
        .map((job) => ({ attempt: job.run_attempt, conclusion: job.conclusion ?? job.status ?? null }))
        .sort((a, b) => a.attempt - b.attempt);
      return unsuccessful.length === 0 ? [] : [{ job: gate.name, unsuccessful, passedAttempt: attempt }];
    });

  return {
    runId: run.id,
    attempt,
    url: run.html_url ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    complete: latest.status === "completed" && latest.gates.every((gate) => gate.result !== "incomplete"),
    satisfied: latest.satisfied,
    gates: latest.gates,
    attempts,
    acceptedFlakes,
    ignoredJobs,
  };
}

/**
 * Evaluates final-merge CI for a commit. When `runId` is given — the run whose completion started the
 * evaluation — it must itself be final-merge CI for the commit, or nothing else is read.
 *
 * Reasons use three kinds: `refusal` (not final-merge CI), `pending` (none yet, or not finished) and
 * `failed` (finished without satisfying every required gate).
 */
export async function evaluateFinalMergeCi({ github, repository, repositoryId = null, sha, runId = null }) {
  const result = { workflow: null, trigger: null, runs: [], ignoredRuns: [], satisfiedBy: null, reasons: [] };
  const reason = (kind, code, detail) => ({ kind, code, detail, commit: sha, pr: null });

  const workflow = await github.workflow(FINAL_MERGE_CI.workflowFile);
  if (!workflow || workflow.path !== FINAL_MERGE_CI.workflowPath || !Number.isSafeInteger(workflow.id)) {
    result.reasons.push(
      reason("refusal", "ci_workflow_unavailable", `${FINAL_MERGE_CI.workflowPath} is not a workflow of ${repository}`),
    );
    return result;
  }
  result.workflow = { id: workflow.id, path: workflow.path };
  const identity = { repository, repositoryId, workflowId: workflow.id, sha };

  const counted = new Map();
  if (runId !== null) {
    const run = await github.workflowRun(runId);
    const mismatches = run ? runMismatches(run, identity) : [`${repository} has no workflow run ${runId}`];
    result.trigger = { runId, finalMergeCi: mismatches.length === 0, mismatches };
    if (mismatches.length > 0) {
      result.reasons.push(
        reason("refusal", "not_final_merge_ci", `run ${runId} is not final-merge CI for ${sha}: ${mismatches.join("; ")}`),
      );
      return result;
    }
    counted.set(run.id, run);
  }

  for (const run of await github.workflowRunsForCommit(FINAL_MERGE_CI.workflowFile, sha)) {
    const mismatches = runMismatches(run, identity);
    if (mismatches.length === 0) {
      if (!counted.has(run.id)) counted.set(run.id, run);
    } else {
      result.ignoredRuns.push({
        runId: run?.id ?? null,
        event: run?.event ?? null,
        branch: run?.head_branch ?? null,
        why: mismatches,
      });
    }
  }

  const runs = [...counted.values()].sort((a, b) => b.id - a.id);
  if (runs.length === 0) {
    result.reasons.push(reason("pending", "ci_run_missing", `no final-merge CI run exists for ${sha} yet`));
    return result;
  }
  for (const run of runs) result.runs.push(await evaluateRun(github, run, sha));

  const satisfied = result.runs.find((run) => run.satisfied);
  if (satisfied) {
    result.satisfiedBy = { runId: satisfied.runId, attempt: satisfied.attempt, url: satisfied.url };
    return result;
  }

  const unfinished = result.runs.filter((run) => run.status !== "completed" || !run.complete);
  if (unfinished.length > 0) {
    result.reasons.push(
      reason(
        "pending",
        "ci_incomplete",
        `final-merge CI for ${sha} has not finished: ${unfinished.map((run) => `run ${run.runId} attempt ${run.attempt}`).join(", ")}`,
      ),
    );
    return result;
  }

  const newest = result.runs[0];
  const where = `in run ${newest.runId} attempt ${newest.attempt}`;
  for (const gate of newest.gates) {
    if (gate.result === "success") continue;
    const failure = GATE_FAILURES[gate.result];
    const verb = gate.result === "failed" ? `concluded ${gate.conclusion ?? "without a conclusion"}` : failure.verb;
    result.reasons.push(reason("failed", failure.code, `${gate.name} ${verb} ${where}`));
  }
  if (result.reasons.length === 0) {
    result.reasons.push(
      reason("failed", "ci_run_not_successful", `every required gate passed, but the run concluded ${newest.conclusion} ${where}`),
    );
  }
  return result;
}
