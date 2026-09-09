/**
 * Operator console access.
 *
 * The tenant is named by the URL here rather than the host, because one person may run
 * two brands and a contractor may drive for two firms — a console pinned to one host
 * cannot serve either. What keeps that safe is that the request only PROPOSES a tenant:
 * `resolveConsoleMembership` goes and looks up whether this user actually belongs to it,
 * scoped by both ids, so a guessed or forged id returns null rather than someone else's
 * membership.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { createDbClient, subscriptions, tenants, tenantMembers, users, type Db } from "@porterdirect/db";
import {
  authorize,
  listMembershipsForUser,
  resolveConsoleMembership,
  type Membership,
  type Permission,
  type TenantRole,
} from "@porterdirect/auth";
import type { SubscriptionStatus } from "@porterdirect/billing";
import { getAuth } from "./auth";

export interface ConsoleTenant {
  readonly id: string;
  readonly name: string;
  readonly host: string | null;
  readonly stripeCustomerId: string | null;
  /** ISO 3166-1 alpha-2. Decides how this operator's phone numbers read. */
  readonly defaultCountry: string;
}

export interface ConsoleSubscription {
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly seatCount: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface ConsoleContext {
  readonly db: Db;
  readonly userId: string;
  readonly tenant: ConsoleTenant;
  readonly membership: Membership;
  readonly subscription: ConsoleSubscription | null;
}

/**
 * Where a member belongs after signing in, accepting an invite, or asking for "home".
 *
 * ONE decision, in one place, because it was previously made implicitly at four separate
 * redirects and every one of them chose the console. A driver's first experience of the
 * product — accepting the invitation that brought them onto it — was a dispatcher's
 * screen, and `/drive` was unreachable unless somebody told them the URL.
 *
 * The rule is deliberately about what a member can ONLY do, not about seniority: an owner
 * who also drives keeps the console as home and reaches `/drive` from the header, because
 * they have office work to do as well. Someone who can only carry parcels has no office
 * work, so sending them to an office is sending them somewhere with nothing on it.
 */
export function homePathForRole(role: TenantRole, tenantId: string): string {
  return role === "driver" ? `/drive/${tenantId}` : `/dashboard/${tenantId}`;
}

/** True when this member has nothing to do in the console. Drives nav, not access. */
export function isDriverOnly(role: TenantRole): boolean {
  return role === "driver";
}

/** Signed-in user id, or a redirect to sign-in. */
export async function requireUserId(): Promise<string> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/signin");
  return session.user.id;
}

/** Every tenant this user belongs to, with names, for the picker. */
export async function listConsoleTenants(
  db: Db,
  userId: string,
): Promise<Array<ConsoleTenant & { role: string }>> {
  const memberships = await listMembershipsForUser(db, userId);
  const out: Array<ConsoleTenant & { role: string }> = [];
  for (const m of memberships) {
    const [t] = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        host: tenants.primaryHost,
        stripeCustomerId: tenants.stripeCustomerId,
        defaultCountry: tenants.defaultCountry,
      })
      .from(tenants)
      .where(eq(tenants.id, m.tenantId))
      .limit(1);
    if (t) out.push({ ...t, role: m.role });
  }
  return out;
}

/**
 * Load the console for one tenant, refusing anything this user may not do.
 *
 * Redirects rather than throwing for the two cases a person can act on — not signed in,
 * or not a member — because a raw 403 page on a console is a dead end.
 */
export async function requireConsole(
  tenantId: string,
  permission: Permission,
): Promise<ConsoleContext> {
  const userId = await requireUserId();
  const db = createDbClient(process.env.DATABASE_URL);

  const membership = await resolveConsoleMembership(db, userId, tenantId);
  // Not a member — or the id was never real. Both land here, and deliberately look the
  // same: confirming that a tenant exists is itself information.
  if (!membership) redirect("/dashboard");

  authorize(membership, tenantId, permission);

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      host: tenants.primaryHost,
      stripeCustomerId: tenants.stripeCustomerId,
      defaultCountry: tenants.defaultCountry,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) redirect("/dashboard");

  const [sub] = await db
    .select({
      planId: subscriptions.planId,
      status: subscriptions.status,
      seatCount: subscriptions.seatCount,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  return {
    db,
    userId,
    tenant,
    membership,
    subscription: sub
      ? {
          planId: sub.planId,
          status: sub.status as SubscriptionStatus,
          seatCount: sub.seatCount,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd === 1,
        }
      : null,
  };
}

export interface TeamMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly isYou: boolean;
}

/** The tenant's roster. Scoped by tenant id in the join, not filtered afterwards. */
export async function listTeam(
  db: Db,
  tenantId: string,
  viewerId: string,
): Promise<TeamMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId));

  return rows.map((r) => ({ ...r, isYou: r.userId === viewerId }));
}
