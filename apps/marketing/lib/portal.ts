/**
 * Customer portal access.
 *
 * The mirror of `console.ts`, and deliberately NOT the same code. A console session
 * resolves through `tenant_members` and the role matrix; a portal session resolves through
 * `tenant_customers` and consults no permission at all. Sharing one resolver would mean
 * one function that sometimes returns staff and sometimes returns a customer, and every
 * caller would have to remember which — which is the shape that eventually serves an
 * operator's board to somebody who books deliveries from them.
 *
 * A customer holds no `Permission`. What they may do is decided here and on the portal
 * pages, and the blast radius of a mistake stops at one account's own bookings.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { createDbClient, orders, tenants, type Db, type Order } from "@porterdirect/db";
import { getAuth } from "./auth";
import { findCustomerAccount, type CustomerAccount } from "./customers";

export interface PortalTenant {
  readonly id: string;
  readonly name: string;
  readonly defaultCountry: string;
}

export interface PortalContext {
  readonly db: Db;
  readonly userId: string;
  readonly account: CustomerAccount;
  readonly tenant: PortalTenant;
}

export async function requirePortalUserId(): Promise<string> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/signin");
  return session.user.id;
}

/**
 * Resolve this signed-in person's customer account with THIS operator.
 *
 * Same rule as the console: the URL PROPOSES a tenant and the database decides. A
 * forged or guessed tenant id resolves to no account and 404s, and a blocked account
 * resolves to nothing at all — `findCustomerAccount` returns null for those, so a
 * blocked customer sees the same thing as a stranger rather than a page arguing with
 * them.
 */
export async function requirePortal(tenantId: string): Promise<PortalContext> {
  const userId = await requirePortalUserId();
  const db = createDbClient(process.env.DATABASE_URL);

  const account = await findCustomerAccount(db, tenantId, userId);
  if (!account) redirect("/portal");

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, defaultCountry: tenants.defaultCountry })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) redirect("/portal");

  return { db, userId, account, tenant };
}

/**
 * The jobs this customer booked.
 *
 * Scoped by the ACCOUNT that booked them, not by the customer name or email on the order.
 * Those describe the person receiving the delivery, who is routinely someone else — a law
 * firm books a courier to a court, a lab books a collection from a clinic. Matching on
 * name would show one customer another's deliveries the first time two of them used the
 * same recipient.
 */
export async function listPortalOrders(
  db: Db,
  tenantId: string,
  accountId: string,
  limit = 50,
): Promise<readonly Order[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.bookedByCustomerId, accountId)))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

/** One of their own bookings, or null. Scoped by all three ids in one predicate. */
export async function findPortalOrder(
  db: Db,
  tenantId: string,
  accountId: string,
  orderId: string,
): Promise<Order | null> {
  const [row] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.bookedByCustomerId, accountId),
        eq(orders.id, orderId),
      ),
    )
    .limit(1);
  return row ?? null;
}
