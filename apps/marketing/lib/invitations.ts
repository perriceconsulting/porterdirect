/**
 * Tenant invitations.
 *
 * An invite token is a BEARER CREDENTIAL: whoever holds the link joins the tenant. That
 * shapes every decision here —
 *
 *   generated with crypto randomness, never a guessable id;
 *   stored HASHED, so a database leak grants nothing;
 *   bound to the invited EMAIL, so a forwarded link cannot be used by whoever received it;
 *   single-use and time-bound, so a link in an old inbox is not a standing key.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  tenantInvitations,
  tenantMembers,
  users,
  type Db,
  type TenantInvitation,
  type TenantRole,
} from "@porterdirect/db";
import { assertCanInviteRole } from "@porterdirect/auth";

/** Seven days. Long enough to be found, short enough not to linger. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InvitationError extends Error {
  constructor(
    readonly code:
      | "invalid-email"
      | "already-member"
      | "already-invited"
      | "not-found"
      | "expired"
      | "used"
      | "wrong-account",
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateInvitationResult {
  readonly invitation: TenantInvitation;
  /** The raw token. Exists only here and in the email — never persisted, never logged. */
  readonly token: string;
}

export async function createInvitation(
  db: Db,
  args: {
    tenantId: string;
    inviterRole: TenantRole;
    inviterUserId: string;
    email: string;
    role: TenantRole;
  },
): Promise<CreateInvitationResult> {
  // Throws RoleEscalationError. Checked before anything is written, so a refused invite
  // leaves no trace to clean up.
  assertCanInviteRole(args.inviterRole, args.role);

  const email = normalizeEmail(args.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InvitationError("invalid-email", "Enter a valid email address.");
  }

  // Already on the team? Scoped by tenant AND email in the join.
  const [existingMember] = await db
    .select({ id: tenantMembers.id })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(and(eq(tenantMembers.tenantId, args.tenantId), eq(users.email, email)))
    .limit(1);
  if (existingMember) {
    throw new InvitationError("already-member", "That person is already on this account.");
  }

  const [open] = await db
    .select({ id: tenantInvitations.id })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, args.tenantId),
        eq(tenantInvitations.email, email),
        isNull(tenantInvitations.acceptedAt),
      ),
    )
    .limit(1);
  if (open) {
    throw new InvitationError("already-invited", "There is already an open invite for that address.");
  }

  // 32 bytes of crypto randomness. Not a uuid: a uuid is an identifier, and identifiers
  // turn up in logs, referrers and analytics. This is a secret.
  const token = randomBytes(32).toString("base64url");

  const [invitation] = await db
    .insert(tenantInvitations)
    .values({
      tenantId: args.tenantId,
      email,
      role: args.role,
      tokenHash: hashToken(token),
      invitedByUserId: args.inviterUserId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();

  return { invitation: invitation!, token };
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: TenantRole;
  readonly expiresAt: Date;
}

/** Open invites for this tenant. Accepted ones are history, not pending. */
export async function listPendingInvitations(
  db: Db,
  tenantId: string,
): Promise<PendingInvitation[]> {
  const rows = await db
    .select({
      id: tenantInvitations.id,
      email: tenantInvitations.email,
      role: tenantInvitations.role,
      expiresAt: tenantInvitations.expiresAt,
    })
    .from(tenantInvitations)
    .where(and(eq(tenantInvitations.tenantId, tenantId), isNull(tenantInvitations.acceptedAt)))
    .orderBy(desc(tenantInvitations.createdAt));
  return rows;
}

/**
 * Look up an invite by its raw token.
 *
 * Compared by hash, and the comparison is TIMING-SAFE. A plain string compare leaks how
 * many leading characters matched, which is enough to reconstruct a token given enough
 * attempts — the whole reason to hash is undone by comparing carelessly.
 */
export async function findInvitationByToken(
  db: Db,
  token: string,
): Promise<TenantInvitation | null> {
  if (!token) return null;
  const wanted = hashToken(token);

  const [row] = await db
    .select()
    .from(tenantInvitations)
    .where(eq(tenantInvitations.tokenHash, wanted))
    .limit(1);
  if (!row) return null;

  const a = Buffer.from(row.tokenHash, "utf8");
  const b = Buffer.from(wanted, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}

/**
 * Accept an invitation for a signed-in user.
 *
 * The signed-in account's email must MATCH the invited address. Without that check, a
 * forwarded link lets whoever received it join a tenant they were never invited to —
 * and the invite was the only thing standing between them and another licensee's data.
 */
export async function acceptInvitation(
  db: Db,
  args: { token: string; userId: string; userEmail: string },
): Promise<{ tenantId: string; role: TenantRole }> {
  const invitation = await findInvitationByToken(db, args.token);
  if (!invitation) {
    throw new InvitationError("not-found", "That invitation link is not valid.");
  }
  if (invitation.acceptedAt) {
    throw new InvitationError("used", "That invitation has already been used.");
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new InvitationError("expired", "That invitation has expired. Ask for a new one.");
  }
  if (normalizeEmail(args.userEmail) !== invitation.email) {
    throw new InvitationError(
      "wrong-account",
      `This invitation was sent to ${invitation.email}. Sign in as that account to accept it.`,
    );
  }

  // Claim the invite FIRST, scoped by "still unaccepted", so two simultaneous accepts
  // cannot both create a membership. Same atomic-claim shape as the webhook ledger.
  const [claimed] = await db
    .update(tenantInvitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(tenantInvitations.id, invitation.id), isNull(tenantInvitations.acceptedAt)))
    .returning({ id: tenantInvitations.id });
  if (!claimed) {
    throw new InvitationError("used", "That invitation has already been used.");
  }

  await db
    .insert(tenantMembers)
    .values({ tenantId: invitation.tenantId, userId: args.userId, role: invitation.role })
    // Already a member by another route — the invite is spent either way, and the
    // existing role is left alone rather than silently downgraded.
    .onConflictDoNothing();

  return { tenantId: invitation.tenantId, role: invitation.role };
}

/** Withdraw an open invite. Scoped by tenant so one account cannot revoke another's. */
export async function revokeInvitation(
  db: Db,
  args: { tenantId: string; invitationId: string },
): Promise<void> {
  await db
    .delete(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, args.tenantId),
        eq(tenantInvitations.id, args.invitationId),
        isNull(tenantInvitations.acceptedAt),
      ),
    );
}
