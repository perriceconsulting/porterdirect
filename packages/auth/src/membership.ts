/**
 * Tenant resolution and membership lookup.
 *
 * These two queries decide, for every request, WHICH tenant is being addressed and
 * WHETHER this user belongs to it. They live in one place so no surface hand-rolls a
 * variant that forgets a predicate — a tenant-scoped query missing its scope is the
 * platform's existential failure, and it passes tests.
 */
import { and, eq } from "drizzle-orm";
import { tenantMembers, tenants, type Db } from "@porterdirect/db";
import type { Membership } from "./permissions.js";

export interface ResolvedTenant {
  readonly id: string;
  readonly name: string;
}

/**
 * Find the tenant serving a host. Returns null when no tenant claims it.
 *
 * Callers must treat null as "not found" and stop. There is deliberately no default
 * tenant: falling back would serve one licensee's data on another licensee's domain.
 */
export async function findTenantByHost(db: Db, host: string): Promise<ResolvedTenant | null> {
  const [row] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.primaryHost, host))
    .limit(1);
  return row ?? null;
}

/**
 * Find this user's membership in this tenant.
 *
 * Scoped by BOTH ids in one predicate. Looking up by user alone and filtering the
 * tenant in application code is the shape that leaks: a forgotten filter returns a
 * membership for the wrong tenant, and every downstream check then passes honestly
 * against the wrong scope.
 */
export async function findMembership(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<Membership | null> {
  const [row] = await db
    .select({
      tenantId: tenantMembers.tenantId,
      userId: tenantMembers.userId,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** Every tenant this user belongs to — for a tenant switcher, never for access. */
export async function listMembershipsForUser(db: Db, userId: string): Promise<Membership[]> {
  return db
    .select({
      tenantId: tenantMembers.tenantId,
      userId: tenantMembers.userId,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId));
}

/**
 * Resolve a membership for a tenant named by the REQUEST (a path segment), not the host.
 *
 * The rule elsewhere is "the tenant comes from the host, never the request", and this
 * looks like an exception. It is not, and the distinction matters:
 *
 *   Unsafe  — take a tenant id from the request and TRUST it.
 *   Safe    — take a tenant id from the request and go and LOOK UP whether this user
 *             belongs to it. The database answers; the request only proposes.
 *
 * An operator console needs this: one person may own two brands, and a contractor may
 * drive for two firms, so the console cannot be pinned to a single host. What makes it
 * safe is that the query is scoped by BOTH ids, so a forged tenant id returns null
 * rather than someone else's membership.
 *
 * Note this is deliberately the same query as `findMembership` — the point is that
 * there is no second, looser path. Do not add one.
 */
export async function resolveConsoleMembership(
  db: Db,
  userId: string,
  requestedTenantId: string,
): Promise<Membership | null> {
  // A malformed id must not reach the database as a cast error that leaks as a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedTenantId)) {
    return null;
  }
  return findMembership(db, userId, requestedTenantId);
}
