import { describe, it, expect } from "vitest";
import {
  handleStripeEvent,
  snapshotFromStripeSubscription,
  extractCustomerId,
  type WebhookDeps,
  type WebhookEventStore,
  type SubscriptionSink,
  type RawStripeSubscriptionLike,
} from "../src/webhook.js";
import { toTenantSubscription } from "../src/subscription-state.js";
import type { TenantSubscription } from "../src/types.js";

/**
 * In-memory idempotency ledger. `claimEvent` models the atomic INSERT the DB-backed
 * store must perform: Set.add() is checked and applied without an await between them,
 * so two concurrent callers cannot both win — the same guarantee a primary-key
 * violation gives. An implementation that awaited mid-claim would reintroduce the race.
 */
class MemoryStore implements WebhookEventStore {
  readonly processed = new Set<string>();
  released = 0;

  async claimEvent(event: { id: string }): Promise<boolean> {
    if (this.processed.has(event.id)) return false;
    this.processed.add(event.id);
    return true;
  }

  async releaseEvent(eventId: string): Promise<void> {
    this.processed.delete(eventId);
    this.released += 1;
  }
}

// Records upserts.
class MemorySink implements SubscriptionSink {
  readonly upserts: Array<{ sub: TenantSubscription; customerId: string }> = [];
  async upsert(sub: TenantSubscription, stripeCustomerId: string): Promise<void> {
    this.upserts.push({ sub, customerId: stripeCustomerId });
  }
}

const resolvePlanId = (priceId: string): string => {
  if (priceId === "price_dc") return "direct_courier";
  throw new Error(`no plan for ${priceId}`);
};

const rawSub = (over: Partial<RawStripeSubscriptionLike> = {}): RawStripeSubscriptionLike => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  current_period_end: 1_700_000_000,
  items: { data: [{ quantity: 7, price: { id: "price_dc" } }] },
  ...over,
});

const deps = (store: MemoryStore, sink: MemorySink): WebhookDeps => ({ store, sink, resolvePlanId });

describe("extractCustomerId", () => {
  it("handles both string and expanded customer", () => {
    expect(extractCustomerId("cus_9")).toBe("cus_9");
    expect(extractCustomerId({ id: "cus_9" })).toBe("cus_9");
  });
});

describe("snapshotFromStripeSubscription", () => {
  it("reads the plan and seat count off the matching line item", () => {
    const snap = snapshotFromStripeSubscription(rawSub(), resolvePlanId);
    expect(snap.planId).toBe("direct_courier");
    expect(snap.seatCount).toBe(7);
    expect(snap.stripeCustomerId).toBe("cus_1");
  });

  it("skips add-on line items and still finds the plan", () => {
    const snap = snapshotFromStripeSubscription(
      rawSub({
        items: {
          data: [
            { quantity: 1000, price: { id: "price_sms" } }, // metered add-on, not a plan
            { quantity: 12, price: { id: "price_dc" } },
          ],
        },
      }),
      resolvePlanId,
    );
    expect(snap.planId).toBe("direct_courier");
    expect(snap.seatCount).toBe(12);
  });

  it("throws when no line item maps to a known plan", () => {
    expect(() =>
      snapshotFromStripeSubscription(
        rawSub({ items: { data: [{ quantity: 1, price: { id: "price_sms" } }] } }),
        resolvePlanId,
      ),
    ).toThrow(/no line item matching a known plan/);
  });
});

describe("handleStripeEvent (idempotent dispatch)", () => {
  it("processes a subscription event and upserts the reconciled state", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const result = await handleStripeEvent(
      { id: "evt_1", type: "customer.subscription.updated", data: { object: rawSub() } },
      deps(store, sink),
    );
    expect(result).toEqual({ status: "processed" });
    expect(sink.upserts).toHaveLength(1);
    expect(sink.upserts[0]?.sub.entitled).toBe(true);
    expect(store.processed.has("evt_1")).toBe(true);
  });

  it("skips a duplicate event without upserting again", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const evt = { id: "evt_dup", type: "customer.subscription.updated", data: { object: rawSub() } };
    await handleStripeEvent(evt, deps(store, sink));
    const second = await handleStripeEvent(evt, deps(store, sink));
    expect(second).toEqual({ status: "skipped_duplicate" });
    expect(sink.upserts).toHaveLength(1); // not applied twice
  });

  it("ignores an unrelated event type but records it as processed", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const result = await handleStripeEvent(
      { id: "evt_x", type: "invoice.paid", data: { object: {} } },
      deps(store, sink),
    );
    expect(result.status).toBe("ignored");
    expect(sink.upserts).toHaveLength(0);
    expect(store.processed.has("evt_x")).toBe(true);
  });
});

/**
 * Regression tests for the concurrent-redelivery race.
 *
 * Observed in live `stripe listen` traffic: six events were each handled TWICE, both
 * passing the idempotency guard, because `hasProcessed` + `markProcessed` is a
 * check-then-act pair with an await in the window. Every one of these fails against
 * that design and passes against the atomic claim.
 */
