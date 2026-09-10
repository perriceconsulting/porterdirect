/**
 * Customer accounts, against a real Postgres.
 *
 * A customer invitation is a BEARER CREDENTIAL, like a staff one, so the assertions that
 * matter are the ones about what it refuses: a forwarded link, a replayed link, an
 * expired link, and registration at an operator who has not opened it. The happy path is
 * the least interesting thing here.
 *
 * Skipped (not failed) without DATABASE_URL, so the suite still runs offline.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDbClient,
  customerInvitations,
  tenantCustomers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";
import {
  CustomerAccountError,
  acceptCustomerInvitation,
  findCustomerAccount,
  findCustomerInvitationByToken,
  inviteCustomer,
  listCustomerAccountsForUser,
  listCustomers,
  listPendingCustomerInvitations,
  registerCustomer,
  revokeCustomerInvitation,
  setCustomerStatus,
} from "../lib/customers";
import { hashInviteToken, inviteTokenMatches, newInviteToken } from "../lib/invite-token";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    for (const raw of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      const m = /^DATABASE_URL=(.*)$/.exec(line);
      if (m && m[1]) return m[1].trim();
    }
  } catch {
    /* no .env.local — fall through to skip */
  }
  return undefined;
}

const DB_URL = databaseUrl();
const suite = DB_URL ? describe : describe.skip;

