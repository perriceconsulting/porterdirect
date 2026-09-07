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
 * Validate a password, including the breach check.
 *
 * Returns a human-readable message, or null when the password is acceptable. The breach
 * check is skipped when PASSWORD_BREACH_CHECK is explicitly "false" — useful for offline
 * development and for tests that must not reach the network.
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

  const breached = await isBreachedPassword(password, { sha1Hex, fetchRange });
  return breached
    ? "That password has appeared in a known data breach. Choose a different one."
    : null;
}
