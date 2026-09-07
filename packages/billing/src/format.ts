/**
 * Money formatting. One implementation, because a price rendered two ways eventually
 * disagrees with itself — and the number on a pricing page is a promise.
 *
 * Integer cents in, string out. Never converts through a float: `19900 / 100` happens
 * to be exact, but the habit is what introduces 0.1 + 0.2 elsewhere, and `parseFloat`
 * is banned repo-wide for the same reason.
 */

/** Format integer cents as USD. Whole dollars drop the ".00" — $199, not $199.00. */
export function formatUsdCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Amount must be integer cents, received ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  const grouped = dollars.toLocaleString("en-US");
  const body = remainder === 0 ? `$${grouped}` : `$${grouped}.${String(remainder).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * Parse a dollar amount typed by a person into integer cents.
 *
 * Deliberately string-based. `Math.round(parseFloat("19.99") * 100)` is the classic way
 * money becomes 1998, and `parseFloat` is banned repo-wide for exactly that reason.
 *
 * Commas are accepted ONLY in valid thousands positions. Stripping them unconditionally
 * looked harmless and was not: "12,34" is decimal notation across most of Europe, and
 * treating the comma as a separator turned $12.34 into $1,234 — a hundredfold error, on
 * an invoice, silently. Ambiguous input is refused so a person can correct it.
 *
 * Returns null rather than guessing: a malformed price must be a visible error, never a
 * silent zero.
 */
export function parseUsdToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (!trimmed) return null;

  // Either grouped with commas in exact thousands positions, or no commas at all.
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed);
  const plain = /^\d+(\.\d{1,2})?$/.test(trimmed);
  if (!grouped && !plain) return null;

  const [whole, fraction = ""] = trimmed.replace(/,/g, "").split(".");
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
}