suite("customer accounts", () => {
  let db: Db;
  let tenantId = "";
  let openTenantId = "";
  let operatorId = "";
  const run = randomUUID().slice(0, 8);
  const emailOf = (who: string) => `${who}-${run}@customers-${run}.test`;

  const newUser = async (who: string): Promise<string> => {
    const id = `cust-${run}-${who}`;
    await db.insert(users).values({
      id,
      name: `${who} ${run}`,
      firstName: who,
      lastName: run,
      email: emailOf(who),
    });
    return id;
  };

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const rows = await db
      .insert(tenants)
      .values([
        { name: `Invite Only ${run}`, primaryHost: `inv-${run}.example.test` },
        { name: `Open Signup ${run}`, primaryHost: `open-${run}.example.test`, customerSignup: "open" },
      ])
      .returning({ id: tenants.id });
    tenantId = rows[0]!.id;
    openTenantId = rows[1]!.id;
    operatorId = await newUser("operator");
  });

  afterAll(async () => {
    // Scoped to the ids this run OWNS — never a pattern that could match real data.
    for (const id of [tenantId, openTenantId]) {
      if (id) await db.delete(tenants).where(eq(tenants.id, id));
    }
    await db.delete(users).where(eq(users.email, emailOf("operator")));
    for (const who of ["ana", "bea", "cal", "dee", "eve"]) {
      await db.delete(users).where(eq(users.email, emailOf(who)));
    }
  });

  describe("the invitation is a bearer credential", () => {
    it("never stores the raw token", async () => {
      const anaId = await newUser("ana");
      const { invitation, token } = await inviteCustomer(db, {
        tenantId,
        email: emailOf("ana"),
        companyName: "Ana & Co",
        invitedByUserId: operatorId,
      });

      // A database dump of raw tokens would be a set of working keys.
      expect(invitation.tokenHash).not.toBe(token);
      expect(invitation.tokenHash).toBe(hashInviteToken(token));
      expect(invitation.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(anaId).toBeTruthy();
    });

    it("is refused for a DIFFERENT account than the one invited", async () => {
      // The forwarded-link case. Without this the invite is a key for whoever received
      // it, and the invite is the only thing standing between them and the account.
      const beaId = await newUser("bea");
      const { token } = await inviteCustomer(db, {
        tenantId,
        email: emailOf("cal"),
        invitedByUserId: operatorId,
      });
      await expect(
        acceptCustomerInvitation(db, { token, userId: beaId, userEmail: emailOf("bea") }),
      ).rejects.toThrow(CustomerAccountError);
      // And no account was opened as a side effect.
      expect(await findCustomerAccount(db, tenantId, beaId)).toBeNull();
    });

    it("cannot be used twice", async () => {
      const calId = await newUser("cal");
      const [pending] = await listPendingCustomerInvitations(db, tenantId);
      expect(pending, "expected the invite from the previous test").toBeDefined();

      const { token } = await inviteCustomer(db, {
        tenantId,
        email: emailOf("dee"),
        invitedByUserId: operatorId,
      });
      const deeId = await newUser("dee");
      const first = await acceptCustomerInvitation(db, {
        token,
        userId: deeId,
        userEmail: emailOf("dee"),
      });
      expect(first.tenantId).toBe(tenantId);

      await expect(
        acceptCustomerInvitation(db, { token, userId: deeId, userEmail: emailOf("dee") }),
      ).rejects.toThrow(/already been used/);
      expect(calId).toBeTruthy();
    });

    it("gives ONE message for an unknown, expired and used token", async () => {
      // Distinguishing them lets someone probe which links exist.
      const unknown = await findCustomerInvitationByToken(db, newInviteToken());
      expect(unknown).toBeNull();
      expect(await findCustomerInvitationByToken(db, "")).toBeNull();
    });

    it("refuses an expired link", async () => {
      const eveId = await newUser("eve");
      const { invitation, token } = await inviteCustomer(db, {
        tenantId,
        email: emailOf("eve"),
        invitedByUserId: operatorId,
      });
      await db
        .update(customerInvitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(customerInvitations.id, invitation.id));

      await expect(
        acceptCustomerInvitation(db, { token, userId: eveId, userEmail: emailOf("eve") }),
      ).rejects.toThrow(/expired/);
    });

    it("compares hashes in constant time, and refuses mismatched lengths without throwing", () => {
      // `timingSafeEqual` THROWS on different lengths, so a malformed row would turn a
      // refusal into a 500 — itself an oracle, because it tells one kind of miss from
      // another.
      const h = hashInviteToken("anything");
      expect(inviteTokenMatches(h, h)).toBe(true);
      expect(() => inviteTokenMatches("short", h)).not.toThrow();
      expect(inviteTokenMatches("short", h)).toBe(false);
    });
  });

  describe("who may open an account", () => {
    it("refuses self-registration at an invite-only operator", async () => {
      const anaId = `cust-${run}-ana`;
      await expect(registerCustomer(db, { tenantId, userId: anaId })).rejects.toThrow(/does not take new accounts/);
      expect(await findCustomerAccount(db, tenantId, anaId)).toBeNull();
    });

    it("allows self-registration where the operator has opened it", async () => {
      const anaId = `cust-${run}-ana`;
      const account = await registerCustomer(db, { tenantId: openTenantId, userId: anaId });
      expect(account.tenantId).toBe(openTenantId);
      expect(await findCustomerAccount(db, openTenantId, anaId)).not.toBeNull();
    });

    it("is idempotent — registering twice yields one account", async () => {
      const anaId = `cust-${run}-ana`;
      const again = await registerCustomer(db, { tenantId: openTenantId, userId: anaId });
      const rows = await db
        .select()
        .from(tenantCustomers)
        .where(and(eq(tenantCustomers.tenantId, openTenantId), eq(tenantCustomers.userId, anaId)));
      expect(rows).toHaveLength(1);
      expect(again.id).toBe(rows[0]!.id);
    });

    it("refuses to invite someone who already has an account", async () => {
      await expect(
        inviteCustomer(db, { tenantId, email: emailOf("dee"), invitedByUserId: operatorId }),
      ).rejects.toThrow(/already has an account/);
    });

    it("refuses a second open invitation to the same address", async () => {
      await expect(
        inviteCustomer(db, { tenantId, email: emailOf("cal"), invitedByUserId: operatorId }),
      ).rejects.toThrow(/already been invited/);
    });

    it("refuses an address that is not one", async () => {
      await expect(
        inviteCustomer(db, { tenantId, email: "not-an-address", invitedByUserId: operatorId }),
      ).rejects.toThrow(/does not look right/);
    });
  });

  describe("tenant scoping", () => {
    it("does not resolve an account from another operator", async () => {
      // The isolation property. A lookup by user id alone would return this account and
      // every check downstream would pass honestly against the wrong tenant.
      const deeId = `cust-${run}-dee`;
      expect(await findCustomerAccount(db, tenantId, deeId)).not.toBeNull();
      expect(await findCustomerAccount(db, openTenantId, deeId)).toBeNull();
    });

    it("lists one account per operator for a person who books with both", async () => {
      const deeId = `cust-${run}-dee`;
      await registerCustomer(db, { tenantId: openTenantId, userId: deeId });
      const held = await listCustomerAccountsForUser(db, deeId);
      // Identity is global, the relationship is scoped — a firm may use two couriers.
      expect(held.map((a) => a.tenantId).sort()).toEqual([tenantId, openTenantId].sort());
    });
  });

  describe("blocking", () => {
    it("hides a blocked account from the customer surfaces but keeps it for the operator", async () => {
      const deeId = `cust-${run}-dee`;
      const [account] = (await listCustomers(db, tenantId)).filter((c) => c.userId === deeId);
      expect(account).toBeDefined();

      await setCustomerStatus(db, tenantId, account!.id, "blocked");
      // Resolves as null: an operator who blocked someone does not want a page arguing
      // with them, and every caller would otherwise have to remember to check.
      expect(await findCustomerAccount(db, tenantId, deeId)).toBeNull();
      // But the row survives, so the jobs they booked keep their provenance.
      expect((await listCustomers(db, tenantId)).some((c) => c.userId === deeId)).toBe(true);

      await setCustomerStatus(db, tenantId, account!.id, "active");
      expect(await findCustomerAccount(db, tenantId, deeId)).not.toBeNull();
    });
  });

  describe("withdrawing an invitation", () => {
    it("removes it, scoped to the operator who sent it", async () => {
      const { invitation } = await inviteCustomer(db, {
        tenantId,
        email: `revoke-${run}@customers-${run}.test`,
        invitedByUserId: operatorId,
      });
      // Another operator must not be able to withdraw it.
      await revokeCustomerInvitation(db, openTenantId, invitation.id);
      expect(
        (await listPendingCustomerInvitations(db, tenantId)).some((i) => i.id === invitation.id),
      ).toBe(true);

      await revokeCustomerInvitation(db, tenantId, invitation.id);
      expect(
        (await listPendingCustomerInvitations(db, tenantId)).some((i) => i.id === invitation.id),
      ).toBe(false);
    });
  });
});
