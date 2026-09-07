/**
 * The Better Auth instance.
 *
 * Config arrives as ARGUMENTS, never from process.env — the lint rule enforcing that in
 * `packages/**` is deliberate: a library that reads the environment cannot be tested
 * without one, and it hides which surface actually owns a secret. The wiring layer
 * (apps/marketing) reads env and passes it in.
 *
 * Better Auth owns IDENTITY. It does not know about tenants, and must not: tenant
 * membership lives in `tenant_members` with real foreign keys, and is resolved
 * separately (see membership.ts). Keeping the two apart is what stops a second,
 * competing notion of "organization" appearing beside the canonical `tenants`.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { accounts, sessions, users, verifications, type Db } from "@porterdirect/db";

export interface AuthConfig {
  readonly db: Db;
  /** Signing secret. Rotating it invalidates every live session, by design. */
  readonly secret: string;
  /** Public origin this instance is reached on, e.g. https://porterdirect.com */
  readonly baseURL: string;
  /** Extra origins permitted to hold a session cookie — tenant CNAMEs, in practice. */
  readonly trustedOrigins?: readonly string[];
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(config: AuthConfig) {
  if (!config.secret) {
    throw new Error("BETTER_AUTH_SECRET is required but not set.");
  }
  if (config.secret.length < 32) {
    // A short secret still signs successfully, so this would otherwise be a silent
    // weakness rather than a visible failure.
    throw new Error(
      `BETTER_AUTH_SECRET is too short (${config.secret.length} chars); use at least 32.`,
    );
  }

  return betterAuth({
    database: drizzleAdapter(config.db, {
      provider: "pg",
      // Our exported constants are plural; Better Auth's models are singular. Mapping
      // explicitly beats renaming the schema to satisfy a library.
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins ? [...config.trustedOrigins] : undefined,
    emailAndPassword: {
      enabled: true,
      // Operators are invited into a tenant, not self-served into one. Sign-up exists
      // so an invite can be accepted; it never creates a tenant on its own.
      autoSignIn: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      // Cookies must not leak across a tenant's custom domain boundary.
      useSecureCookies: config.baseURL.startsWith("https://"),
    },
  });
}
