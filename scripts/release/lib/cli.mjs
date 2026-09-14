/**
 * What every command shares: exit statuses, usage errors, argument patterns, output formats, and the
 * two files a workflow step can hand a command — its step outputs and its job summary.
 */

import { appendFileSync } from "node:fs";

export const EXIT = Object.freeze({
  ok: 0,
  failure: 1,
  usage: 2,
  pending: 3,
  refused: 4,
  failedGate: 5,
  disabled: 6,
});

export class UsageError extends Error {}

export const REPOSITORY = /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const REF = /^(?!-)[A-Za-z0-9._/-]+$/;
const POSITIVE_INTEGER = /^[1-9]\d{0,15}$/;

export function readFormat(value, allowed = ["markdown", "json"]) {
  const format = value ?? allowed[0];
  if (!allowed.includes(format)) {
    throw new UsageError(`--format must be ${allowed.join(" or ")}`);
  }
  return format;
}

export function readPositiveInteger(value, name) {
  if (value === undefined) return null;
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return Number(value);
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Appends `name=value` lines to a GitHub Actions outputs file. Every value comes from the controller,
 * but a line break inside one would let it declare a second output, so it is refused outright.
 */
export function appendOutputs(file, values) {
  const lines = Object.entries(values).map(([name, value]) => {
    const text = value === null || value === undefined ? "" : String(value);
    if (/[\r\n]/.test(text)) throw new Error(`output ${name} contains a line break`);
    return `${name}=${text}\n`;
  });
  appendFileSync(file, lines.join(""));
}

export function appendText(file, text) {
  appendFileSync(file, text);
}
