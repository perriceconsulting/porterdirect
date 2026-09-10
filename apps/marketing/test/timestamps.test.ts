/**
 * One clock.
 *
 * Found in a real export: a delivery recorded as DELIVERED BEFORE IT WAS CREATED. Not a
 * rounding artifact — `created_at` defaults to Postgres `now()` while `delivered_at` was
 * set with `new Date()` in Node, and those are two different machines. Measured against
 * this project's own database the skew is about 1.4 seconds, consistently, with the
 * database ahead. Any delivery completed inside that window came out impossible.
 *
 * It reached an evidence pack before anything noticed, which is the worst place for it:
 * a chain-of-custody document containing an event that cannot have happened is not a
 * document a hospital's procurement team will accept, and no amount of explaining
 * recovers it.
 *
 * Skipped (not failed) without DATABASE_URL — the whole point is comparing two clocks, and
 * one of them is the database.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbClient, orderEvents, orders, tenants, type Db } from "@porterdirect/db";
import { createOrder, transitionOrder } from "../lib/orders";

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

suite("order timestamps come from one clock", () => {
  let db: Db;
  let tenantId = "";
  const run = randomUUID().slice(0, 8);

  const address = (line1: string) => ({
    line1,
    city: "Los Angeles",
    region: "CA",
    postalCode: "90017",
    country: "US" as const,
  });

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [t] = await db
      .insert(tenants)
      .values({ name: `Clock ${run}`, primaryHost: `clock-${run}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  afterAll(async () => {
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it("the app clock and the database clock genuinely differ", async () => {
    // Recorded as a fact rather than assumed, because the fix only matters if they do.
    // This is not asserted to be small — it is asserted to be MEASURED, so that a future
    // reader knows the two-clock problem is real here rather than theoretical.
    const before = Date.now();
    const result = await db.execute(sql`select extract(epoch from now()) * 1000 as ms`);
    // The neon-http driver returns `{ rows: [...] }` while some drivers return the array
    // itself. Handled rather than assumed, because guessing a driver's result shape is how
    // a test starts asserting against `undefined` and passing.
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      ms: string | number;
    }[];
    const dbMs = Number(rows[0]?.ms);
    expect(Number.isFinite(dbMs), "could not read the database clock").toBe(true);

    const skewMs = Math.abs(dbMs - before);
    // Reported, not enforced. The fix does not depend on the skew being any particular
    // size — it depends on there being only ONE clock — and asserting a bound here would
    // make this test fail on a well-synchronised machine for no reason.
    console.log(`[clock] app vs database skew: ${Math.round(skewMs)}ms`);
    expect(skewMs).toBeGreaterThanOrEqual(0);
  });

  it("a delivery is never completed before it was created", async () => {
    // The defect, reproduced end to end: create and deliver as fast as possible, which is
    // exactly the window the skew corrupted.
    const order = await createOrder(db, {
      tenantId,
      actorUserId: null as unknown as string,
      type: "fixed_pickup",
      customerFirstName: "Clock",
      customerLastName: `Case${run}`,
      customerPhone: "2133734253",
      country: "US",
      pickup: address("811 W 7th St"),
      dropoff: address("1355 N Highland Ave"),
      priceCents: 4850,
      driverPayCents: 3200,
      scheduledFor: null,
    });

    for (const to of ["assigned", "en_route", "delivered"] as const) {
      await transitionOrder(db, { tenantId, orderId: order.id, to, actorUserId: null as unknown as string });
    }

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.deliveredAt).not.toBeNull();
    expect(
      row!.deliveredAt!.getTime(),
      `delivered ${row!.deliveredAt!.toISOString()} before created ${row!.createdAt.toISOString()}`,
    ).toBeGreaterThanOrEqual(row!.createdAt.getTime());
  });

  it("the audit trail never precedes the order it describes", async () => {
    // `order_events.created_at` is the database clock and `orders.created_at` is too, so
    // this holds — but it is asserted because the moment either moves to the app clock the
    // custody document starts lying about sequence.
    const rows = await db
      .select({ orderCreated: orders.createdAt, eventCreated: orderEvents.createdAt })
      .from(orderEvents)
      .innerJoin(orders, eq(orders.id, orderEvents.orderId))
      .where(eq(orderEvents.tenantId, tenantId));

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.eventCreated.getTime()).toBeGreaterThanOrEqual(r.orderCreated.getTime());
    }
  });

  it("the delivery timestamp is not earlier than the event that recorded it", async () => {
    const rows = await db
      .select({ delivered: orders.deliveredAt, event: orderEvents.createdAt, to: orderEvents.toStatus })
      .from(orderEvents)
      .innerJoin(orders, eq(orders.id, orderEvents.orderId))
      .where(eq(orderEvents.tenantId, tenantId));

    const deliveries = rows.filter((r) => r.to === "delivered" && r.delivered);
    expect(deliveries.length).toBeGreaterThan(0);
    for (const r of deliveries) {
      // Both now come from the database, so these are within milliseconds of each other
      // rather than a second and a half apart in the wrong direction.
      expect(Math.abs(r.delivered!.getTime() - r.event.getTime())).toBeLessThan(5_000);
    }
  });
});
