/**
 * Invite token primitives, shared by staff invitations and customer invitations.
 *
 * The DOSI rule-of-three says tolerate duplication until the third repeat, and this is
 * only the second. It is extracted anyway, because the caveat that decides the case is
 * what divergence COSTS: two copies of a formatting helper drift into an inconsistency,
 * while two copies of this drift into a vulnerability. A second implementation that
 * reached for `===` instead of `timingSafeEqual`, or skipped the length guard, would
 * still pass every test that exists — a token comparison does not fail visibly when it
 * is done carelessly, it just becomes guessable.
 *
 * An invite token is a BEARER CREDENTIAL: whoever holds the link gets whatever it
 * grants. That shapes all of this —
 *
 *   generated with crypto randomness, never a guessable id;
 *   stored HASHED, so a database leak grants nothing;
 *   compared in constant time, so no attempt reveals how much of it was right.
 *
 * What it GRANTS stays with each caller: staff invitations hand out a role in the
 * authorization matrix, customer invitations open an account. Those are different
 * decisions and deliberately do not live here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Seven days. Long enough to be found, short enough not to linger in an inbox. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 32 bytes of crypto randomness, base64url.
 *
 * NOT a uuid: a uuid is an identifier, it reads like something safe to quote, and it
 * ends up in logs and referrer headers. base64url so it survives a URL, an SMS and a QR
 * code without escaping.
 */
export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare a stored hash against the hash of a presented token, in constant time.
 *
 * The length check first is not redundant: `timingSafeEqual` THROWS on buffers of
 * different lengths, so without it a malformed row turns a refusal into a 500 — which is
 * itself an oracle, because it distinguishes one kind of miss from another.
 */
export function inviteTokenMatches(storedHash: string, presentedHash: string): boolean {
  const a = Buffer.from(storedHash, "utf8");
  const b = Buffer.from(presentedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Addresses are matched case-insensitively so an invite to `Ana@firm.com` is accepted by
 * an account registered as `ana@firm.com`.
 *
 * Note the deliberate difference from `orders.customer_email`, which is stored AS GIVEN:
 * that one is a delivery address for a receipt, where lower-casing or stripping a `+tag`
 * is how the address that would have worked gets broken. This one is only ever compared,
 * never sent to.
 */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}
