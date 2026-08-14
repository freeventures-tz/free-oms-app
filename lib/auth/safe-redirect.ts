/**
 * Where a `?next=` value is allowed to send someone.
 *
 * THE DEFECT THIS CLOSES
 *   The sign-in action accepted any value starting with `/`. `//evil.example` starts with `/` and is
 *   a protocol-relative URL: browsers resolve it to `https://evil.example`. A link to our own
 *   sign-in page could therefore land a member of staff on somebody else's site immediately after
 *   they typed their password — the ideal setup for a convincing phishing page.
 *
 * The rule is an allow-list, not a block-list: a value is accepted only if it is a single-slash,
 * same-origin, printable path. Everything else falls back to the role landing, which is resolved
 * server-side anyway, so rejecting is never a dead end.
 */

/**
 * Checked by code point rather than by a character class. A regex literal for this range puts raw
 * control bytes in the source file — including a NUL — where an editor or a re-encoding can quietly
 * change what the rule means.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 512) return null;

  // Control characters and whitespace are used to smuggle a scheme past a naive prefix check.
  if (hasControlCharacter(candidate) || /\s/.test(candidate)) return null;

  // Browsers treat backslashes as slashes in several positions (`/\evil.example`,
  // `\\evil.example`), so they are never allowed anywhere in the value.
  if (candidate.includes("\\")) return null;

  // Must be a rooted path, and must not be protocol-relative.
  if (!candidate.startsWith("/")) return null;
  if (candidate.startsWith("//")) return null;

  // An absolute URL cannot survive the checks above, but resolve it anyway and insist the origin
  // did not move. This is the check that still holds if someone edits the ones above.
  let resolved: URL;
  try {
    resolved = new URL(candidate, "http://localhost");
  } catch {
    return null;
  }
  if (resolved.origin !== "http://localhost") return null;
  if (!resolved.pathname.startsWith("/") || resolved.pathname.startsWith("//")) return null;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
