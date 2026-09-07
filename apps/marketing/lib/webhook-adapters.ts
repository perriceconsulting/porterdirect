/**
 * Wiring-layer adapters for the billing package's ports.
 *
 * DELIBERATELY IN-MEMORY FOR NOW. The DB-backed implementations belong on
 * `processed_webhook_events` and `subscriptions` (packages/db/src/schema.ts), but
 * there is no DATABASE_URL yet — and the project's standing rule is that we do not
 * build an adapter we cannot assert against real infrastructure (the same reason the
 * Stripe-API price reconciler is still inert). This keeps the HTTP + signature +
 * dispatch path fully exercisable today, and swaps out when Neon is connected.
 *
 * LIMIT, stated plainly: idempotency here is per-process and dies on restart. It
 * proves the dispatch contract; it is NOT the durable exactly-once guarantee that
 * CLAUDE.md requires in production. Do not ship this to a deployed environment.
 */
import type {
  SubscriptionSink,
  TenantSubscription,
  WebhookEventStore,
} from "@porterdirect/billing";

export interface RecordedUpsert {
  readonly subscription: TenantSubscription;
  readonly stripeCustomerId: string;
  readonly at: Date;
}

/**
 * Per-process idempotency ledger. Mirrors the `processed_webhook_events` contract.
 *
 * `claimEvent` checks and inserts with NO await between them, so two concurrent
 * deliveries cannot both win — the in-process equivalent of the primary-key violation
 * the DB-backed store will rely on. Node runs this synchronously to completion; adding
 * an await inside the claim would reopen the exact race this replaced.
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly seen = new Map<string, { type: string; at: Date }>();

  async claimEvent(event: { id: string; type: string }): Promise<boolean> {
    if (this.seen.has(event.id)) return false;
    this.seen.set(event.id, { type: event.type, at: new Date() });
    return true;
  }

  async releaseEvent(eventId: string): Promise<void> {
    this.seen.delete(eventId);
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Per-process subscription sink. Mirrors the `subscriptions` upsert contract. */
export class InMemorySubscriptionSink implements SubscriptionSink {
  private readonly bySubscriptionId = new Map<string, RecordedUpsert>();

  async upsert(subscription: TenantSubscription, stripeCustomerId: string): Promise<void> {
    this.bySubscriptionId.set(subscription.stripeSubscriptionId, {
      subscription,
      stripeCustomerId,
      at: new Date(),
    });
  }

  get(stripeSubscriptionId: string): RecordedUpsert | undefined {
    return this.bySubscriptionId.get(stripeSubscriptionId);
  }

  all(): readonly RecordedUpsert[] {
    return [...this.bySubscriptionId.values()];
  }
}

/**
 * Module-level singletons: Next.js dev hot-reloads modules, so hang them off
 * globalThis or every edit silently empties the idempotency ledger.
 *
 * The keys carry a CONTRACT VERSION. Pinning an instance across reloads also pins it
 * across INTERFACE changes: after the store moved from hasProcessed/markProcessed to
 * the atomic claimEvent, the surviving old object produced
 * "deps.store.claimEvent is not a function" on every event — code that was correct,
 * failing against a stale instance. Bump this whenever a port's shape changes so the
 * old object cannot be resurrected; a mismatched key simply builds a fresh one.
 */
const ADAPTER_CONTRACT_VERSION = 2; // 2 = atomic claimEvent/releaseEvent

const globalForAdapters = globalThis as unknown as Record<string, unknown>;
const storeKey = `__pdWebhookStore_v${ADAPTER_CONTRACT_VERSION}`;
const sinkKey = `__pdSubscriptionSink_v${ADAPTER_CONTRACT_VERSION}`;

export const webhookEventStore: InMemoryWebhookEventStore =
  (globalForAdapters[storeKey] as InMemoryWebhookEventStore | undefined) ??
  new InMemoryWebhookEventStore();
export const subscriptionSink: InMemorySubscriptionSink =
  (globalForAdapters[sinkKey] as InMemorySubscriptionSink | undefined) ??
  new InMemorySubscriptionSink();

globalForAdapters[storeKey] = webhookEventStore;
globalForAdapters[sinkKey] = subscriptionSink;
