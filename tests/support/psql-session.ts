import { spawn, type ChildProcess } from "node:child_process";

import { databaseContainerName } from "@/tests/support/database";

/**
 * A psql session that STAYS OPEN, so a test can hold a transaction and watch another one race it.
 *
 * `runSql` in `tests/support/database.ts` spawns a psql, runs one thing and exits. That is the
 * right shape for almost everything and the wrong shape for the one property issue #19 turns on:
 * that the scheduled entry point COMMITS ITS CLAIM before it generates anything. Proving it needs
 * two sessions alive at the same time — one stalled mid-generation, one reading what the stalled
 * session has already committed — and a session that has exited cannot be stalled.
 *
 * A STATEMENT IS FINISHED WHEN ITS MARKER APPEARS. psql reads stdin strictly in order, so a
 * `\echo` after a statement cannot print until that statement returns. A statement that BLOCKS
 * therefore leaves its promise pending for as long as it is blocked, which is exactly the signal
 * the concurrency test needs: `settled()` answers "has this worker got past that point yet?"
 * without guessing from a sleep.
 *
 * `ON_ERROR_STOP` IS OFF HERE. A session that exited on the first error could not report what
 * happened next, and these tests care about what a worker does AFTER something has gone wrong.
 * stderr is collected into the same transcript so a failed assertion can show it.
 */
export type PsqlSession = {
  /** Runs one statement and resolves with everything it printed. Stays pending while blocked. */
  send(sql: string): Promise<string>;
  /** Whether a `send` has finished, without waiting for it. */
  settled(pending: Promise<string>): Promise<boolean>;
  /** Everything the session has printed so far, stdout and stderr together. */
  transcript(): string;
  close(): Promise<void>;
};

/** Resolves to `false` if the promise has not settled within `ms`, without disturbing it. */
export async function settledWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  const stillWaiting = Symbol("still waiting");
  const timer = new Promise<symbol>((resolve) => setTimeout(() => resolve(stillWaiting), ms));
  return (await Promise.race([pending.then(() => "settled"), timer])) !== stillWaiting;
}

export function openPsqlSession(): PsqlSession {
  const child: ChildProcess = spawn(
    "docker",
    [
      "exec", "-i", databaseContainerName(),
      "psql", "-U", "postgres", "-d", "postgres", "-X", "-t", "-A", "-q",
      "-v", "ON_ERROR_STOP=0",
    ],
    { stdio: ["pipe", "pipe", "pipe"], shell: false },
  );

  let buffer = "";
  let transcript = "";
  const waiters: { marker: string; resolve: (value: string) => void }[] = [];

  function absorb(chunk: string): void {
    buffer += chunk;
    transcript += chunk;

    // Markers arrive in the order they were sent, so only the head of the queue can be satisfied.
    while (waiters.length > 0) {
      const waiter = waiters[0]!;
      const at = buffer.indexOf(waiter.marker);
      if (at === -1) return;
      const printed = buffer.slice(0, at);
      buffer = buffer.slice(at + waiter.marker.length);
      waiters.shift();
      waiter.resolve(printed.trim());
    }
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);

  let sequence = 0;

  return {
    send(sql: string): Promise<string> {
      const marker = `--fv-done-${++sequence}--`;
      const settled = new Promise<string>((resolve) => waiters.push({ marker, resolve }));
      // `\echo` is a psql meta-command, so it is not part of the statement's transaction and
      // cannot itself be blocked by anything the statement is waiting on.
      child.stdin?.write(`${sql}\n\\echo ${marker}\n`);
      return settled;
    },

    settled(pending: Promise<string>): Promise<boolean> {
      return settledWithin(pending, 0);
    },

    transcript(): string {
      return transcript;
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        child.once("close", () => resolve());
        child.stdin?.end();
        // A session wedged behind somebody else's lock will not read `\q`; the test must not hang
        // on tidying up after itself.
        const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("close", () => clearTimeout(kill));
      });
    },
  };
}
