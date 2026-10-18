/**
 * RFC 4180 CSV cell and row writing.
 *
 * Eval results are built from model output, so any suite name, case name or error
 * message can contain a comma, a double quote or a line break. Written raw, a comma
 * shifts every later column and a line break forges a row — a naive reader sees two
 * records where the run produced one (agent-do-wcz).
 *
 * A field needs quoting when it contains a comma, a double quote, CR or LF; inner
 * double quotes are doubled. CR is the one that was missing when this logic was
 * duplicated across two call sites: a lone CR is a row terminator to most CSV
 * readers, and `\r\n` only looked safe because it also contains `\n`.
 */
const NEEDS_QUOTING = /[",\r\n]/;

/** Render one CSV field, quoting it only when the format requires it. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return NEEDS_QUOTING.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render one CSV row (no trailing newline) from already-safe field values. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}
