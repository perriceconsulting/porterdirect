/**
 * Order invariants under REAL concurrency, against a real Postgres.
 *
 * This file exists because I wrote a check-then-act race and shipped it. `redispatchOrder`
 * used to SELECT for an existing re-dispatch and then INSERT — the same shape the webhook
 * ledger was already bitten by, in a file where the function directly above it carries a
 * comment explaining why that shape is wrong. Two concurrent requests both passed the
 * SELECT and both created a job, which means two drivers sent to one delivery.
 *
 * Placed here rather than in the PHAST browser suite deliberately, per the project's own
 * rule: a data invariant (uniqueness, counts, balances) belongs in a deterministic test
 * that runs in milliseconds. The browser would only be testing a rendering of the rule.
 *
 * Concurrency here is real: separate HTTP round-trips to Neon fired together, so what is
 * being proved is that POSTGRES enforces the invariant, not that JavaScript happened to
 * run in a convenient order.
 *
 * Skipped (not failed) without DATABASE_URL, so the suite still runs offline.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  orderEvents,
  orderProofs,
  orders,
  tenants,
  type Db,
} from "@porterdirect/db";
import {
  OrderValidationError,
  createOrder,
  findProof,
  findRedispatch,
  recordProof,
  redispatchOrder,
  transitionOrder,
} from "../lib/orders";

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

/** How many callers pile onto the same job. A double-click is 2; this is deliberately worse. */
const RACERS = 8;

