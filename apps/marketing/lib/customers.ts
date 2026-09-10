/**
 * Customer accounts: the people who BOOK the work, as opposed to the people who run it.
 *
 * A customer holds no `Permission`. Nothing in this file consults the role matrix, and
 * nothing in the role matrix knows customers exist — that separation is the whole reason
 * `tenant_customers` is not a `tenant_members` row with a "customer" role. What a
 * customer may do is decided by the customer surfaces alone, and the blast radius of a
 * mistake there stops at one account's own bookings.
 *
 * Every query is scoped by `tenantId` inside the WHERE clause, same rule as orders: a
 * lookup by user id alone would resolve an account belonging to a DIFFERENT operator,
 * and every check downstream would then pass honestly against the wrong tenant.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  customerInvitations,
  tenantCustomers,
  tenants,
  users,
  type CustomerInvitation,
  type Db,
  type TenantCustomer,
} from "@porterdirect/db";
import {
  hashInviteToken,
  inviteExpiry,
  inviteTokenMatches,
  newInviteToken,
  normalizeInviteEmail,
} from "./invite-token";
import { looksLikeEmail } from "./delivery-receipt";

export class CustomerAccountError extends Error {
  constructor(
    readonly code:
      | "invalid-email"
      | "already-a-customer"
      | "already-invited"
      | "not-found"
      | "expired"
      | "used"
      | "wrong-account"
      | "closed"
      | "blocked",
    message: string,
  ) {
    super(message);
    this.name = "CustomerAccountError";
  }
}

export interface CustomerAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly companyName: string | null;
  readonly phone: string | null;
  readonly status: "active" | "blocked";
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

/**
 * This user's customer account with this operator, or null.
 *
 * Scoped by BOTH ids in one predicate. Looking a customer up by user id and checking the
 * tenant afterwards is the shape that leaks, because the row is already in memory by the
 * time the check is forgotten.
 *
 * A BLOCKED account resolves as null rather than as a blocked account, deliberately: an
 * operator who has blocked someone does not want a "you have been blocked" page arguing
 * with them, and every caller would otherwise have to remember to check the status. The
 * console still lists them, because that is where the operator manages it.
 */
