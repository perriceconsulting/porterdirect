/**
 * Password policy.
 *
 * Deliberately follows NIST SP 800-63B rather than the older
 * uppercase-digit-symbol convention, because composition rules make passwords WORSE:
 * they produce `Password1!`, they push people toward reuse, and they buy almost nothing
 * against an offline attack. Length and breach-checking are what actually help.
 *
 * So:
 *   - a real minimum LENGTH (12), well above the NIST floor of 8
 *   - a generous maximum (128) — long enough for a passphrase or a manager's output,
 *     capped only so a megabyte of input cannot be fed to the hasher
 *   - NO required character classes
 *   - every printable character allowed, including spaces and Unicode
 *   - rejection of passwords that are CONTEXTUALLY obvious (the user's own email, this
 *     product's name) and of known-breached passwords
 *
 * Everything here except the breach check is pure and synchronous, so the rules are
 * millisecond unit tests rather than something only observable through a signup form.
 */

export const MIN_PASSWORD_LENGTH = 12;
/** Generous on purpose. Truncating a passphrase silently is how people get locked out. */
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordRejection =
  | "too-short"
  | "too-long"
  | "whitespace-only"
  | "contains-email"
  | "contains-product-name"
  | "too-common"
  | "breached";

export interface PasswordVerdict {
  readonly ok: boolean;
  readonly reasons: readonly PasswordRejection[];
}

/**
 * A deliberately small list. This is NOT a substitute for the breach check — it is the
 * offline floor that still applies when the breach service is unreachable, covering the
 * handful of passwords that would otherwise pass a 12-character minimum.
 */
const COMMON = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "letmein12345",
  "iloveyou1234",
  "welcome12345",
  "administrator",
  "changemenow1",
  "trustno1trustno1",
  "qwertyuiopasdfgh",
]);

const PRODUCT_TERMS = ["porterdirect", "porter direct"];

export interface PasswordContext {
  /** The account's email, so the password cannot simply restate it. */
  readonly email?: string;
}

/** Synchronous rules. Everything checkable without a network call. */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordVerdict {
  const reasons: PasswordRejection[] = [];

  // Length is counted in CODE POINTS, not UTF-16 units: "🔒" is one character to a
  // person and two to `.length`, and a passphrase of emoji should not be over-counted.
  const codePoints = [...password].length;

  if (codePoints < MIN_PASSWORD_LENGTH) reasons.push("too-short");
  if (codePoints > MAX_PASSWORD_LENGTH) reasons.push("too-long");
  if (password.trim().length === 0 && password.length > 0) reasons.push("whitespace-only");

  const lower = password.toLowerCase();

  if (context.email) {
    const local = context.email.split("@")[0]?.toLowerCase() ?? "";
    // Only meaningful local parts — a two-letter address would reject almost everything.
    if (local.length >= 4 && lower.includes(local)) reasons.push("contains-email");
  }

  if (PRODUCT_TERMS.some((term) => lower.includes(term))) reasons.push("contains-product-name");
  if (COMMON.has(lower)) reasons.push("too-common");

  return { ok: reasons.length === 0, reasons };
}

/**
 * Has this password appeared in a known breach?
 *
 * Uses Have I Been Pwned's k-anonymity range API: only the FIRST FIVE characters of the
 * SHA-1 hash ever leave this process, and the response is a list of hash suffixes we
 * match locally. The password itself — and the full hash — are never transmitted.
 *
 * Fails OPEN. If the service is unreachable we allow the password rather than locking
 * people out of signup over a third-party outage; the synchronous rules above still
 * apply, and blocking all registration because a list is down is the worse failure.
 */
export async function isBreachedPassword(
  password: string,
  deps: {
    sha1Hex: (input: string) => Promise<string>;
    fetchRange: (prefix: string) => Promise<string>;
  },
): Promise<boolean> {
  try {
    const hash = (await deps.sha1Hex(password)).toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const body = await deps.fetchRange(prefix);
    for (const line of body.split("\n")) {
      const [candidate] = line.trim().split(":");
      if (candidate && candidate.toUpperCase() === suffix) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Human-readable copy for each rejection. */
export const PASSWORD_MESSAGES: Record<PasswordRejection, string> = {
  "too-short": `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  "too-long": `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
  "whitespace-only": "A password cannot be only spaces.",
  "contains-email": "Your password cannot contain your email address.",
  "contains-product-name": "Your password cannot contain the product name.",
  "too-common": "That password is too common. Choose something less predictable.",
  breached: "That password has appeared in a known data breach. Choose a different one.",
};

/** First reason, phrased for a person. */
export function describeVerdict(verdict: PasswordVerdict): string | null {
  const first = verdict.reasons[0];
  return first ? PASSWORD_MESSAGES[first] : null;
}
