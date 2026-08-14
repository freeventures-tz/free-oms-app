import { randomInt } from "node:crypto";

import { PASSWORD_POLICY, passwordMeetsPolicy } from "@/lib/auth/password-policy";

export { PASSWORD_POLICY, passwordMeetsPolicy };

/**
 * Temporary passwords.
 *
 * Displayed exactly once, read aloud or copied, then replaced at first login. They are never
 * persisted anywhere — not in a table, not in a job row, not in a log (architecture.md §7.7) — so
 * the only copy that exists is the one on the Director's screen for the length of that response.
 *
 * The alphabet omits characters that are misread when a number is dictated over a phone:
 * O/0, I/l/1, and symbols. Length compensates for the smaller alphabet.
 */
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const ALPHABET = UPPER + LOWER + DIGITS;

/** Matches the Auth policy in config.toml: 12 minimum, lower + upper + digits. */
export const TEMPORARY_PASSWORD_LENGTH = 16;

function pick(source: string): string {
  return source[randomInt(0, source.length)];
}

export function generateTemporaryPassword(): string {
  // One of each required class first, so the result cannot fail the policy by chance.
  const characters = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (characters.length < TEMPORARY_PASSWORD_LENGTH) characters.push(pick(ALPHABET));

  // Fisher–Yates with a CSPRNG, so the guaranteed classes are not always in the first positions.
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }

  return characters.join("");
}