describe("handleStripeEvent — concurrent redelivery", () => {
  it("applies a subscription event exactly once when delivered twice CONCURRENTLY", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const evt = { id: "evt_race", type: "customer.subscription.updated", data: { object: rawSub() } };

    const [a, b] = await Promise.all([
      handleStripeEvent(evt, deps(store, sink)),
      handleStripeEvent(evt, deps(store, sink)),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["processed", "skipped_duplicate"]);
    expect(sink.upserts, "the money-affecting write must happen once").toHaveLength(1);
  });

  it("holds under a burst of ten concurrent deliveries of one event", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const evt = { id: "evt_burst", type: "customer.subscription.updated", data: { object: rawSub() } };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => handleStripeEvent(evt, deps(store, sink))),
    );

    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "skipped_duplicate")).toHaveLength(9);
    expect(sink.upserts).toHaveLength(1);
  });

  it("releases the claim when applying fails, so a later retry re-processes", async () => {
    const store = new MemoryStore();
    const failing: SubscriptionSink = {
      async upsert() {
        throw new Error("DB unavailable");
      },
    };
    const evt = { id: "evt_retry", type: "customer.subscription.updated", data: { object: rawSub() } };

    await expect(handleStripeEvent(evt, deps(store, failing))).rejects.toThrow(/DB unavailable/);
    expect(store.released, "a failed apply must hand the event back").toBe(1);
    expect(store.processed.has("evt_retry"), "must not stay marked processed").toBe(false);

    // Stripe retries; the healthy sink now applies it.
    const sink = new MemorySink();
    const retry = await handleStripeEvent(evt, deps(store, sink));
    expect(retry).toEqual({ status: "processed" });
    expect(sink.upserts).toHaveLength(1);
  });

  it("keeps the claim for an ignored event — it is handled, not deferred", async () => {
    const store = new MemoryStore();
    const sink = new MemorySink();
    const evt = { id: "evt_ignored", type: "invoice.paid", data: { object: {} } };

    await handleStripeEvent(evt, deps(store, sink));
    const second = await handleStripeEvent(evt, deps(store, sink));

    expect(second).toEqual({ status: "skipped_duplicate" });
    expect(store.released).toBe(0);
  });
});

/**
 * Regression: Stripe RELOCATED `current_period_end` from the Subscription onto each
 * subscription item. On API version 2026-08-26.dahlia the subscription-level field is
 * absent, so reading it yielded undefined and `new Date(undefined * 1000)` produced an
 * Invalid Date that only blew up later in the persistence layer as "Invalid time
 * value". Found in live traffic, not in tests — the fixtures here all hand-wrote the
 * old shape. Both shapes are now covered.
 */
describe("snapshotFromStripeSubscription — current_period_end location", () => {
  const base = {
    id: "sub_period",
    customer: "cus_period",
    status: "active",
    cancel_at_period_end: false,
  };

  it("reads the period from the ITEM (current Stripe API versions)", () => {
    const snap = snapshotFromStripeSubscription(
      {
        ...base,
        items: { data: [{ quantity: 7, price: { id: "price_dc" }, current_period_end: 1791367068 }] },
      } as RawStripeSubscriptionLike,
      resolvePlanId,
    );
    expect(snap.currentPeriodEndUnix).toBe(1791367068);
  });

  it("falls back to the SUBSCRIPTION level (legacy API versions)", () => {
    const snap = snapshotFromStripeSubscription(
      {
        ...base,
        current_period_end: 1700000000,
        items: { data: [{ quantity: 7, price: { id: "price_dc" } }] },
      } as RawStripeSubscriptionLike,
      resolvePlanId,
    );
    expect(snap.currentPeriodEndUnix).toBe(1700000000);
  });

  it("prefers the item's period when both are present", () => {
    const snap = snapshotFromStripeSubscription(
      {
        ...base,
        current_period_end: 1700000000,
        items: { data: [{ quantity: 7, price: { id: "price_dc" }, current_period_end: 1791367068 }] },
      } as RawStripeSubscriptionLike,
      resolvePlanId,
    );
    expect(snap.currentPeriodEndUnix).toBe(1791367068);
  });

  it("yields null, never undefined, when neither location carries a period", () => {
    const snap = snapshotFromStripeSubscription(
      { ...base, items: { data: [{ quantity: 7, price: { id: "price_dc" } }] } } as RawStripeSubscriptionLike,
      resolvePlanId,
    );
    expect(snap.currentPeriodEndUnix).toBeNull();
    // and must convert to a null date rather than an Invalid Date
    expect(toTenantSubscription(snap).currentPeriodEnd).toBeNull();
  });

  it("names a non-finite period instead of producing an Invalid Date", () => {
    expect(() =>
      toTenantSubscription({
        stripeSubscriptionId: "sub_bad",
        stripeCustomerId: "cus_bad",
        rawStatus: "active",
        planId: "direct_courier",
        seatCount: 1,
        currentPeriodEndUnix: Number.NaN,
        cancelAtPeriodEnd: false,
      }),
    ).toThrow(/Invalid currentPeriodEndUnix/);
  });
});
