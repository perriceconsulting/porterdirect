/**
 * Concrete dependencies for the password policy.
 *
 * The policy itself is pure and lives in @porterdirect/auth; this supplies the two
 * impure pieces — hashing and the network call — so the rules stay testable without
 * either.
 */
import { createHash } from "node:crypto";
import {
  checkPassword,
  describeVerdict,
  isBreachedPassword,
  policyByName,
  type PasswordContext,
} from "@porterdirect/auth";

/** SHA-1 is required by the HIBP range API. It is NOT used to store anything. */
async function sha1Hex(input: string): Promise<string> {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

async function fetchRange(prefix: string): Promise<string> {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`HIBP returned ${res.status}`);
  return res.text();
}

/**
 * Passwords the FIXTURE source reports as breached.
 *
 * Deliberately real leaked passwords rather than invented strings: a fixture asserting
 * that "test-breached-password-1" is refused proves the plumbing works and nothing about
 * whether we refuse what people actually type.
 */
const FIXTURE_BREACHED: readonly string[] = [
  "letmeinletmein",
  "passwordpassword",
  "qwertyuiop123",
  "iloveyouiloveyou",
  "trustno1trustno1",
];

/**
 * A deterministic stand-in for the HIBP range API, in the SAME wire format.
 *
 * Exists because the e2e suite was failing a different auth test on almost every full
 * run: every signup makes a live call to api.pwnedpasswords.com, the signup specs run in
 * parallel, and HIBP rate-limits. A suite that goes red for reasons unrelated to the code
 * is a suite people learn to ignore, which costs more than the coverage is worth.
 *
 * It returns real k-anonymity responses computed from the fixture list, so the CONTRACT
 * is still exercised — prefix matching, suffix comparison, the count column — rather than
 * being stubbed out. Only the network is removed.
 */
async function fixtureRange(prefix: string): Promise<string> {
  const lines: string[] = [];
  for (const candidate of FIXTURE_BREACHED) {
    const hash = createHash("sha1").update(candidate, "utf8").digest("hex").toUpperCase();
    if (hash.startsWith(prefix.toUpperCase())) lines.push(`${hash.slice(5)}:42`);
  }
  // HIBP always answers; an unlisted prefix simply matches nothing.
  return lines.join("\r\n");
}

/**
 * Which breach source to use.
 *
 * Mechanically refuses the fixture in production rather than trusting deployment
 * hygiene. A breach check that silently became a no-op in production would be the worst
 * kind of failure here: the signup form would keep saying the right things while
 * accepting passwords from every dump on the internet.
 */
export function breachSource(): typeof fetchRange {
  if (process.env.PASSWORD_BREACH_SOURCE !== "fixture") return fetchRange;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "REFUSING: PASSWORD_BREACH_SOURCE=fixture is a test seam and must never run in production.",
    );
  }
  return fixtureRange;
}

/**
 * Validate a password, including the breach check.
 *
 * Returns a human-readable message, or null when the password is acceptable.
 *
 * Two escape hatches, and they are not the same thing. `PASSWORD_BREACH_CHECK=false`
 * SKIPS the check entirely — offline development only, and it weakens the policy.
 * `PASSWORD_BREACH_SOURCE=fixture` still RUNS the check against a local list in the same
 * wire format, so a breached password is still refused and the k-anonymity comparison is
 * still exercised. Tests should reach for the second: an off-switch would make the e2e
 * assertion that a breached password is rejected pass while testing nothing.
 */
export async function validatePassword(
  password: string,
  context: PasswordContext = {},
): Promise<string | null> {
  // "nist" (default) or "pci". Composition requirements are a COMPLIANCE decision,
  // not a security one, so they live in configuration where an auditor's checklist
  // can be satisfied without a code change.
  const policy = policyByName(process.env.PASSWORD_POLICY);
  const verdict = checkPassword(password, context, policy);
  if (!verdict.ok) return describeVerdict(verdict);

  if (process.env.PASSWORD_BREACH_CHECK === "false") return null;

  const breached = await isBreachedPassword(password, { sha1Hex, fetchRange: breachSource() });
  return breached
    ? "That password has appeared in a known data breach. Choose a different one."
    : null;
}
