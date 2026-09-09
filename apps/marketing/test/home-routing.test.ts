/**
 * Where a member lands.
 *
 * This exists because the rule was previously made implicitly at four separate redirects
 * and every one of them chose the console. A driver accepting the invitation that brought
 * them onto the platform landed in a dispatcher's screen, and `/drive` was unreachable
 * unless somebody told them the URL — a built surface nobody could find.
 *
 * The rule is one function now, so these assertions cover every entry point at once.
 */
import { describe, expect, it } from "vitest";
import type { TenantRole } from "@porterdirect/auth";
import { homePathForRole, isDriverOnly } from "../lib/console";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ALL_ROLES: TenantRole[] = ["owner", "ops", "dispatcher", "driver"];

describe("homePathForRole", () => {
  it("sends a driver to the driver surface", () => {
    expect(homePathForRole("driver", TENANT)).toBe(`/drive/${TENANT}`);
  });

  it("sends everyone with office work to the console", () => {
    // Not about seniority: it is about whether there is anything for them to do there.
    for (const role of ["owner", "ops", "dispatcher"] as const) {
      expect(homePathForRole(role, TENANT), role).toBe(`/dashboard/${TENANT}`);
    }
  });

  it("returns a path for every role, with no default branch to rot", () => {
    for (const role of ALL_ROLES) {
      expect(homePathForRole(role, TENANT), role).toMatch(
        new RegExp(`^/(drive|dashboard)/${TENANT}$`),
      );
    }
  });

  it("carries the tenant through, so a two-firm contractor lands in the right one", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    expect(homePathForRole("driver", other)).toContain(other);
    expect(homePathForRole("driver", other)).not.toContain(TENANT);
  });

  it("never sends anyone to a bare path with no tenant", () => {
    // A tenant-less landing is how someone ends up on a picker they do not need, or
    // worse, on a page that has to guess which licensee they meant.
    for (const role of ALL_ROLES) {
      expect(homePathForRole(role, TENANT).endsWith(TENANT), role).toBe(true);
    }
  });
});

describe("isDriverOnly", () => {
  it("is true only for a driver", () => {
    expect(isDriverOnly("driver")).toBe(true);
    for (const role of ["owner", "ops", "dispatcher"] as const) {
      expect(isDriverOnly(role), role).toBe(false);
    }
  });

  it("drives navigation, not access", () => {
    // Stated as a test so the next reader does not mistake it for a permission. An owner
    // who also drives is NOT driver-only, and still reaches /drive from the header —
    // access is decided by `can()` and membership, never by this.
    expect(isDriverOnly("owner")).toBe(false);
    expect(homePathForRole("owner", TENANT)).toBe(`/dashboard/${TENANT}`);
  });
});