suite("order invariants under real concurrency", () => {
  let db: Db;
  let tenantId = "";
  const runId = randomUUID().slice(0, 8);
  // No user row is created: `actor_user_id` is nullable and every assertion here is about
  // orders. Fewer fixtures means fewer things to leak.
  const ACTOR = null as unknown as string;

  const address = (line1: string) => ({
    line1,
    city: "Los Angeles",
    region: "CA",
    postalCode: "90017",
    country: "US",
  });

  async function newJob(): Promise<string> {
    const order = await createOrder(db, {
      tenantId,
      actorUserId: ACTOR,
      type: "fixed_pickup",
      customerFirstName: "Race",
      customerLastName: `Case${runId}`,
      customerPhone: "2133734253",
      country: "US",
      pickup: address("811 W 7th St"),
      dropoff: address("1355 N Highland Ave"),
      priceCents: 4850,
      scheduledFor: null,
    });
    return order.id;
  }

  /** Walk a job to `failed`, the only state a re-dispatch may start from. */
  async function failedJob(): Promise<string> {
    const id = await newJob();
    for (const to of ["assigned", "en_route"] as const) {
      await transitionOrder(db, { tenantId, orderId: id, to, actorUserId: ACTOR });
    }
    await transitionOrder(db, {
      tenantId,
      orderId: id,
      to: "failed",
      actorUserId: ACTOR,
      reason: "recipient_unavailable",
    });
    return id;
  }

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [t] = await db
      .insert(tenants)
      .values({
        name: `race ${runId}`,
        primaryHost: `race-${runId}.test`,
        defaultCountry: "US",
      })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  afterAll(async () => {
    if (!db || !tenantId) return;
    // Scoped to THIS run's tenant — the only thing this suite owns.
    await db.delete(orderProofs).where(eq(orderProofs.tenantId, tenantId));
    await db.delete(orderEvents).where(eq(orderEvents.tenantId, tenantId));
    await db.delete(orders).where(eq(orders.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it("re-dispatches a failed job exactly once under concurrent attempts", async () => {
    const originalId = await failedJob();

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () =>
        redispatchOrder(db, { tenantId, orderId: originalId, actorUserId: ACTOR }),
      ),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    // The invariant. Two winners means two drivers on one delivery.
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(RACERS - 1);

    // And the database agrees — not just the return values.
    const children = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.redispatchedFromOrderId, originalId));
    expect(children).toHaveLength(1);
  });

  it("tells the losers WHICH job won, rather than failing opaquely", async () => {
    const originalId = await failedJob();
    await redispatchOrder(db, { tenantId, orderId: originalId, actorUserId: ACTOR });

    const winner = await findRedispatch(db, tenantId, originalId);
    expect(winner).not.toBeNull();

    // A refusal an operator cannot act on sends them to the database by hand.
    await expect(
      redispatchOrder(db, { tenantId, orderId: originalId, actorUserId: ACTOR }),
    ).rejects.toThrow(new RegExp(`already been re-dispatched as ${winner!.reference}`));
  });

  it("surfaces a losing re-dispatch as a refusal, never as a reference failure", async () => {
    // Regression guard. `createOrder` retries on a duplicate reference, and that catch
    // once matched any /duplicate key/ — so a genuine "already re-dispatched" collision
    // burned five retries and reported "Could not allocate an order reference", which
    // points at the wrong problem entirely.
    const originalId = await failedJob();
    await redispatchOrder(db, { tenantId, orderId: originalId, actorUserId: ACTOR });

    const err = await redispatchOrder(db, {
      tenantId,
      orderId: originalId,
      actorUserId: ACTOR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OrderValidationError);
    expect(String(err)).not.toMatch(/allocate an order reference/i);
  });

  it("applies exactly one of several concurrent transitions of the same job", async () => {
    // `transitionOrder` scopes its UPDATE by the status it READ, which is a
    // compare-and-swap. This proves that rather than assuming it: eight callers all try
    // to move one pending job, and the audit trail must show one move, not eight.
    const id = await newJob();

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () =>
        transitionOrder(db, { tenantId, orderId: id, to: "assigned", actorUserId: ACTOR }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const events = await db
      .select({ to: orderEvents.toStatus })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id));
    // "Order created", then exactly one "assigned". An append-only trail that records a
    // move twice is not a chain of custody.
    expect(events.filter((e) => e.to === "assigned")).toHaveLength(1);
  });

  it("records proof of delivery exactly once under concurrent capture", async () => {
    // A driver double-tapping at the door, or two devices on one job. Two proofs would
    // raise "which one is the evidence?" at exactly the moment somebody disputes a
    // delivery — so the unique index decides it, not a pre-check.
    const id = await newJob();
    for (const to of ["assigned", "en_route"] as const) {
      await transitionOrder(db, { tenantId, orderId: id, to, actorUserId: ACTOR });
    }

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        recordProof(db, {
          tenantId,
          orderId: id,
          capturedByUserId: ACTOR,
          recipientName: `Recipient ${i}`,
          signatureKey: `tenants/${tenantId}/orders/${id}/signature-${i}.png`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.select().from(orderProofs).where(eq(orderProofs.orderId, id));
    expect(rows).toHaveLength(1);

    // And the loser is told why, rather than failing with a raw constraint error.
    await expect(
      recordProof(db, {
        tenantId,
        orderId: id,
        capturedByUserId: ACTOR,
        recipientName: "Later",
      }),
    ).rejects.toThrow(/already has proof/i);
  });

  it("refuses an empty proof", async () => {
    // Evidence that proves nothing still LOOKS like evidence in a list, and only answers
    // nothing once somebody opens it.
    const id = await newJob();
    await expect(
      recordProof(db, { tenantId, orderId: id, capturedByUserId: ACTOR }),
    ).rejects.toThrow(/signature, a photo, or the recipient/i);
    expect(await findProof(db, tenantId, id)).toBeNull();
  });

  it("scopes proof reads by tenant, not just by order", async () => {
    const id = await newJob();
    await recordProof(db, {
      tenantId,
      orderId: id,
      capturedByUserId: ACTOR,
      recipientName: "Real Recipient",
    });
    expect(await findProof(db, tenantId, id)).not.toBeNull();
    // A foreign tenant id must return nothing even with a VALID order id — the shape
    // that leaks is fetching by order and checking the tenant afterwards.
    expect(await findProof(db, randomUUID(), id)).toBeNull();
  });

  it("closes a job once, with one reason, under concurrent closures", async () => {
    const id = await newJob();
    await transitionOrder(db, { tenantId, orderId: id, to: "assigned", actorUserId: ACTOR });

    const results = await Promise.allSettled([
      transitionOrder(db, {
        tenantId,
        orderId: id,
        to: "cancelled",
        actorUserId: ACTOR,
        reason: "customer_cancelled",
      }),
      transitionOrder(db, {
        tenantId,
        orderId: id,
        to: "failed",
        actorUserId: ACTOR,
        reason: "recipient_unavailable",
      }),
    ]);

    // Both are legal moves from `assigned`, so this is a genuine race rather than one
    // legal call and one illegal one. A job that ends both cancelled AND failed has no
    // meaningful outcome to report on.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const [row] = await db
      .select({ status: orders.status, reason: orders.closureReason })
      .from(orders)
      .where(eq(orders.id, id));
    expect(["cancelled", "failed"]).toContain(row!.status);
    expect(row!.reason).toBeTruthy();
  });
});
