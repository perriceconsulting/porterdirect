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
