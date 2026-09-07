/**
 * Membership and tenant-resolution queries, against a REAL Postgres.
 *
 * The property under test is isolation at the QUERY level: a membership lookup must be
 * scoped by tenant AND user in one predicate, so a user who belongs to tenant A gets
 * nothing for tenant B. Every authorization check downstream trusts this result, so if
 * it returns the wrong scope the rest of the system refuses correctly against the wrong
 * tenant — which is indistinguishable from working.
 *
 * Skipped rather than failed when DATABASE_URL is absent, so the suite runs offline.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, tenantMembers, tenants, users, type Db } from "@porterdirect/db";
import { findMembership, findTenantByHost, listMembershipsForUser } from "../src/membership.js";
import { authorize } from "../src/permissions.js";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    for (const raw of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = /^DATABASE_URL=(.*)$/.exec(raw.replace(/\r$/, "").trim());
      if (m && m[1]) return m[1].trim();
    }
  } catch { /* offline */ }
  return undefined;
}

const URL_ = databaseUrl();
const suite = URL_ ? describe : describe.skip;

suite("membership queries (real Postgres)", () => {
  let db: Db;
  const run = randomUUID().slice(0, 8);
  const hostA = `dispatch.acme-${run}.test`;
  const hostB = `dispatch.globex-${run}.test`;
  const userId = `user_${run}`;
  const otherUserId = `user_other_${run}`;
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    db = createDbClient(URL_);
    await db.insert(users).values([
      { id: userId, name: "Dispatcher One", email: `d1+${run}@example.test` },
      { id: otherUserId, name: "Driver Two", email: `d2+${run}@example.test` },
    ]);
    const inserted = await db
      .insert(tenants)
      .values([
        { name: `Acme Couriers ${run}`, primaryHost: hostA },
        { name: `Globex Freight ${run}`, primaryHost: hostB },
      ])
      .returning({ id: tenants.id, host: tenants.primaryHost });

    tenantA = inserted.find((t) => t.host === hostA)!.id;
    tenantB = inserted.find((t) => t.host === hostB)!.id;

    await db.insert(tenantMembers).values([
      { tenantId: tenantA, userId, role: "dispatcher" },
      { tenantId: tenantB, userId: otherUserId, role: "owner" },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, [tenantA, tenantB]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  });

  it("resolves a tenant from its white-label host", async () => {
    const found = await findTenantByHost(db, hostA);
    expect(found?.id).toBe(tenantA);
    expect(found?.name).toContain("Acme Couriers");
  });

  it("returns null for a host no tenant claims — never a fallback tenant", async () => {
    expect(await findTenantByHost(db, `unclaimed-${run}.test`)).toBeNull();
  });

  it("finds a membership within the user's own tenant", async () => {
    const m = await findMembership(db, userId, tenantA);
    expect(m).not.toBeNull();
    expect(m?.role).toBe("dispatcher");
    expect(m?.tenantId).toBe(tenantA);
  });

  /**
   * The isolation assertion. This user exists, and tenant B exists, and they are simply
   * unrelated — the query must return nothing rather than the membership it does have.
   */
  it("returns null for a tenant the user does NOT belong to", async () => {
    expect(await findMembership(db, userId, tenantB)).toBeNull();
  });

  it("returns null for a user who belongs to a different tenant entirely", async () => {
    expect(await findMembership(db, otherUserId, tenantA)).toBeNull();
  });

  it("refuses the request end to end when membership is for another tenant", async () => {
    const wrongTenant = await findMembership(db, userId, tenantB); // null
    expect(() => authorize(wrongTenant, tenantB, "orders:read:all")).toThrow();
  });

  it("authorizes end to end within the correct tenant", async () => {
    const m = await findMembership(db, userId, tenantA);
    expect(() => authorize(m, tenantA, "orders:assign")).not.toThrow();
    // ...and the same dispatcher still cannot touch billing.
    expect(() => authorize(m, tenantA, "billing:manage")).toThrow();
  });

  it("lists only the tenants a user actually belongs to", async () => {
    const list = await listMembershipsForUser(db, userId);
    expect(list.map((m) => m.tenantId)).toEqual([tenantA]);
  });

  it("stores Better Auth users in OUR database, not a vendor's", async () => {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    expect(row?.id).toBe(userId);
  });
});
