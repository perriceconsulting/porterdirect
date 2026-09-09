/**
 * The authorization matrix: what each tenant role may do.
 *
 * Pure and exhaustive on purpose. This is the module a reviewer should be able to read
 * end to end and say "yes, that is the policy" — no I/O, no database, no framework, so
 * every rule is a millisecond unit test rather than a browser assertion (CLAUDE.md: an
 * invariant belongs in a fast test).
 *
 * Two properties matter more than the rest and are asserted directly in the tests:
 *
 *  1. A DRIVER can never read the fleet or another driver's work. Driver location is
 *     scoped to an order, never queried as "where is driver X" — that scoping is what
 *     makes the privacy promise enforceable rather than aspirational.
 *  2. Only an OWNER touches billing or membership. Those two are how a tenant loses
 *     money or gains an unintended member.
 */
import type { TenantRole } from "@porterdirect/db";

// Re-exported so callers reason about roles through this package rather than
// reaching into the schema for a type the policy owns the meaning of.
export type { TenantRole };

/**
 * Permissions are named for the DOMAIN action, not the HTTP verb or table, so a reader
 * who knows the business can audit this list without knowing the schema.
 */
export type Permission =
  | "billing:manage"
  | "members:manage"
  | "members:read"
  | "tenant:settings"
  | "orders:create"
  | "orders:assign"
  /**
   * Take an UNASSIGNED job for yourself.
   *
   * Distinct from `orders:assign`, which is the power to direct OTHER people's work — a
   * dispatcher deciding who goes where. Claiming is only ever reflexive: it can put a job
   * on your own board and nobody else's. Collapsing the two would hand every driver the
   * roster, which is exactly the escalation the matrix is written out longhand to prevent.
   */
  | "orders:claim"
  | "orders:read:all"
  | "orders:read:assigned"
  | "orders:update:assigned"
  | "drivers:manage"
  | "fleet:view";

/**
 * Explicit grants per role. Deliberately written out in full rather than derived by
 * "ops = dispatcher + extras": an inheritance chain makes a widened parent silently
 * widen every child, which is how a driver quietly acquires fleet visibility.
 */
const MATRIX: Readonly<Record<TenantRole, readonly Permission[]>> = {
  owner: [
    "billing:manage",
    "members:manage",
    "members:read",
    "tenant:settings",
    "orders:create",
    "orders:assign",
    "orders:read:all",
    "orders:read:assigned",
    "orders:update:assigned",
    "drivers:manage",
    "fleet:view",
  ],
  ops: [
    "members:read",
    "tenant:settings",
    "orders:create",
    "orders:assign",
    "orders:claim",
    "orders:read:all",
    "orders:read:assigned",
    "orders:update:assigned",
    "drivers:manage",
    "fleet:view",
  ],
  dispatcher: [
    "members:read",
    "orders:create",
    "orders:assign",
    "orders:claim",
    "orders:read:all",
    "orders:read:assigned",
    "orders:update:assigned",
    "fleet:view",
  ],
  // A driver sees their own assigned work and nothing else. No fleet, no roster,
  // no other drivers' orders.
  // A driver sees their own assigned work and nothing else — no fleet, no roster, no
  // other drivers' orders. `orders:claim` does not widen that: it lets them PUT a job on
  // their own board, never look at somebody else's.
  driver: ["orders:read:assigned", "orders:update:assigned", "orders:claim"],
};

/** Does this role hold this permission? The single authorization predicate. */
export function can(role: TenantRole, permission: Permission): boolean {
  // A linear scan of at most a dozen entries. A Set here would be optimising without a
  // measurement, and the array form keeps MATRIX the only place a grant is written.
  return MATRIX[role].includes(permission);
}

/** Every permission a role holds — for building a UI, never for deciding access. */
export function permissionsFor(role: TenantRole): readonly Permission[] {
  return MATRIX[role];
}

/**
 * A resolved membership: this user, in this tenant, as this role. Produced by the
 * wiring layer from a session plus the `tenant_members` join.
 */
export interface Membership {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
}

/** Raised when a request is refused. Carries what was attempted, never why it existed. */
export class AuthorizationError extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: TenantRole,
  ) {
    super(`Role "${role}" does not hold permission "${permission}"`);
    this.name = "AuthorizationError";
  }
}

/**
 * Authorize an action within ONE tenant.
 *
 * Takes the tenant the request is FOR and the membership the session resolved TO, and
 * refuses when they disagree — a valid session for tenant A must never authorize an
 * action against tenant B. That cross-tenant check lives here, ahead of the role check,
 * because a permissive role would otherwise mask it: an owner of A is still nobody in B.
 */
export function authorize(
  membership: Membership | null,
  tenantId: string,
  permission: Permission,
): void {
  if (!membership) {
    throw new AuthorizationError(permission, "driver");
  }
  if (membership.tenantId !== tenantId) {
    throw new Error(
      `Cross-tenant request refused: session is scoped to tenant ${membership.tenantId}, ` +
        `request targets ${tenantId}`,
    );
  }
  if (!can(membership.role, permission)) {
    throw new AuthorizationError(permission, membership.role);
  }
}

/**
 * Which roles may this role hand out?
 *
 * Separate from `can(role, "members:manage")` on purpose. "May invite someone" and "may
 * invite someone AS AN OWNER" are different questions, and collapsing them is how
 * privilege escalation happens: an ops user who can invite would otherwise be able to
 * invite themselves a second account as owner, or promote a colleague past themselves.
 *
 * The rule is simple and deliberately strict — you cannot grant a role you do not hold:
 *   owner      -> any role, including another owner
 *   ops        -> dispatcher, driver (never owner, never another ops)
 *   dispatcher -> nothing
 *   driver     -> nothing
 */
const INVITABLE: Readonly<Record<TenantRole, readonly TenantRole[]>> = {
  owner: ["owner", "ops", "dispatcher", "driver"],
  ops: ["dispatcher", "driver"],
  dispatcher: [],
  driver: [],
};

export function canInviteRole(inviter: TenantRole, target: TenantRole): boolean {
  return INVITABLE[inviter].includes(target);
}

/** Roles this role may offer, for building the invite form's options. */
export function invitableRoles(inviter: TenantRole): readonly TenantRole[] {
  return INVITABLE[inviter];
}

/** Raised when someone tries to grant a role they may not grant. */
export class RoleEscalationError extends Error {
  constructor(
    readonly inviter: TenantRole,
    readonly target: TenantRole,
  ) {
    super(`A "${inviter}" cannot invite someone as "${target}".`);
    this.name = "RoleEscalationError";
  }
}

export function assertCanInviteRole(inviter: TenantRole, target: TenantRole): void {
  if (!canInviteRole(inviter, target)) throw new RoleEscalationError(inviter, target);
}
