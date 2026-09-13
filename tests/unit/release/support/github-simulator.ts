import { createServer } from "node:http";
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
};

/**
 * A stand-in for the GitHub REST API on a loopback port, in this process.
 *
 * It answers only the reads the preview makes and records EVERY request, whatever its method, so a
 * test can assert that a run made zero writes rather than trusting that it had no reason to.
 */
export async function startGitHubSimulator(repository: string) {
  const pulls = new Map<number, SimulatedPull>();
  /** Commit sha → the pull requests GitHub associates with it (what a squash or rebase leaves). */
  const commitPulls = new Map<string, number[]>();
  /** Path prefix → HTTP status to answer with instead, to inject an API failure. */
  const failures = new Map<string, number>();
  const requests: RecordedRequest[] = [];
  let pageSize = 30;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "",
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };

    if (request.method !== "GET") {
      send(405, { message: "the simulator refuses every write" });
      return;
    }
    for (const [prefix, status] of failures) {
      if (url.pathname.startsWith(prefix)) {
        send(status, { message: "injected failure" });
        return;
      }
    }

    const base = `/repos/${repository}`;
    const pull = new RegExp(`^${escape(base)}/pulls/(\\d+)$`).exec(url.pathname);
    if (pull) {
      const found = pulls.get(Number(pull[1]));
      if (found) send(200, found);
      else send(404, { message: "Not Found" });
      return;
    }

    const forCommit = new RegExp(`^${escape(base)}/commits/([0-9a-f]{40})/pulls$`).exec(url.pathname);
    if (forCommit) {
      const all = (commitPulls.get(forCommit[1]) ?? []).map((n) => pulls.get(n)).filter(Boolean);
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = all.slice((page - 1) * pageSize, page * pageSize);
      const headers: Record<string, string> = {};
      if (page * pageSize < all.length) {
        const next = new URL(url.toString());
        next.host = request.headers.host ?? next.host;
        next.searchParams.set("page", String(page + 1));
        headers.link = `<http://${request.headers.host}${next.pathname}${next.search}>; rel="next"`;
      }
      send(200, slice, headers);
      return;
    }

    send(404, { message: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    pulls,
    commitPulls,
    failures,
    requests,
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

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
