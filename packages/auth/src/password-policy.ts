/**
 * Password policy.
 *
 * Two things are separated here on purpose, because they are different questions:
 *
 *   WHAT IS SECURE — NIST SP 800-63B: length, breach-checking, and rejection of
 *   repetitive or sequential strings. Composition rules (an uppercase, a digit, a
 *   symbol) are NOT recommended: they reliably produce `Password1!`, push people toward
 *   reuse, and buy little against an offline attack.
 *
 *   WHAT IS REQUIRED — compliance frameworks and customer security questionnaires do
 *   not all agree with NIST. PCI DSS 4.0 §8.3.6 mandates at least 12 characters AND
 *   both numeric and alphabetic characters. An auditor reading that checklist is not
 *   persuaded by a citation.
 *
 * So composition is CONFIGURABLE and defaults to off. When PorterDirect enters PCI
 * scope — likely once tenants take payments through Connect — or a medical or legal
 * customer demands it, that becomes a config change rather than a rewrite. The policy
 * is data, not an opinion baked into the code.
 */

export const MIN_PASSWORD_LENGTH = 12;
/** Generous on purpose. Truncating a passphrase silently is how people get locked out. */
export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** Composition requirements. All false under NIST. */
  readonly requireLetter: boolean;
  readonly requireDigit: boolean;
  readonly requireSymbol: boolean;
  readonly requireMixedCase: boolean;
}

/** Default. Length, breach-checking and low-entropy rejection; no character classes. */
export const NIST_POLICY: PasswordPolicy = {
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
  requireLetter: false,
  requireDigit: false,
  requireSymbol: false,
  requireMixedCase: false,
};

/**
 * PCI DSS 4.0 §8.3.6: minimum twelve characters containing both numeric and alphabetic
 * characters. Symbols and mixed case are NOT mandated by that requirement, so they are
 * not enabled here — a policy stricter than the standard it cites is still a policy
 * nobody chose.
 */
export const PCI_DSS_POLICY: PasswordPolicy = {
  ...NIST_POLICY,
  requireLetter: true,
  requireDigit: true,
};

export function policyByName(name: string | undefined): PasswordPolicy {
  return name?.toLowerCase() === "pci" ? PCI_DSS_POLICY : NIST_POLICY;
}

export type PasswordRejection =
  | "too-short"
  | "too-long"
  | "whitespace-only"
  | "contains-email"
  | "contains-product-name"
  | "too-common"
  | "repetitive"
  | "sequential"
  | "missing-letter"
  | "missing-digit"
  | "missing-symbol"
  | "missing-mixed-case"
  | "breached";

export interface PasswordVerdict {
  readonly ok: boolean;
  readonly reasons: readonly PasswordRejection[];
}

/**
 * A deliberately small list — the offline floor that still applies when the breach
 * service is unreachable. It is not a substitute for the breach check.
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

/** Rows a finger walks along. Sequences here look random and are not. */
const KEYBOARD_RUNS = [
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1234567890",
  "!@#$%^&*()",
];

export interface PasswordContext {
  readonly email?: string;
}

/**
 * Is the password mostly one character, or a long run of the same one?
 *
 * `aaaaaaaaaaaa` satisfies a twelve-character minimum while carrying almost no entropy,
 * and NIST names exactly this case. Measured by DISTINCT characters rather than by
 * pattern-matching, so `abababababab` is caught by the same rule.
 */
function isRepetitive(password: string): boolean {
  const chars = [...password];
  const distinct = new Set(chars).size;
  if (distinct <= 4) return true;

  let run = 1;
  for (let i = 1; i < chars.length; i++) {
    run = chars[i] === chars[i - 1] ? run + 1 : 1;
    if (run >= 5) return true;
  }
  return false;
}

/**
 * Does the password contain a long ascending/descending run, or a keyboard row?
 *
 * Five is the threshold: shorter runs occur in ordinary words ("abbey" has none, but
 * "rst" appears in "worst"), and rejecting those would fail real passphrases.
 */
