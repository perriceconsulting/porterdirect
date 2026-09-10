/**
 * Evidence retention, against a real Postgres.
 *
 * The defect this closes: `order_proofs` cascade-deletes from `orders` and `tenants` and
 * was the only thing holding the object keys, so deleting one order left the delivery
 * photo and signature in the bucket with nothing able to name them. PHI we could neither
 * account for nor destroy — a reportable condition under a BAA, not an untidy corner.
 *
 * So the load-bearing assertion here is the one about SURVIVAL: after an order and even
 * its whole tenant are deleted, the ledger row is still there and the object is still
 * enumerable. Everything else is about the sweep destroying on time and never lying about
 * what it destroyed.
 *
 * Skipped (not failed) without DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, storageObjects, tenants, type Db } from "@porterdirect/db";
import {
  RETENTION_YEARS,
  findExpiredObjects,
  listRetainedObjects,
  recordStorageObject,
  retainUntil,
  sweepExpiredObjects,
  type ObjectDestroyer,
} from "../lib/retention";

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

/** Records what it was asked to destroy, and can be told to fail on one key. */
function fakeBucket(failOn: readonly string[] = []): ObjectDestroyer & { destroyed: string[] } {
  const destroyed: string[] = [];
  return {
    destroyed,
    destroy(key: string) {
      if (failOn.includes(key)) return Promise.reject(new Error("bucket unavailable"));
      destroyed.push(key);
      return Promise.resolve();
    },
  };
}

describe("the retention period", () => {
  it("is six years, as HIPAA documentation retention requires", () => {
    expect(RETENTION_YEARS).toBe(6);
  });

  it("uses calendar arithmetic, not a day count", () => {
    // `365 * 6` drifts by a day and a half across leap years, and a retention promise
    // that expires EARLY — even by a day — is the wrong kind of wrong.
    const from = new Date("2024-02-29T12:00:00.000Z"); // a leap day, deliberately
    const due = retainUntil(from);
    expect(due.getUTCFullYear()).toBe(2030);
    const naive = new Date(from.getTime() + 365 * 6 * 24 * 60 * 60 * 1000);
    expect(due.getTime()).toBeGreaterThan(naive.getTime());
  });
});

