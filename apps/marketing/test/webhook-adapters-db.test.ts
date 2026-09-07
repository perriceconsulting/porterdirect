/**
 * Integration tests for the DB-backed webhook ports, against a REAL Postgres.
 *
 * The in-memory tests prove the dispatch contract; only this file proves the property
 * that actually matters in production: that `claimEvent` is atomic because POSTGRES
 * makes it atomic, not because a JS Set happened to be synchronous. Concurrency here
 * is real concurrent HTTP round-trips to Neon.
 *
 * Skipped (not failed) when DATABASE_URL is absent, so the suite still runs offline.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processedWebhookEvents, subscriptions, tenants } from "@porterdirect/db";
import {
  DbSubscriptionSink,
  DbWebhookEventStore,
  UnknownTenantError,
  createDbAdapters,
} from "../lib/webhook-adapters-db";
import type { TenantSubscription } from "@porterdirect/billing";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    for (const raw of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      const m = /^DATABASE_URL=(.*)$/.exec(line);
      if (m && m[1]) return m[1].trim();
    }
  } catch { /* no .env.local — fall through to skip */ }
  return undefined;
}

const URL_ = databaseUrl();
const suite = URL_ ? describe : describe.skip;

suite("DB-backed webhook adapters (real Postgres)", () => {
  let db: ReturnType<typeof createDbAdapters>["db"];
  let store: DbWebhookEventStore;
  let sink: DbSubscriptionSink;

  const runId = randomUUID().slice(0, 8);
  const eventIds: string[] = [];
  const customerId = `cus_test_${runId}`;
  const subId = `sub_test_${runId}`;
  let tenantId: string;

  const evt = (suffix: string) => {
    const id = `evt_test_${runId}_${suffix}`;
    eventIds.push(id);
    return { id, type: "customer.subscription.updated" };
  };

  const sub = (over: Partial<TenantSubscription> = {}): TenantSubscription => ({
    stripeSubscriptionId: subId,
    planId: "direct_courier",
    status: "active",
    seatCount: 7,
    currentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    entitled: true,
    ...over,
  });

  beforeAll(async () => {
    const adapters = createDbAdapters(URL_);
    db = adapters.db;
    store = adapters.store;
    sink = adapters.sink;
    const [row] = await db
      .insert(tenants)
      .values({ name: `Test Tenant ${runId}`, stripeCustomerId: customerId })
      .returning({ id: tenants.id });
    tenantId = row!.id;
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of eventIds) {
      await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.eventId, id));
    }
    await db.delete(subscriptions).where(eq(subscriptions.stripeSubscriptionId, subId));
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it("claims an unseen event once, and refuses the second claim", async () => {
    const e = evt("once");
    expect(await store.claimEvent(e)).toBe(true);
    expect(await store.claimEvent(e)).toBe(false);
  });

  it("EXACTLY ONE of ten CONCURRENT claims wins — Postgres resolves the race", async () => {
    const e = evt("concurrent");
    const results = await Promise.all(Array.from({ length: 10 }, () => store.claimEvent(e)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(9);
  });

  it("release makes an event claimable again, so a retry can re-process", async () => {
    const e = evt("release");
    expect(await store.claimEvent(e)).toBe(true);
    await store.releaseEvent(e.id);
    expect(await store.claimEvent(e)).toBe(true);
  });

  it("refuses to persist a subscription for a customer with no tenant", async () => {
    await expect(sink.upsert(sub(), `cus_nonexistent_${runId}`)).rejects.toBeInstanceOf(
      UnknownTenantError,
    );
  });

  it("writes a tenant-scoped subscription row", async () => {
    await sink.upsert(sub(), customerId);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantId);
    expect(rows[0]!.planId).toBe("direct_courier");
    expect(rows[0]!.seatCount).toBe(7);
  });

  it("upserts rather than duplicating when the same subscription changes", async () => {
    await sink.upsert(sub({ seatCount: 12, status: "past_due" }), customerId);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subId));
    expect(rows, "must update in place, not insert a second row").toHaveLength(1);
    expect(rows[0]!.seatCount).toBe(12);
    expect(rows[0]!.status).toBe("past_due");
  });
});
