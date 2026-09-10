/**
 * Evidence retention: how long we keep what, and the sweep that destroys it on time.
 *
 * The rule is not ours to pick. A medical courier is a HIPAA business associate, and the
 * audit trail and evidence behind a delivery must be retained for **six years**. Both
 * halves of that matter equally and fail in opposite directions:
 *
 *   destroying evidence EARLY breaks the retention obligation, and
 *   keeping it FOREVER means holding PHI with no lawful basis and no way to answer
 *   "what do you still have of ours?"
 *
 * Before this existed the product did the second one by accident, and worse than that:
 * `order_proofs` cascade-deletes from `orders` and `tenants` and was the only thing
 * holding the object keys, so deleting an order stranded the photo and signature in the
 * bucket with nothing left that could name them. `storage_objects` is the durable index
 * that fixes it, and this module is the policy over the top.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. There is no S3 lifecycle rule. A bucket-level
 * expiry cannot express a per-object promise, cannot be audited per tenant, and — the
 * decisive part — would delete objects without recording that it had, which leaves the
 * same "cannot account for it" problem pointing the other way. The sweep writes
 * `deleted_at` because a destruction you cannot evidence is not a destruction you can
 * report.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import { storageObjects, type Db, type StorageObject } from "@porterdirect/db";

/**
 * Six years, as HIPAA §164.316(b)(2)(i) requires for documentation, and as the medical
 * courier procurement questionnaires ask for directly.
 *
 * Expressed in years and applied with calendar arithmetic rather than as a day count:
 * `365 * 6` drifts by a day and a half over the period because of leap years, and a
 * retention promise that expires early — even by a day — is the wrong kind of wrong.
 */
export const RETENTION_YEARS = 6;

/**
 * WHAT SIX YEARS COSTS, estimated before it was promised rather than discovered later.
 *
 * A full-resolution phone photo is ~4MB and is never re-encoded (that is the requirement
 * POD exists for), plus ~50KB of signature. At 15 deliveries per driver per working day
 * and $0.023/GB/month, the store fills for six years and then plateaus on a rolling
 * window:
 *
 *   Direct Courier   5 drivers    ~18,750/yr     74 GB/yr     445 GB at year 6   ~$10/mo
 *   Fleet & Freight  15 drivers   ~56,250/yr    222 GB/yr   1,335 GB at year 6   ~$31/mo
 *   White-Label      50 drivers  ~187,500/yr    742 GB/yr   4,449 GB at year 6  ~$102/mo
 *
 * So retention costs roughly 5% of the $199 tier and 10% of the $999 one at full
 * maturity, and a sixth of that in year one. It is affordable, which is the point of
 * working it out — but the Agency tier is the tight one, and a tenant running heavier
 * volume than 15 drops per driver per day moves proportionally. If per-tenant retention
 * periods ever become a product feature, this is the arithmetic that prices them.
 */

export function retainUntil(from: Date = new Date()): Date {
  const due = new Date(from.getTime());
  due.setUTCFullYear(due.getUTCFullYear() + RETENTION_YEARS);
  return due;
}

/**
 * Record an object we just wrote to the bucket.
 *
 * Called at the point of upload, not at proof-capture, because the bucket write is what
 * creates the obligation. An object uploaded by a device whose order then failed to save
 * is still PHI sitting in our bucket, and it must be enumerable.
 */
export async function recordStorageObject(
  db: Db,
  args: {
    readonly tenantId: string;
    readonly orderId: string | null;
    readonly key: string;
    readonly kind: string;
    readonly contentType: string;
    readonly byteSize?: number | null;
    readonly now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .insert(storageObjects)
    .values({
      tenantId: args.tenantId,
      orderId: args.orderId,
      key: args.key,
      kind: args.kind,
      contentType: args.contentType,
      byteSize: args.byteSize ?? null,
      retainUntil: retainUntil(now),
    })
    // A device that retries its upload must not produce a second ledger row for the same
    // key — two rows would let the sweep believe it had destroyed something it had not.
    .onConflictDoNothing({ target: storageObjects.key });
}

/** Everything still in the bucket for a tenant, whether or not its order still exists. */
export async function listRetainedObjects(
  db: Db,
  tenantId: string,
): Promise<readonly StorageObject[]> {
  return db
    .select()
    .from(storageObjects)
    .where(and(eq(storageObjects.tenantId, tenantId), isNull(storageObjects.deletedAt)));
}

/** What the sweep would destroy right now. Read it before running it. */
export async function findExpiredObjects(
  db: Db,
  now: Date = new Date(),
  limit = 500,
): Promise<readonly StorageObject[]> {
  return db
    .select()
    .from(storageObjects)
    .where(and(lte(storageObjects.retainUntil, now), isNull(storageObjects.deletedAt)))
    .limit(limit);
}

export interface ObjectDestroyer {
  /** Remove one object from the bucket. Must be idempotent — the sweep may retry. */
  destroy(key: string): Promise<void>;
}

export interface SweepResult {
  readonly considered: number;
  readonly destroyed: number;
  readonly failed: readonly string[];
}

/**
 * Destroy everything past its retention date, and record that we did.
 *
 * ORDER IS LOAD-BEARING: the bucket object goes first, and only a successful destroy
 * marks the row. The reverse — mark then delete — would leave a row claiming an object
 * was destroyed while it sat in the bucket, which is precisely the false assurance this
 * whole module exists to prevent. A failed destroy leaves the row untouched so the next
 * sweep retries it, and the key is reported so a stuck object is visible rather than
 * silently skipped forever.
 *
 * One object at a time on purpose. A batch delete that partially fails cannot tell you
 * which half succeeded, and this is the operation where that matters most.
 */
export async function sweepExpiredObjects(
  db: Db,
  destroyer: ObjectDestroyer,
  now: Date = new Date(),
  limit = 500,
): Promise<SweepResult> {
  const due = await findExpiredObjects(db, now, limit);
  const failed: string[] = [];
  let destroyed = 0;

  for (const object of due) {
    try {
      await destroyer.destroy(object.key);
    } catch {
      // Not fatal to the sweep: one unreachable object must not stop the rest expiring.
      failed.push(object.key);
      continue;
    }
    await db
      .update(storageObjects)
      .set({ deletedAt: new Date() })
      .where(and(eq(storageObjects.id, object.id), isNull(storageObjects.deletedAt)));
    destroyed += 1;
  }

  return { considered: due.length, destroyed, failed };
}
