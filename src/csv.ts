/**
 * CSV for exports that get opened in a spreadsheet.
 *
 * Both exports that exist — the audit trail and the superbill — are read by
 * exactly the sort of person who opens an attachment without thinking about it,
 * so the formula-injection defence lives here rather than in whichever module
 * remembered it.
 */

export const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Prefixing a formula character defuses spreadsheet injection: a leading
  // `=`, `+`, `-` or `@` is a program, not a value.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Header row plus one line per row, columns in the given order. */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
  ].join('\n');
}
