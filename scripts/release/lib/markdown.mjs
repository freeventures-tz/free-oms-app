/**
 * Titles, bodies and commit subjects are written by people and arrive as data. In Markdown they are
 * rendered, so the characters that would turn them into markup, links or HTML are escaped.
 */
export function escapeMarkdown(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]|#])/g, "\\$1");
}
