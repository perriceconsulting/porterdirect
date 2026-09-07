/**
 * Classifying errors thrown by the auth API, WITHOUT `instanceof`.
 *
 * `instanceof` compares class identity, and a bundler can hand the same class to two
 * modules as two different identities. That is exactly what happened here: in plain Node
 * `err instanceof APIError` is true, but inside a Next server action the check silently
 * returned false, the handler fell through to a rethrow, and a wrong password surfaced as
 * an unhandled runtime error page instead of "that email and password do not match".
 *
 * A failed sign-in is the single most common path through this code. It must be
 * classified by SHAPE, which survives bundling, duplicate installs and version skew.
 */

export interface AuthApiError {
  /** Symbolic status, e.g. "UNAUTHORIZED". */
  readonly status: string;
  /** Numeric HTTP status, e.g. 401. */
  readonly statusCode: number;
  readonly message: string;
}

/**
 * Next's `redirect()` signals navigation by THROWING. Any catch block that swallows it
 * turns a redirect into a hang or a blank page, so it must always be identified and
 * rethrown before anything else is considered.
 */
export function isRedirectError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND");
}

/** Does this error carry the shape of an auth API failure? */
export function isAuthApiError(err: unknown): err is AuthApiError {
  if (isRedirectError(err)) return false;
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.statusCode === "number" &&
    typeof e.status === "string" &&
    typeof e.message === "string"
  );
}

export type AuthFailure =
  | "bad-credentials"
  | "email-taken"
  | "weak-password"
  | "rate-limited"
  | "unknown";

/**
 * Map an auth failure onto the codes the UI knows how to phrase.
 *
 * Sign-in failures collapse to ONE code on purpose: distinguishing "no such account"
 * from "wrong password" hands an attacker a free account-enumeration oracle, so the
 * caller must never be able to tell them apart.
 */
export function classifyAuthError(err: unknown): AuthFailure {
  if (!isAuthApiError(err)) return "unknown";

  const message = err.message.toLowerCase();

  if (err.statusCode === 429) return "rate-limited";
  if (message.includes("password") && (message.includes("short") || message.includes("length"))) {
    return "weak-password";
  }
  if (message.includes("already exists") || message.includes("already registered")) {
    return "email-taken";
  }
  if (err.statusCode === 401 || err.statusCode === 403) return "bad-credentials";
  if (err.statusCode === 422 || err.statusCode === 400) return "email-taken";

  return "unknown";
}
