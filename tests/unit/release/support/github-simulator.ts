import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The fields of a pull request the controller is allowed to rely on, as GitHub's REST API returns them. */
export type SimulatedPull = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  head: { sha: string; ref: string };
  base: { ref: string; repo: { full_name: string } };
};

export type RecordedRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body?: unknown;
};

export type SimulatedJob = {
  name: string;
  status: string;
  conclusion: string | null;
  /** Defaults to the run's head commit. */
  head_sha?: string;
  /** Defaults to the run's id. */
  run_id?: number;
};

export type SimulatedAttempt = { status: string; conclusion: string | null; jobs: SimulatedJob[] };

/** A workflow run with every attempt it has had. The last attempt is the run as it stands now. */
export type SimulatedRun = {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  event: string;
  head_branch: string;
  head_sha: string;
  repository: { id: number; full_name: string };
  head_repository: { full_name: string };
  attempts: SimulatedAttempt[];
};

export type SimulatedWorkflow = { id: number; name: string; path: string; state: string };

/** Runs Git in the repository whose objects and references the simulator serves. Output is untrimmed. */
export type GitRunner = (args: string[], input?: string) => string;

/**
 * An injected failure or side effect for requests matching a method and path. `before` runs the effect
 * and, when a status is given, answers with it without doing the work. `after` does the work and then
 * answers with the status, the way a response lost after the change was made looks to a client.
 */
export type Fault = {
  method: string;
  path: RegExp;
  when: "before" | "after";
  status?: number;
  times?: number;
  effect?: (body: unknown) => void;
};

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

/**
 * A stand-in for the GitHub REST API on a loopback port, in this process.
 *
 * It answers the reads the controller makes and exactly three writes — create a tag object, create a
 * reference, create a commit status — and records EVERY request, whatever its method, so a test can
 * assert the writes a run made rather than trusting that it had no reason to make them. Git data is
 * served from, and written into, a real disposable repository attached with `attachGit`.
 */
