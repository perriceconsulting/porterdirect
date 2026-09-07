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
