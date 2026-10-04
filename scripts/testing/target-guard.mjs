/**
 * Refuses to let a destructive test touch anything but this checkout's own local Supabase stack.
 *
 * Integration and E2E setup create users, reset passwords, deactivate accounts and reset the whole
 * database. The old checks looked for the text "127.0.0.1" or "localhost" anywhere in the URL, which
 * `https://127.0.0.1.attacker.example` and `https://db.example/?localhost` both satisfy. This parses
 * every target and requires, exactly:
 *
 *   - the API URL is http on a loopback host (127.0.0.1, localhost or [::1]), with no credentials,
 *     path, query or fragment, on the API port this checkout's supabase/config.toml declares;
 *   - any database URL is postgres on a loopback host, on the database port config.toml declares;
 *   - any E2E base URL is http on a loopback host;
 *   - any named database container is the one config.toml's project id names.
 *
 * The port pairing is what catches the wrong stack: an isolated stack in a worktree has its own
 * ports in its own config.toml, so a `.env.local` copied from another checkout points at someone
 * else's database and is refused before anything is reset.
 *
 * This runs before any bootstrap, reset or fixture is created. It contacts nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseDotenv } from "dotenv";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** project_id and the [api] and [db] ports from a config.toml. */
/** @param {string} text @returns {{ projectId: string | null, apiPort: number | null, dbPort: number | null }} */
export function readStackConfig(text) {
  /** @type {{ projectId: string | null, apiPort: number | null, dbPort: number | null }} */
  const out = { projectId: null, apiPort: null, dbPort: null };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const pair = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (section === "" && key === "project_id") out.projectId = value.replace(/^"|"$/g, "");
    if (section === "api" && key === "port") out.apiPort = Number(value);
    if (section === "db" && key === "port") out.dbPort = Number(value);
  }
  return out;
}

function parse(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function checkHttp(name, value, refusals, port) {
  const url = parse(value);
  if (!url) return refusals.push(`${name} is not a URL: ${value || "(unset)"}`);
  if (url.protocol !== "http:") refusals.push(`${name} must use http on the local stack, not ${url.protocol}`);
  if (!LOOPBACK.has(url.hostname)) refusals.push(`${name} host ${url.hostname} is not loopback`);
  if (url.username || url.password) refusals.push(`${name} carries credentials`);
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) refusals.push(`${name} has a path, query or fragment`);
  if (port != null && Number(url.port || 80) !== port) {
    refusals.push(`${name} port ${url.port || 80} is not this checkout's stack port ${port} (supabase/config.toml)`);
  }
}

/**
 * Every refusal for the given environment. An empty list is the only safe answer.
 *
 *   env         the variables the tests will read
 *   stack       readStackConfig(config.toml) for this checkout
 *   require     which targets must be present: "api" for integration and E2E; "e2e" adds the app
 */
/** @param {Record<string, string | undefined>} env @param {{ projectId: string | null, apiPort: number | null, dbPort: number | null }} stack @param {{ require?: string[] }} [options] @returns {string[]} */
export function targetRefusals(env, stack, { require = ["api"] } = {}) {
  const refusals = [];
  if (!stack.projectId || !stack.apiPort || !stack.dbPort) {
    refusals.push("supabase/config.toml does not declare project_id, [api] port and [db] port");
  }

  const api = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (require.includes("api") || api) checkHttp("NEXT_PUBLIC_SUPABASE_URL", api, refusals, stack.apiPort);
  // Older tests read this name; it must name the same stack when it is set at all.
  if (env.SUPABASE_URL) checkHttp("SUPABASE_URL", env.SUPABASE_URL, refusals, stack.apiPort);

  for (const name of ["SUPABASE_DB_URL", "SUPABASE_SUPERUSER_DB_URL"]) {
    const value = env[name];
    if (!value) continue;
    const url = parse(value);
    if (!url) {
      refusals.push(`${name} is not a URL`);
      continue;
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") refusals.push(`${name} is not a postgres URL`);
    if (!LOOPBACK.has(url.hostname)) refusals.push(`${name} host ${url.hostname} is not loopback`);
    if (stack.dbPort && Number(url.port || 5432) !== stack.dbPort) {
      refusals.push(`${name} port ${url.port || 5432} is not this checkout's database port ${stack.dbPort}`);
    }
  }

  const base = env.E2E_BASE_URL;
  if (base) checkHttp("E2E_BASE_URL", base, refusals, null);

  const container = env.SUPABASE_DB_CONTAINER;
  if (container && stack.projectId && container !== `supabase_db_${stack.projectId}`) {
    refusals.push(`SUPABASE_DB_CONTAINER ${container} is not this checkout's container supabase_db_${stack.projectId}`);
  }
  return refusals;
}

/**
 * The environment the tests themselves will see: the process environment first, then
 * `.env.test.local`, then `.env.local`, the same precedence as their `dotenv` calls.
 */
/** @param {string} root @param {Record<string, string | undefined>} [env] @returns {Record<string, string | undefined>} */
export function testEnvironment(root, env = process.env) {
  const merged = {};
  for (const name of [".env.local", ".env.test.local"]) {
    const path = join(root, name);
    if (existsSync(path)) Object.assign(merged, parseDotenv(readFileSync(path, "utf8")));
  }
  return { ...merged, ...env };
}

/** Throws before anything destructive happens. `what` names the caller in the message. */
/** @param {string} what @param {{ env?: Record<string, string | undefined>, root?: string, require?: string[] }} [options] */
export function assertSafeTargets(what, { env = process.env, root = process.cwd(), require } = {}) {
  let stack;
  try {
    stack = readStackConfig(readFileSync(join(root, "supabase", "config.toml"), "utf8"));
  } catch (error) {
    throw new Error(`${what} refuses to run: supabase/config.toml cannot be read (${error.message})`);
  }
  const refusals = targetRefusals(env, stack, { require });
  if (refusals.length > 0) {
    throw new Error(
      `${what} refuses to run against these targets:\n  - ${refusals.join("\n  - ")}\n` +
        "Point them at this checkout's local Supabase stack (`npm run db:start`).",
    );
  }
  return stack;
}