export async function startGitHubSimulator(repository: string) {
  const pulls = new Map<number, SimulatedPull>();
  /** Commit sha → the pull requests GitHub associates with it (what a squash or rebase leaves). */
  const commitPulls = new Map<string, number[]>();
  /** Path prefix → HTTP status to answer a GET with instead, to inject an API failure. */
  const failures = new Map<string, number>();
  const workflows = new Map<string, SimulatedWorkflow>();
  const runs = new Map<number, SimulatedRun>();
  const statuses: Array<Record<string, unknown>> = [];
  const faults: Fault[] = [];
  const requests: RecordedRequest[] = [];
  let pageSize = 30;
  let git: GitRunner | null = null;
  let tick = 0;

  const base = `/repos/${repository}`;
  const route = (pattern: string, pathname: string) => new RegExp(`^${escape(base)}${pattern}$`).exec(pathname);

  const paged = (items: unknown[], url: URL, host: string | undefined) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const slice = items.slice((page - 1) * pageSize, page * pageSize);
    const headers: Record<string, string> = {};
    if (page * pageSize < items.length) {
      const next = new URL(url.toString());
      next.searchParams.set("page", String(page + 1));
      headers.link = `<http://${host}${next.pathname}${next.search}>; rel="next"`;
    }
    return { slice, headers };
  };

  const runUrl = (id: number) => `https://github.com/${repository}/actions/runs/${id}`;
  const runView = (run: SimulatedRun, attempt = run.attempts.length) => {
    const { attempts, ...meta } = run;
    const at = attempts[attempt - 1];
    return { ...meta, run_attempt: attempt, status: at.status, conclusion: at.conclusion, html_url: runUrl(run.id) };
  };
  const jobsOf = (run: SimulatedRun) =>
    run.attempts.flatMap((attempt, index) =>
      attempt.jobs.map((job, position) => ({
        id: run.id * 1000 + index * 50 + position,
        run_id: job.run_id ?? run.id,
        run_attempt: index + 1,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        head_sha: job.head_sha ?? run.head_sha,
        head_branch: run.head_branch,
        workflow_name: run.name,
      })),
    );

  const requireGit = () => {
    if (!git) throw new Error("no repository is attached to the simulator");
    return git;
  };
  const succeeds = (args: string[]) => {
    try {
      requireGit()(args);
      return true;
    } catch {
      return false;
    }
  };

  const tagReferences = () =>
    requireGit()(["for-each-ref", "--format=%(refname)%09%(objecttype)%09%(objectname)", "refs/tags"])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, type, sha] = line.split("\t");
        return { ref, object: { sha, type } };
      });

  const readTagObject = (sha: string) => {
    if (!/^[0-9a-f]{40}$/.test(sha) || !succeeds(["cat-file", "-e", sha])) return null;
    if (requireGit()(["cat-file", "-t", sha]).trim() !== "tag") return null;
    const raw = requireGit()(["cat-file", "tag", sha]);
    const split = raw.indexOf("\n\n");
    const fields: Record<string, string> = {};
    for (const line of raw.slice(0, split).split("\n")) {
      const space = line.indexOf(" ");
      fields[line.slice(0, space)] = line.slice(space + 1);
    }
    return {
      sha,
      tag: fields.tag,
      message: raw.slice(split + 2),
      object: { sha: fields.object, type: fields.type },
      tagger: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
      verification: { verified: false, reason: "unsigned" },
    };
  };

  function answer(method: string, url: URL, body: unknown, host: string | undefined): Answer {
    const { pathname } = url;
    const input = (body ?? {}) as Record<string, unknown>;

    if (method === "GET") {
      let match = route("/pulls/(\\d+)", pathname);
      if (match) {
        const found = pulls.get(Number(match[1]));
        return found ? { status: 200, body: found } : { status: 404, body: { message: "Not Found" } };
      }
      match = route("/commits/([0-9a-f]{40})/status", pathname);
      if (match) {
        // The combined status: the latest status in each context, as GitHub reports it.
        const latest = new Map<string, Record<string, unknown>>();
        for (const { sha, ...status } of statuses) if (sha === match[1]) latest.set(String(status.context), status);
        const all = [...latest.values()];
        const { slice, headers } = paged(all, url, host);
        return { status: 200, body: { sha: match[1], total_count: all.length, statuses: slice }, headers };
      }
      match = route("/commits/([0-9a-f]{40})/pulls", pathname);
      if (match) {
        const all = (commitPulls.get(match[1]) ?? []).map((n) => pulls.get(n)).filter(Boolean);
        const { slice, headers } = paged(all, url, host);
        return { status: 200, body: slice, headers };
      }
      match = route("/actions/workflows/([^/]+)/runs", pathname);
      if (match) {
        const workflow = workflows.get(decodeURIComponent(match[1]));
        if (!workflow) return { status: 404, body: { message: "Not Found" } };
        const headSha = url.searchParams.get("head_sha");
        const all = [...runs.values()]
          .filter((run) => run.workflow_id === workflow.id && (!headSha || run.head_sha === headSha))
          .sort((a, b) => b.id - a.id)
          .map((run) => runView(run));
        const { slice, headers } = paged(all, url, host);
        return { status: 200, body: { total_count: all.length, workflow_runs: slice }, headers };
      }
      match = route("/actions/workflows/([^/]+)", pathname);
      if (match) {
        const workflow = workflows.get(decodeURIComponent(match[1]));
        return workflow ? { status: 200, body: workflow } : { status: 404, body: { message: "Not Found" } };
      }
      match = route("/actions/runs/(\\d+)/attempts/(\\d+)", pathname);
      if (match) {
        const run = runs.get(Number(match[1]));
        const attempt = Number(match[2]);
        return run && attempt >= 1 && attempt <= run.attempts.length
          ? { status: 200, body: runView(run, attempt) }
          : { status: 404, body: { message: "Not Found" } };
      }
      match = route("/actions/runs/(\\d+)/jobs", pathname);
      if (match) {
        const run = runs.get(Number(match[1]));
        if (!run) return { status: 404, body: { message: "Not Found" } };
        const all = jobsOf(run).filter(
          (job) => url.searchParams.get("filter") === "all" || job.run_attempt === run.attempts.length,
        );
        const { slice, headers } = paged(all, url, host);
        return { status: 200, body: { total_count: all.length, jobs: slice }, headers };
      }
      match = route("/actions/runs/(\\d+)", pathname);
      if (match) {
        const run = runs.get(Number(match[1]));
        return run ? { status: 200, body: runView(run) } : { status: 404, body: { message: "Not Found" } };
      }
      match = route("/git/matching-refs/tags(/.*)?", pathname);
      if (match) {
        const prefix = `refs/tags${match[1] ?? ""}`;
        const all = tagReferences().filter((ref) => ref.ref.startsWith(prefix));
        const { slice, headers } = paged(all, url, host);
        return { status: 200, body: slice, headers };
      }
      match = route("/git/ref/tags/(.+)", pathname);
      if (match) {
        const ref = `refs/tags/${decodeURIComponent(match[1])}`;
        const found = tagReferences().find((candidate) => candidate.ref === ref);
        return found ? { status: 200, body: found } : { status: 404, body: { message: "Not Found" } };
      }
      match = route("/git/tags/([0-9a-f]{40})", pathname);
      if (match) {
        const found = readTagObject(match[1]);
        return found ? { status: 200, body: found } : { status: 404, body: { message: "Not Found" } };
      }
      return { status: 404, body: { message: "Not Found" } };
    }

    if (method === "POST" && route("/git/tags", pathname)) {
      const { tag, message, object, type } = input;
      if (typeof tag !== "string" || typeof message !== "string" || typeof object !== "string" || type !== "commit") {
        return { status: 422, body: { message: "Validation Failed" } };
      }
      if (!/^[0-9a-f]{40}$/.test(object) || !succeeds(["cat-file", "-e", `${object}^{commit}`])) {
        return { status: 422, body: { message: "Object does not exist" } };
      }
      tick += 1;
      const content = [
        `object ${object}`,
        "type commit",
        `tag ${tag}`,
        `tagger github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> ${1_790_000_000 + tick} +0000`,
        "",
        message.endsWith("\n") ? message.slice(0, -1) : message,
        "",
      ].join("\n");
      const sha = requireGit()(["mktag"], content).trim();
      return { status: 201, body: readTagObject(sha) };
    }

    if (method === "POST" && route("/git/refs", pathname)) {
      const { ref, sha } = input;
      if (typeof ref !== "string" || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        return { status: 422, body: { message: "Validation Failed" } };
      }
      if (!ref.startsWith("refs/") || !succeeds(["check-ref-format", ref]) || !succeeds(["cat-file", "-e", sha])) {
        return { status: 422, body: { message: "Validation Failed" } };
      }
      if (succeeds(["show-ref", "--verify", "--quiet", ref])) {
        return { status: 422, body: { message: "Reference already exists" } };
      }
      // An all-zero old value makes the update fail if the reference exists: no force is possible.
      requireGit()(["update-ref", ref, sha, "0".repeat(40)]);
      const type = requireGit()(["cat-file", "-t", sha]).trim();
      return { status: 201, body: { ref, object: { sha, type } } };
    }

    const status = method === "POST" ? route("/statuses/([0-9a-f]{40})", pathname) : null;
    if (status) {
      statuses.push({ sha: status[1], ...input });
      return { status: 201, body: { id: statuses.length, ...input } };
    }

    return { status: 405, body: { message: "the simulator does not accept this write" } };
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "";
    const raw = await readBody(request);
    let body: unknown;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
      ...(method === "GET" ? {} : { body }),
    });

    const send = ({ status, body: payload, headers = {} }: Answer) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(payload));
    };

    if (method === "GET") {
      for (const [prefix, status] of failures) {
        if (url.pathname.startsWith(prefix)) {
          send({ status, body: { message: "injected failure" } });
          return;
        }
      }
    }

    const fault = faults.find((f) => (f.times ?? 1) > 0 && f.method === method && f.path.test(url.pathname));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.when === "before") {
        fault.effect?.(body);
        if (fault.status) {
          send({ status: fault.status, body: { message: "injected failure" } });
          return;
        }
      }
    }

    const result = answer(method, url, body, request.headers.host);
    if (fault?.when === "after" && fault.status) {
      fault.effect?.(body);
      send({ status: fault.status, body: { message: "injected failure after the change was made" } });
      return;
    }
    send(result);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: String(error) }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    pulls,
    commitPulls,
    failures,
    workflows,
    runs,
    statuses,
    faults,
    requests,
    attachGit(runner: GitRunner) {
      git = runner;
    },
    setPageSize(size: number) {
      pageSize = size;
    },
    writes() {
      return requests.filter((r) => r.method !== "GET");
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type GitHubSimulator = Awaited<ReturnType<typeof startGitHubSimulator>>;

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
