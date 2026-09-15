import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** The public command every release test drives. Nothing below it is imported by a test. */
export const CONTROLLER = resolve(process.cwd(), "scripts/release/controller.mjs");

export type ControllerRun = {
  code: number | null;
  stdout: string;
  stderr: string;
};

/**
 * The parent environment minus anything that could reach a real repository or a real token, or decide
 * a test's outcome. A developer running the suite with `GITHUB_TOKEN` exported must not hand it to a
 * fixture, a stray `GIT_DIR` must not point a disposable repository at a real one, and an exported
 * `RELEASE_BUILD_PUBLICATION` must not activate publication in a test that leaves it unset.
 */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GITHUB_|GH_|GIT_|RELEASE_)/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * Runs the controller as its own process. Asynchronous on purpose: the simulated GitHub server
 * lives in this process, and a synchronous spawn would block the event loop it answers on.
 */
export function runController(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; controller?: string } = {},
): Promise<ControllerRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [options.controller ?? CONTROLLER, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...isolatedEnvironment(), ...options.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** Runs the controller with `--format json` and parses what it printed. */
export async function runControllerJson(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const run = await runController([...args, "--format", "json"], options);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    throw new Error(
      `controller did not print JSON (exit ${run.code})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return { ...run, json };
}
