import { describe, it, expect } from "vitest";
import { tenantRole } from "@porterdirect/db";
import type { TenantRole } from "@porterdirect/db";
import {
  AuthorizationError,
  RoleEscalationError,
  assertCanInviteRole,
  authorize,
  can,
  canInviteRole,
  invitableRoles,
  permissionsFor,
  type Membership,
  type Permission,
} from "../src/permissions.js";

const ROLES = tenantRole.enumValues;
const member = (role: TenantRole, tenantId = "tenant-a"): Membership => ({
  tenantId,
  userId: "user-1",
  role,
});

describe("authorization matrix", () => {
  it("covers every role the database enum allows", () => {
    // If a role is added to the schema without a grant list, this fails rather than
    // letting the new role fall through to an undefined lookup.
    for (const role of ROLES) {
      expect(permissionsFor(role), `no grants declared for "${role}"`).toBeDefined();
      expect(Array.isArray(permissionsFor(role))).toBe(true);
    }
  });

  it("grants no role a permission twice", () => {
    for (const role of ROLES) {
      const perms = permissionsFor(role);
      expect(new Set(perms).size, `duplicate grant in "${role}"`).toBe(perms.length);
    }
  });

  /**
   * The privacy property. Driver location is scoped to an order, never to a person —
   * a driver who can read the fleet or other drivers' orders breaks that scoping, and
   * off-shift visibility is a legal liability, not a bug.
   */
  describe("a driver is confined to their own assigned work", () => {
    const forbidden: Permission[] = [
      "fleet:view",
      "orders:read:all",
      "orders:assign",
      "orders:create",
      "drivers:manage",
      "members:manage",
      "members:read",
      "billing:manage",
      "tenant:settings",
    ];
    for (const permission of forbidden) {
      it(`denies driver "${permission}"`, () => {
        expect(can("driver", permission)).toBe(false);
      });
    }
    it("allows only reading and updating their assigned orders", () => {
      expect(permissionsFor("driver")).toEqual(["orders:read:assigned", "orders:update:assigned"]);
    });
  });

  describe("money and membership are owner-only", () => {
    it("grants billing:manage to owner alone", () => {
      const holders = ROLES.filter((r) => can(r, "billing:manage"));
      expect(holders).toEqual(["owner"]);
    });
    it("grants members:manage to owner alone", () => {
      const holders = ROLES.filter((r) => can(r, "members:manage"));
      expect(holders).toEqual(["owner"]);
    });
  });

  it("lets dispatchers move work but not manage the roster or settings", () => {
    expect(can("dispatcher", "orders:assign")).toBe(true);
    expect(can("dispatcher", "fleet:view")).toBe(true);
    expect(can("dispatcher", "drivers:manage")).toBe(false);
    expect(can("dispatcher", "tenant:settings")).toBe(false);
  });

  it("lets ops run operations but never touch billing", () => {
    expect(can("ops", "drivers:manage")).toBe(true);
    expect(can("ops", "tenant:settings")).toBe(true);
    expect(can("ops", "billing:manage")).toBe(false);
  });
});

describe("authorize()", () => {
  it("permits an action the role holds within its own tenant", () => {
    expect(() => authorize(member("ops"), "tenant-a", "orders:assign")).not.toThrow();
  });

  it("refuses an action the role does not hold", () => {
    expect(() => authorize(member("driver"), "tenant-a", "fleet:view")).toThrow(AuthorizationError);
  });

  it("refuses with no membership at all", () => {
    expect(() => authorize(null, "tenant-a", "orders:read:assigned")).toThrow(AuthorizationError);
  });

  /**
   * The isolation property, and the reason the tenant check precedes the role check:
   * an owner is maximally privileged, so if privilege were evaluated first it would
   * mask the fact that this session belongs to a different tenant entirely.
   */
  it("refuses a cross-tenant request even from an owner", () => {
    expect(() => authorize(member("owner", "tenant-a"), "tenant-b", "orders:read:all")).toThrow(
      /Cross-tenant request refused/,
    );
  });

  it("names the tenants in a cross-tenant refusal without leaking the permission check", () => {
    try {
      authorize(member("owner", "tenant-a"), "tenant-b", "billing:manage");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("tenant-a");
      expect((err as Error).message).toContain("tenant-b");
      expect(err).not.toBeInstanceOf(AuthorizationError);
    }
  });

  it("refuses cross-tenant for every role, not just privileged ones", () => {
    for (const role of ROLES) {
      expect(() => authorize(member(role, "tenant-a"), "tenant-b", "orders:read:assigned")).toThrow(
        /Cross-tenant request refused/,
      );
    }
  });
});

/**
 * The console takes a tenant id from the URL. These assert the rule that makes that
 * safe: the request PROPOSES a tenant, the database DECIDES whether this user is in it.
 */
describe("console access via a request-supplied tenant id", () => {
  it("authorizes only when the looked-up membership matches the requested tenant", () => {
    const looked_up = member("ops", "tenant-a");
    expect(() => authorize(looked_up, "tenant-a", "orders:read:all")).not.toThrow();
  });

  it("refuses when the lookup returned nothing for the requested tenant", () => {
    // This is what a forged or guessed tenant id produces: null, not a membership.
    expect(() => authorize(null, "tenant-b", "orders:read:all")).toThrow(AuthorizationError);
  });

  it("still refuses when a real membership is used against a different tenant", () => {
    expect(() => authorize(member("owner", "tenant-a"), "tenant-b", "members:read")).toThrow(
      /Cross-tenant request refused/,
    );
  });
});

/**
 * Privilege escalation is the risk an invite system carries. "May invite" and "may
 * invite AS OWNER" are different questions; collapsing them is the bug.
 */
describe("who may grant which role", () => {
  it("lets an owner grant any role, including another owner", () => {
    for (const target of ROLES) {
      expect(canInviteRole("owner", target), `owner -> ${target}`).toBe(true);
    }
  });

  it("lets ops staff the fleet but never create an owner", () => {
    expect(canInviteRole("ops", "dispatcher")).toBe(true);
    expect(canInviteRole("ops", "driver")).toBe(true);
    expect(canInviteRole("ops", "owner")).toBe(false);
  });

  it("does not let ops clone their own role", () => {
    // Otherwise "ops" is effectively unbounded: one ops user becomes many.
    expect(canInviteRole("ops", "ops")).toBe(false);
  });

  it.each(["dispatcher", "driver"] as const)("gives %s no power to invite at all", (role) => {
    for (const target of ROLES) {
      expect(canInviteRole(role, target), `${role} -> ${target}`).toBe(false);
    }
  });

  it("never lets a role grant something above itself", () => {
    // The general property, asserted rather than left to the table being read carefully.
    const rank: Record<string, number> = { driver: 0, dispatcher: 1, ops: 2, owner: 3 };
    for (const inviter of ROLES) {
      for (const target of ROLES) {
        if (canInviteRole(inviter, target)) {
          expect(rank[target]!, `${inviter} granted ${target}`).toBeLessThanOrEqual(rank[inviter]!);
        }
      }
    }
  });

  it("offers exactly the grantable roles for a form", () => {
    expect(invitableRoles("ops")).toEqual(["dispatcher", "driver"]);
    expect(invitableRoles("driver")).toEqual([]);
  });

  it("throws with both roles named", () => {
    expect(() => assertCanInviteRole("ops", "owner")).toThrow(RoleEscalationError);
    expect(() => assertCanInviteRole("owner", "driver")).not.toThrow();
  });
});
