/**
 * Audit logging for reads of protected evidence — HIPAA §164.312(b).
 *
 * The two assertions worth the file:
 *
 *   the log SURVIVES the rows it describes, because an audit trail a cascade can erase is
 *   not an audit trail — and the moment somebody deletes a tenant is exactly the moment
 *   the trail matters; and
 *
 *   `openEvidence` FAILS CLOSED. If the audit write fails, no URL is produced. That is the
 *   uncomfortable half of the design and the one most likely to be "helpfully" relaxed
 *   later, so it is pinned here with the reason attached: the alternative serves PHI with
 *   no record, silently, which is the exact gap this closes.
 *
 * Skipped (not failed) without DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accessEvents, createDbClient, tenants, type Db } from "@porterdirect/db";
import {
  AccessNotRecordedError,
  listAccessForOrder,
  openEvidence,
  purgeExpiredAccessEvents,
  recordAccess,
} from "../lib/access-log";

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

suite("access logging", () => {
  let db: Db;
  let tenantId = "";
  const run = randomUUID().slice(0, 8);
  const orderId = randomUUID();
  const userId = `auditor-${run}`;

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [t] = await db
      .insert(tenants)
      .values({ name: `Audit ${run}`, primaryHost: `audit-${run}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      // No cascade reaches the log — by design — so this run's rows go by hand.
      await db.delete(accessEvents).where(eq(accessEvents.tenantId, tenantId));
    }
    await db.delete(accessEvents).where(eq(accessEvents.orderId, orderId));
  });

  it("records who read what, and when", async () => {
    await recordAccess(db, {
      accessor: { kind: "member", tenantId, userId },
      action: "proof.photo",
      orderId,
      objectKey: `tenants/${tenantId}/orders/${orderId}/photo.jpg`,
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
    });

    const [row] = await listAccessForOrder(db, tenantId, orderId);
    expect(row).toBeDefined();
    expect(row!.actorKind).toBe("member");
    expect(row!.actorUserId).toBe(userId);
    expect(row!.action).toBe("proof.photo");
    expect(row!.ipAddress).toBe("203.0.113.7");
    // Retained on the same six-year clock as the evidence, so the log cannot quietly
    // outlive what it describes.
    expect(row!.retainUntil.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 6);
  });

  it("records a public link as having no identity, rather than inventing one", async () => {
    // "A stranger holding a link" and "a member we failed to identify" are different
    // findings in an audit. Storing null keeps "we do not know who this was" honest.
    await recordAccess(db, {
      accessor: { kind: "public_link", tenantId },
      action: "tracking.view",
      orderId,
    });

    const rows = await listAccessForOrder(db, tenantId, orderId);
    const anon = rows.find((r) => r.actorKind === "public_link");
    expect(anon).toBeDefined();
    expect(anon!.actorUserId).toBeNull();
  });

  it("orders newest first, because the question is always 'who just looked'", async () => {
    const rows = await listAccessForOrder(db, tenantId, orderId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.createdAt.getTime());
    }
  });

  it("does not leak another tenant's access records", async () => {
    const [other] = await db
      .insert(tenants)
      .values({ name: `Other audit ${run}`, primaryHost: `audit2-${run}.example.test` })
      .returning({ id: tenants.id });
    try {
      expect(await listAccessForOrder(db, other!.id, orderId)).toHaveLength(0);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });

  describe("the log survives what it describes", () => {
    it("is not erased when the tenant is deleted", async () => {
      const [doomed] = await db
        .insert(tenants)
        .values({ name: `Doomed audit ${run}`, primaryHost: `doomed-audit-${run}.example.test` })
        .returning({ id: tenants.id });
      const doomedId = doomed!.id;
      const doomedOrder = randomUUID();

      await recordAccess(db, {
        accessor: { kind: "public_link", tenantId: doomedId },
        action: "proof.pdf",
        orderId: doomedOrder,
      });

      await db.delete(tenants).where(eq(tenants.id, doomedId));

      const rows = await db
        .select()
        .from(accessEvents)
        .where(eq(accessEvents.orderId, doomedOrder));
      expect(rows, "the audit trail died with the tenant").toHaveLength(1);

      await db.delete(accessEvents).where(eq(accessEvents.orderId, doomedOrder));
    });
  });

  describe("openEvidence fails closed", () => {
    it("produces no URL when the audit write fails", async () => {
      // A database whose insert cannot succeed. If this ever returns a URL, evidence is
      // being served with no record — the precise condition this module exists to end.
      const brokenDb = {
        insert: () => ({
          values: () => Promise.reject(new Error("audit table unavailable")),
        }),
      } as unknown as Db;

      await expect(
        openEvidence(brokenDb, {
          key: `tenants/${tenantId}/orders/${orderId}/photo.jpg`,
          accessor: { kind: "member", tenantId, userId },
          action: "proof.photo",
          orderId,
        }),
      ).rejects.toThrow(AccessNotRecordedError);
    });
  });

  describe("the log expires on the same clock as the evidence", () => {
    it("purges rows past their retention date and leaves current ones alone", async () => {
      const staleOrder = randomUUID();
      await db.insert(accessEvents).values({
        tenantId,
        orderId: staleOrder,
        actorKind: "public_link",
        action: "tracking.view",
        retainUntil: new Date("2019-01-01T00:00:00.000Z"),
      });

      const purged = await purgeExpiredAccessEvents(db, new Date("2026-01-01T00:00:00.000Z"));
      expect(purged).toBeGreaterThanOrEqual(1);

      expect(
        await db.select().from(accessEvents).where(eq(accessEvents.orderId, staleOrder)),
      ).toHaveLength(0);
      // The current rows for this run are untouched.
      expect(
        (await db
          .select()
          .from(accessEvents)
          .where(and(eq(accessEvents.tenantId, tenantId), eq(accessEvents.orderId, orderId)))).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