export async function findCustomerAccount(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<CustomerAccount | null> {
  const [row] = await db
    .select({
      id: tenantCustomers.id,
      tenantId: tenantCustomers.tenantId,
      userId: tenantCustomers.userId,
      companyName: tenantCustomers.companyName,
      phone: tenantCustomers.phone,
      status: tenantCustomers.status,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(tenantCustomers)
    .innerJoin(users, eq(users.id, tenantCustomers.userId))
    .where(and(eq(tenantCustomers.tenantId, tenantId), eq(tenantCustomers.userId, userId)))
    .limit(1);

  if (!row) return null;
  if (row.status === "blocked") return null;
  return row;
}

/** Every account this user holds, across operators — the portal's account picker. */
export async function listCustomerAccountsForUser(
  db: Db,
  userId: string,
): Promise<readonly { tenantId: string; tenantName: string; accountId: string }[]> {
  return db
    .select({
      tenantId: tenantCustomers.tenantId,
      tenantName: tenants.name,
      accountId: tenantCustomers.id,
    })
    .from(tenantCustomers)
    .innerJoin(tenants, eq(tenants.id, tenantCustomers.tenantId))
    .where(and(eq(tenantCustomers.userId, userId), eq(tenantCustomers.status, "active")));
}

/** The operator's view of who books with them. Blocked accounts included — see above. */
export async function listCustomers(db: Db, tenantId: string): Promise<readonly CustomerAccount[]> {
  return db
    .select({
      id: tenantCustomers.id,
      tenantId: tenantCustomers.tenantId,
      userId: tenantCustomers.userId,
      companyName: tenantCustomers.companyName,
      phone: tenantCustomers.phone,
      status: tenantCustomers.status,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(tenantCustomers)
    .innerJoin(users, eq(users.id, tenantCustomers.userId))
    .where(eq(tenantCustomers.tenantId, tenantId))
    .orderBy(desc(tenantCustomers.createdAt));
}

export interface CreateCustomerInvitationResult {
  readonly invitation: CustomerInvitation;
  /** The raw token. Exists only here and in the email — never persisted, never logged. */
  readonly token: string;
}

export async function inviteCustomer(
  db: Db,
  args: { tenantId: string; email: string; companyName?: string | null; invitedByUserId: string },
): Promise<CreateCustomerInvitationResult> {
  const email = normalizeInviteEmail(args.email);
  if (!looksLikeEmail(email)) {
    throw new CustomerAccountError("invalid-email", "That email address does not look right.");
  }

  // Already holds an account here? Re-inviting would mint a second bearer credential for
  // access they already have, and the accept path would then have to decide what a
  // duplicate means.
  const [existing] = await db
    .select({ id: tenantCustomers.id })
    .from(tenantCustomers)
    .innerJoin(users, eq(users.id, tenantCustomers.userId))
    .where(and(eq(tenantCustomers.tenantId, args.tenantId), eq(users.email, email)))
    .limit(1);
  if (existing) {
    throw new CustomerAccountError("already-a-customer", `${email} already has an account with you.`);
  }

  const [open] = await db
    .select({ id: customerInvitations.id })
    .from(customerInvitations)
    .where(
      and(
        eq(customerInvitations.tenantId, args.tenantId),
        eq(customerInvitations.email, email),
        isNull(customerInvitations.acceptedAt),
      ),
    )
    .limit(1);
  if (open) {
    throw new CustomerAccountError("already-invited", `${email} has already been invited.`);
  }

  const token = newInviteToken();
  const [invitation] = await db
    .insert(customerInvitations)
    .values({
      tenantId: args.tenantId,
      email,
      companyName: args.companyName?.trim() || null,
      tokenHash: hashInviteToken(token),
      invitedByUserId: args.invitedByUserId,
      expiresAt: inviteExpiry(),
    })
    .returning();

  if (!invitation) throw new CustomerAccountError("not-found", "Could not create that invitation.");
  return { invitation, token };
}

export async function findCustomerInvitationByToken(
  db: Db,
  token: string,
): Promise<CustomerInvitation | null> {
  if (!token) return null;
  const wanted = hashInviteToken(token);
  const [row] = await db
    .select()
    .from(customerInvitations)
    .where(eq(customerInvitations.tokenHash, wanted))
    .limit(1);
  if (!row) return null;
  if (!inviteTokenMatches(row.tokenHash, wanted)) return null;
  return row;
}

/**
 * Accept a customer invitation for a signed-in user.
 *
 * The signed-in account's email must MATCH the invited address, for the same reason a
 * staff invite is bound: a forwarded link must not work for whoever received it.
 *
 * The invite is CLAIMED first, scoped by "still unaccepted", so two simultaneous accepts
 * cannot both create an account. Check-then-act here would mean a duplicate row and the
 * unique index refusing the second one with a raw database error.
 */
export async function acceptCustomerInvitation(
  db: Db,
  args: { token: string; userId: string; userEmail: string },
): Promise<{ tenantId: string; accountId: string }> {
  const invitation = await findCustomerInvitationByToken(db, args.token);
  // ONE message for "no such token", "expired" and "already used". Distinguishing them
  // lets someone probe which links exist.
  if (!invitation) {
    throw new CustomerAccountError("not-found", "That invitation link is not valid.");
  }
  if (invitation.acceptedAt) {
    throw new CustomerAccountError("used", "That invitation has already been used.");
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new CustomerAccountError("expired", "That invitation has expired. Ask for a new one.");
  }
  if (normalizeInviteEmail(args.userEmail) !== invitation.email) {
    throw new CustomerAccountError(
      "wrong-account",
      `This invitation was sent to ${invitation.email}. Sign in as that account to accept it.`,
    );
  }

  const [claimed] = await db
    .update(customerInvitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(customerInvitations.id, invitation.id), isNull(customerInvitations.acceptedAt)))
    .returning({ id: customerInvitations.id });
  if (!claimed) {
    throw new CustomerAccountError("used", "That invitation has already been used.");
  }

  const account = await upsertCustomerAccount(db, {
    tenantId: invitation.tenantId,
    userId: args.userId,
    companyName: invitation.companyName,
  });
  return { tenantId: invitation.tenantId, accountId: account.id };
}

/**
 * Register as a customer without an invitation.
 *
 * Refused unless the operator has opened registration. The check reads the TENANT ROW
 * rather than taking a flag from the request, because "may I register" is the operator's
 * decision and the request is the party asking.
 */
export async function registerCustomer(
  db: Db,
  args: { tenantId: string; userId: string; companyName?: string | null },
): Promise<TenantCustomer> {
  const [tenant] = await db
    .select({ mode: tenants.customerSignup })
    .from(tenants)
    .where(eq(tenants.id, args.tenantId))
    .limit(1);
  if (!tenant) throw new CustomerAccountError("not-found", "No such operator.");
  if (tenant.mode !== "open") {
    throw new CustomerAccountError(
      "closed",
      "This company does not take new accounts online. Contact them to be set up.",
    );
  }
  return upsertCustomerAccount(db, args);
}

/**
 * Create the account row, or return the existing one.
 *
 * `onConflictDoNothing` against the unique (tenant, user) index rather than a SELECT
 * then an INSERT: two simultaneous accepts both pass a pre-check and the second gets a
 * raw duplicate-key error instead of an account. The read-back on conflict is what makes
 * a repeated accept idempotent rather than an error.
 */
async function upsertCustomerAccount(
  db: Db,
  args: { tenantId: string; userId: string; companyName?: string | null },
): Promise<TenantCustomer> {
  const [created] = await db
    .insert(tenantCustomers)
    .values({
      tenantId: args.tenantId,
      userId: args.userId,
      companyName: args.companyName?.trim() || null,
    })
    .onConflictDoNothing({ target: [tenantCustomers.tenantId, tenantCustomers.userId] })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(tenantCustomers)
    .where(and(eq(tenantCustomers.tenantId, args.tenantId), eq(tenantCustomers.userId, args.userId)))
    .limit(1);
  if (!existing) throw new CustomerAccountError("not-found", "Could not open that account.");
  if (existing.status === "blocked") {
    // Accepting an invite must not silently un-block someone the operator blocked.
    throw new CustomerAccountError("blocked", "This account is not active. Contact the company.");
  }
  return existing;
}

/** Pending customer invitations, for the console list. */
export async function listPendingCustomerInvitations(
  db: Db,
  tenantId: string,
): Promise<readonly CustomerInvitation[]> {
  return db
    .select()
    .from(customerInvitations)
    .where(and(eq(customerInvitations.tenantId, tenantId), isNull(customerInvitations.acceptedAt)))
    .orderBy(desc(customerInvitations.createdAt));
}

/** Withdraw an unaccepted invitation. Scoped by tenant so one operator cannot touch another's. */
export async function revokeCustomerInvitation(
  db: Db,
  tenantId: string,
  invitationId: string,
): Promise<void> {
  await db
    .delete(customerInvitations)
    .where(
      and(
        eq(customerInvitations.id, invitationId),
        eq(customerInvitations.tenantId, tenantId),
        isNull(customerInvitations.acceptedAt),
      ),
    );
}

/** Block or unblock an account. The row survives, so the jobs they booked keep their provenance. */
export async function setCustomerStatus(
  db: Db,
  tenantId: string,
  customerId: string,
  status: "active" | "blocked",
): Promise<void> {
  await db
    .update(tenantCustomers)
    .set({ status })
    .where(and(eq(tenantCustomers.id, customerId), eq(tenantCustomers.tenantId, tenantId)));
}
