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
import { eq, inArray } from "drizzle-orm";
import {
  createDbClient,
  orderEvents,
  orderProofs,
  orders,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";
import {
  OrderValidationError,
  claimOrder,
  createOrder,
  declineOrder,
  findProof,
  listOffersFor,
  listOrders,
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
  // A REAL user row: `assigned_user_id` carries a foreign key, so a random id is rejected
  // by the database rather than quietly stored. Worth having the constraint bite in a
  // test rather than discovering it when a driver is assigned in production.
  let driverId = "";
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
      // Priced for a driver, because an unpriced job cannot be accepted — the guard for
      // that is asserted separately below.
      driverPayCents: 3200,
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

    driverId = `drv-${runId}`;
    await db.insert(users).values({
      id: driverId,
      name: `Race Driver ${runId}`,
      email: `driver-${runId}@race-${runId}.test`,
    });
  });

  afterAll(async () => {
    if (!db || !tenantId) return;
    // Scoped to THIS run's tenant — the only thing this suite owns.
    await db.delete(orderProofs).where(eq(orderProofs.tenantId, tenantId));
    // Audit rows are NOT deleted here, and cannot be: `order_events` is append-only in
    // the database and its rows are retained for six years. Test and demo runs therefore
    // leave their custody trail behind, which is the same thing production does and is
    // the point of the guarantee — a trail a cleanup script can erase is not a trail.
    await db.delete(orders).where(eq(orders.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    if (driverId) await db.delete(users).where(eq(users.id, driverId));
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

  it("shows a driver their own job even when it is not among the newest", async () => {
    // The bug this exists for: the board fetched the most recent N rows and filtered to
    // the driver AFTERWARDS, so on a busy tenant a driver whose job was older than the
    // page limit saw an empty board. It read as "no work today", degraded as the operator
    // grew, and no test could see it because every fixture had a handful of orders.
    const driver = driverId;
    const mine = await newJob();
    await db.update(orders).set({ assignedUserId: driver }).where(eq(orders.id, mine));

    // Bury it under newer work belonging to nobody.
    for (let i = 0; i < 4; i++) await newJob();

    // A page size that puts the driver's job out of reach of a fetch-then-filter.
    const page = await listOrders(db, tenantId, { assignedTo: driver, limit: 2 });
    expect(page.map((o) => o.id)).toContain(mine);
    // And only theirs: narrowing must not widen.
    expect(page.every((o) => o.assignedUserId === driver)).toBe(true);
  });

  it("still scopes by tenant when narrowing to a driver", async () => {
    // The second predicate must ADD to the tenant one, never replace it.
    const driver = driverId;
    const mine = await newJob();
    await db.update(orders).set({ assignedUserId: driver }).where(eq(orders.id, mine));
    expect(await listOrders(db, randomUUID(), { assignedTo: driver })).toHaveLength(0);
  });

  it("gives an unassigned job to exactly ONE of many drivers claiming at once", async () => {
    // The risk the feature invites: a job appears in every driver's Available list, and
    // several tap it in the same second. Two winners means two vans at one doorstep.
    const id = await newJob();

    const drivers = await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => {
        const uid = `clm-${runId}-${i}`;
        await db.insert(users).values({
          id: uid,
          name: `Claimer ${i}`,
          email: `claimer-${i}-${runId}@race-${runId}.test`,
        });
        return uid;
      }),
    );

    const results = await Promise.allSettled(
      drivers.map((uid) => claimOrder(db, { tenantId, orderId: id, userId: uid })),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(RACERS - 1);

    // And the database agrees — one assignee, one audit line, not eight.
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    expect(row!.assignedUserId).toBeTruthy();
    expect(row!.status).toBe("assigned");
    const events = await db
      .select({ to: orderEvents.toStatus, note: orderEvents.note })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id));
    expect(events.filter((e) => e.note === "Claimed by driver")).toHaveLength(1);

    await db.delete(users).where(inArray(users.id, drivers));
  });

  it("refuses to accept a job with no driver pay set", async () => {
    // "Accept or decline" with no amount is not a choice. A driver who accepts an
    // unpriced job has agreed to something nobody stated, and the argument about what it
    // was worth happens after the work is done.
    const unpriced = await createOrder(db, {
      tenantId,
      actorUserId: ACTOR,
      type: "fixed_pickup",
      customerFirstName: "Unpriced",
      customerLastName: `Case${runId}`,
      customerPhone: "2133734253",
      country: "US",
      pickup: address("811 W 7th St"),
      dropoff: address("1355 N Highland Ave"),
      priceCents: 4850,
      scheduledFor: null,
    });

    await expect(
      claimOrder(db, { tenantId, orderId: unpriced.id, userId: driverId }),
    ).rejects.toThrow(/no driver pay/i);

    // And it stays unassigned rather than half-taken.
    const [row] = await db.select().from(orders).where(eq(orders.id, unpriced.id));
    expect(row!.assignedUserId).toBeNull();
    expect(row!.status).toBe("pending");
  });

  it("hides a declined offer from that driver and nobody else", async () => {
    const id = await newJob();
    const other = `other-${runId}`;
    await db.insert(users).values({
      id: other,
      name: "Other Driver",
      email: `other-${runId}@race-${runId}.test`,
    });

    await declineOrder(db, { tenantId, orderId: id, userId: driverId, reason: "Too far" });

    // Gone for the driver who said no...
    expect((await listOffersFor(db, tenantId, driverId)).map((o) => o.id)).not.toContain(id);
    // ...and still offered to everyone else. A decline is one person's answer, not a
    // verdict on the work.
    expect((await listOffersFor(db, tenantId, other)).map((o) => o.id)).toContain(id);

    // Saying no twice is the same answer, not an error.
    await expect(
      declineOrder(db, { tenantId, orderId: id, userId: driverId }),
    ).resolves.toBeUndefined();

    await db.delete(users).where(inArray(users.id, [other]));
  });

  it("tells the losers something they can act on", async () => {
    const id = await newJob();
    const a = `lose-a-${runId}`;
    const b = `lose-b-${runId}`;
    for (const uid of [a, b]) {
      await db.insert(users).values({
        id: uid,
        name: uid,
        email: `${uid}@race-${runId}.test`,
      });
    }

    await claimOrder(db, { tenantId, orderId: id, userId: a });
    // One message for "someone took it", "it was cancelled" and "no such job": a driver
    // acts on all three the same way, and distinguishing them would report on work they
    // are not entitled to see.
    await expect(claimOrder(db, { tenantId, orderId: id, userId: b })).rejects.toThrow(
      /no longer available/i,
    );
    await db.delete(users).where(inArray(users.id, [a, b]));
  });

  it("offers only genuinely unclaimed work", async () => {
    const free = await newJob();
    const taken = await newJob();
    await db.update(orders).set({ assignedUserId: driverId }).where(eq(orders.id, taken));

    const claimable: Awaited<ReturnType<typeof listOffersFor>> = await listOffersFor(db, tenantId, driverId);
    const ids = claimable.map((o) => o.id);
    expect(ids).toContain(free);
    // Assigned-but-still-pending belongs to somebody. Listing it invites two people to
    // the same doorstep.
    expect(ids).not.toContain(taken);
    expect(claimable.every((o) => o.status === "pending" && o.assignedUserId === null)).toBe(true);
  });

  it("never offers another tenant's unclaimed work", async () => {
    expect(await listOffersFor(db, randomUUID(), driverId)).toHaveLength(0);
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
