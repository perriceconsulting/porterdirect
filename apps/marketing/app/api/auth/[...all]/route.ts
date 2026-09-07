/**
 * Better Auth's own endpoints: sign-up, sign-in, sign-out, session.
 *
 * Node runtime — the adapter reaches Postgres, and password hashing needs Node crypto.
 * Never cached: every response here is session-specific.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = toNextJsHandler(getAuth());