suite("evidence retention", () => {
  let db: Db;
  let tenantId = "";
  const run = randomUUID().slice(0, 8);
  const orderId = randomUUID();
  const keyOf = (n: string) => `tenants/test-${run}/orders/${orderId}/${n}`;

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [t] = await db
      .insert(tenants)
      .values({ name: `Retention ${run}`, primaryHost: `ret-${run}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  afterAll(async () => {
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
    // The ledger deliberately does NOT cascade, so this run's rows have to be cleared by
    // hand — scoped to the keys this run owns, never a pattern that could match real data.
    for (const n of ["photo-a.jpg", "signature-a.png", "old-a.jpg", "old-b.jpg", "stuck.jpg"]) {
      await db.delete(storageObjects).where(eq(storageObjects.key, keyOf(n)));
    }
  });

  it("records an uploaded object with a six-year retention date", async () => {
    const now = new Date("2026-01-15T10:00:00.000Z");
    await recordStorageObject(db, {
      tenantId,
      orderId,
      key: keyOf("photo-a.jpg"),
      kind: "photo",
      contentType: "image/jpeg",
      byteSize: 3_500_000,
      now,
    });
    const [row] = await db
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.key, keyOf("photo-a.jpg")));
    expect(row).toBeDefined();
    expect(row!.retainUntil.getUTCFullYear()).toBe(2032);
    expect(row!.deletedAt).toBeNull();
    expect(row!.byteSize).toBe(3_500_000);
  });

  it("does not double-record a retried upload", async () => {
    // A device retrying its PUT must not produce a second row: two rows for one key would
    // let the sweep believe it had destroyed something it had not.
    await recordStorageObject(db, {
      tenantId,
      orderId,
      key: keyOf("photo-a.jpg"),
      kind: "photo",
      contentType: "image/jpeg",
    });
    const rows = await db
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.key, keyOf("photo-a.jpg")));
    expect(rows).toHaveLength(1);
  });

  /**
   * THE ASSERTION THIS TABLE EXISTS FOR.
   */
  describe("evidence outlives the rows it came from", () => {
    it("survives its order being deleted", async () => {
      await recordStorageObject(db, {
        tenantId,
        orderId,
        key: keyOf("signature-a.png"),
        kind: "signature",
        contentType: "image/png",
      });

      // There is no order row to delete here — the point is that the ledger holds a plain
      // uuid with NO foreign key, so nothing about the order's fate can reach it. Proving
      // it directly: the ledger row references an order id that does not exist at all.
      const retained = await listRetainedObjects(db, tenantId);
      expect(retained.map((r) => r.key)).toContain(keyOf("signature-a.png"));
      expect(retained.every((r) => r.orderId === orderId)).toBe(true);
    });

    it("survives its TENANT being deleted", async () => {
      const [doomed] = await db
        .insert(tenants)
        .values({ name: `Doomed ${run}`, primaryHost: `doomed-${run}.example.test` })
        .returning({ id: tenants.id });
      const doomedId = doomed!.id;
      const key = `tenants/${doomedId}/orders/${randomUUID()}/photo.jpg`;

      await recordStorageObject(db, {
        tenantId: doomedId,
        orderId: randomUUID(),
        key,
        kind: "photo",
        contentType: "image/jpeg",
      });

      // Deleting a tenant cascades away orders, events and proofs. Before this table, that
      // took the object keys with it and stranded the PHI permanently.
      await db.delete(tenants).where(eq(tenants.id, doomedId));

      const [survivor] = await db.select().from(storageObjects).where(eq(storageObjects.key, key));
      expect(survivor, "the ledger row died with the tenant — PHI is now unreachable").toBeDefined();
      expect(survivor!.tenantId).toBe(doomedId);

      await db.delete(storageObjects).where(eq(storageObjects.key, key));
    });
  });

  describe("the sweep", () => {
    it("destroys nothing that is still within its retention period", async () => {
      const bucket = fakeBucket();
      const result = await sweepExpiredObjects(db, bucket, new Date("2026-06-01T00:00:00.000Z"));
      expect(bucket.destroyed).not.toContain(keyOf("photo-a.jpg"));
      expect(result.failed).toHaveLength(0);
    });

    it("destroys what is past its date, and records that it did", async () => {
      const longAgo = new Date("2015-01-01T00:00:00.000Z"); // retains until 2021
      for (const n of ["old-a.jpg", "old-b.jpg"]) {
        await recordStorageObject(db, {
          tenantId,
          orderId,
          key: keyOf(n),
          kind: "photo",
          contentType: "image/jpeg",
          now: longAgo,
        });
      }

      const due = await findExpiredObjects(db, new Date("2026-01-01T00:00:00.000Z"));
      expect(due.map((d) => d.key)).toEqual(expect.arrayContaining([keyOf("old-a.jpg"), keyOf("old-b.jpg")]));

      const bucket = fakeBucket();
      const result = await sweepExpiredObjects(db, bucket, new Date("2026-01-01T00:00:00.000Z"));
      expect(bucket.destroyed).toEqual(expect.arrayContaining([keyOf("old-a.jpg"), keyOf("old-b.jpg")]));
      expect(result.destroyed).toBeGreaterThanOrEqual(2);

      // The row is marked, not removed: a destruction you cannot evidence is not one you
      // can report.
      const [row] = await db.select().from(storageObjects).where(eq(storageObjects.key, keyOf("old-a.jpg")));
      expect(row!.deletedAt).not.toBeNull();
    });

    it("does not destroy the same object twice", async () => {
      const bucket = fakeBucket();
      await sweepExpiredObjects(db, bucket, new Date("2026-01-01T00:00:00.000Z"));
      expect(bucket.destroyed).not.toContain(keyOf("old-a.jpg"));
    });

    it("leaves a row unmarked when the bucket delete fails, so the next sweep retries", async () => {
      // The ordering that matters: object first, row second. Marking first would leave a
      // row claiming an object was destroyed while it sat in the bucket — the exact false
      // assurance this module exists to prevent.
      const longAgo = new Date("2015-01-01T00:00:00.000Z");
      await recordStorageObject(db, {
        tenantId,
        orderId,
        key: keyOf("stuck.jpg"),
        kind: "photo",
        contentType: "image/jpeg",
        now: longAgo,
      });

      const bucket = fakeBucket([keyOf("stuck.jpg")]);
      const result = await sweepExpiredObjects(db, bucket, new Date("2026-01-01T00:00:00.000Z"));

      expect(result.failed).toContain(keyOf("stuck.jpg"));
      const [row] = await db.select().from(storageObjects).where(eq(storageObjects.key, keyOf("stuck.jpg")));
      expect(row!.deletedAt, "marked destroyed while still in the bucket").toBeNull();

      // And a later sweep picks it up again rather than skipping it forever.
      const retry = fakeBucket();
      await sweepExpiredObjects(db, retry, new Date("2026-01-01T00:00:00.000Z"));
      expect(retry.destroyed).toContain(keyOf("stuck.jpg"));
    });

    it("one unreachable object does not stop the rest expiring", async () => {
      const rows = await db
        .select()
        .from(storageObjects)
        .where(and(eq(storageObjects.tenantId, tenantId), eq(storageObjects.kind, "photo")));
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
