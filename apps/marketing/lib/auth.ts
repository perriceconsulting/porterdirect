/**
 * The app's Better Auth instance and request-scoped tenant context.
 *
 * This is the wiring layer: it reads the environment (which the packages deliberately
 * cannot) and hands config down. Everything security-relevant it does is delegated to
 * @porterdirect/auth so the policy stays in one testable place.
 */
import { headers } from "next/headers";
import { nextCookies } from "better-auth/next-js";
import { createDbClient } from "@porterdirect/db";
import {
  authorize,
  classifyHost,
  createAuth,
  findMembership,
  findTenantByHost,
  type Auth,
  type Membership,
  type Permission,
  type ResolvedTenant,
} from "@porterdirect/auth";

/**
 * Built once per process. Next dev hot-reloads modules, so the instance is hung off
 * globalThis with a contract version — a stale instance surviving a config change is
 * the same trap the webhook adapters hit.
 */
const AUTH_CONTRACT_VERSION = 1;
const g = globalThis as unknown as Record<string, unknown>;
const authKey = `__pdAuth_v${AUTH_CONTRACT_VERSION}`;

export function getAuth(): Auth {
  const cached = g[authKey] as Auth | undefined;
  if (cached) return cached;

  const built = createAuth({
    db: createDbClient(process.env.DATABASE_URL),
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    // Lets a server action set the session cookie. Injected here rather than in the
    // auth package so that package stays framework-agnostic for the driver app.
    plugins: [nextCookies()],
  });
  g[authKey] = built;
  return built;
}

export interface RequestContext {
  /** The tenant this request addresses, or null on a platform surface. */
  readonly tenant: ResolvedTenant | null;
  /** The signed-in user's id, or null. */
  readonly userId: string | null;
  /** This user's membership in THIS tenant, or null. */
  readonly membership: Membership | null;
}

/**
 * Resolve who is asking and which tenant they are asking about.
 *
 * Deliberately resolves the tenant from the HOST rather than from anything the client
 * sends — a tenant id in a query string or body is attacker-controlled, and trusting it
 * turns every endpoint into a cross-tenant read.
 */
export async function getRequestContext(): Promise<RequestContext> {
  const h = await headers();
  const classified = classifyHost(h.get("host"));

  const db = createDbClient(process.env.DATABASE_URL);
  const session = await getAuth().api.getSession({ headers: h });
  const userId = session?.user?.id ?? null;

  if (!classified || classified.kind === "platform") {
    return { tenant: null, userId, membership: null };
  }

  const tenant = await findTenantByHost(db, classified.host);
  if (!tenant) {
    // An unknown host is a 404, never a fallback to some default tenant.
    return { tenant: null, userId, membership: null };
  }

  const membership = userId ? await findMembership(db, userId, tenant.id) : null;
  return { tenant, userId, membership };
}

/**
 * Authorize a request against the tenant its HOST resolved to, and return the context.
 * Throws on refusal — callers turn that into a 403 rather than a silent empty result,
 * because a quietly empty list reads as "no data" instead of "not allowed".
 */
export async function requirePermission(permission: Permission): Promise<RequestContext> {
  const ctx = await getRequestContext();
  if (!ctx.tenant) {
    throw new Error("No tenant resolved for this host");
  }
  authorize(ctx.membership, ctx.tenant.id, permission);
  return ctx;
}