function isSequential(password: string): boolean {
  const lower = password.toLowerCase();

  let asc = 1;
  let desc = 1;
  for (let i = 1; i < lower.length; i++) {
    const delta = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    asc = delta === 1 ? asc + 1 : 1;
    desc = delta === -1 ? desc + 1 : 1;
    if (asc >= 5 || desc >= 5) return true;
  }

  for (const row of KEYBOARD_RUNS) {
    const reversed = [...row].reverse().join("");
    for (let i = 0; i + 5 <= row.length; i++) {
      if (lower.includes(row.slice(i, i + 5))) return true;
      if (lower.includes(reversed.slice(i, i + 5))) return true;
    }
  }
  return false;
}

/** Synchronous rules. Everything checkable without a network call. */
export function checkPassword(
  password: string,
  context: PasswordContext = {},
  policy: PasswordPolicy = NIST_POLICY,
): PasswordVerdict {
  const reasons: PasswordRejection[] = [];

  // Length is counted in CODE POINTS, not UTF-16 units: "🔒" is one character to a
  // person and two to `.length`, so six emoji would otherwise pass as twelve.
  const codePoints = [...password].length;

  if (codePoints < policy.minLength) reasons.push("too-short");
  if (codePoints > policy.maxLength) reasons.push("too-long");
  if (password.length > 0 && password.trim().length === 0) reasons.push("whitespace-only");

  const lower = password.toLowerCase();

  if (context.email) {
    const local = context.email.split("@")[0]?.toLowerCase() ?? "";
    // Only meaningful local parts — a two-letter address would reject almost everything.
    if (local.length >= 4 && lower.includes(local)) reasons.push("contains-email");
  }

  if (PRODUCT_TERMS.some((term) => lower.includes(term))) reasons.push("contains-product-name");
  if (COMMON.has(lower)) reasons.push("too-common");

  // Only worth checking once the password is long enough to be considered at all.
  if (codePoints >= policy.minLength) {
    if (isRepetitive(password)) reasons.push("repetitive");
    if (isSequential(password)) reasons.push("sequential");
  }

  // Composition — off under NIST, on where a framework demands it.
  if (policy.requireLetter && !/\p{L}/u.test(password)) reasons.push("missing-letter");
  if (policy.requireDigit && !/\p{Nd}/u.test(password)) reasons.push("missing-digit");
  if (policy.requireSymbol && !/[^\p{L}\p{Nd}\s]/u.test(password)) reasons.push("missing-symbol");
  if (policy.requireMixedCase && !(/\p{Ll}/u.test(password) && /\p{Lu}/u.test(password))) {
    reasons.push("missing-mixed-case");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Has this password appeared in a known breach?
 *
 * Uses Have I Been Pwned's k-anonymity range API: only the FIRST FIVE characters of the
 * SHA-1 hash ever leave this process, and the response is a list of hash suffixes
 * matched locally. The password — and the full hash — are never transmitted.
 *
 * Fails OPEN. If the service is unreachable we allow the password rather than blocking
 * signup over a third-party outage; the synchronous rules above still apply.
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

export const PASSWORD_MESSAGES: Record<PasswordRejection, string> = {
  "too-short": `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  "too-long": `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
  "whitespace-only": "A password cannot be only spaces.",
  "contains-email": "Your password cannot contain your email address.",
  "contains-product-name": "Your password cannot contain the product name.",
  "too-common": "That password is too common. Choose something less predictable.",
  repetitive: "That password repeats too few characters. Add more variety.",
  sequential: "Avoid runs like “abcdef”, “123456” or “qwerty”.",
  "missing-letter": "Include at least one letter.",
  "missing-digit": "Include at least one number.",
  "missing-symbol": "Include at least one symbol.",
  "missing-mixed-case": "Include both uppercase and lowercase letters.",
  breached: "That password has appeared in a known data breach. Choose a different one.",
};

/** First reason, phrased for a person. */
export function describeVerdict(verdict: PasswordVerdict): string | null {
  const first = verdict.reasons[0];
  return first ? PASSWORD_MESSAGES[first] : null;
}
