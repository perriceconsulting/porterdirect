/**
 * DB-backed implementations of the billing package's webhook ports.
 *
 * This is the wiring layer: it is the only place that knows both the billing domain
 * ports and the Drizzle schema, keeping @porterdirect/billing free of persistence and
 * @porterdirect/db free of billing semantics.
 */
import { eq } from "drizzle-orm";
import {
  createDbClient,
  processedWebhookEvents,
  subscriptions,
  tenants,
  type Db,
} from "@porterdirect/db";
import type {
  SubscriptionSink,
  TenantSubscription,
  WebhookEventStore,
} from "@porterdirect/billing";

/**
 * Idempotency ledger backed by `processed_webhook_events`.
 *
 * The claim is ONE statement: INSERT ... ON CONFLICT DO NOTHING RETURNING. Postgres
 * resolves the race in the primary key, so of two concurrent deliveries exactly one
 * gets a returned row and the other gets zero. Any implementation that SELECTs first
 * and INSERTs second reintroduces the bug this replaced — never "check then act".
 */
export class DbWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: Db) {}

  async claimEvent(event: { id: string; type: string }): Promise<boolean> {
    const claimed = await this.db
      .insert(processedWebhookEvents)
      .values({ eventId: event.id, eventType: event.type })
      .onConflictDoNothing({ target: processedWebhookEvents.eventId })
      .returning({ eventId: processedWebhookEvents.eventId });
    return claimed.length > 0;
  }

  async releaseEvent(eventId: string): Promise<void> {
    await this.db
      .delete(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, eventId));
  }
}

/** Raised when a subscription arrives for a Stripe customer we have no tenant for. */
export class UnknownTenantError extends Error {
  constructor(stripeCustomerId: string) {
    super(
      `No tenant is mapped to Stripe customer ${stripeCustomerId}. ` +
        `Refusing to persist a subscription that cannot be tenant-scoped.`,
    );
    this.name = "UnknownTenantError";
  }
}

/**
 * Subscription mirror backed by `subscriptions`.
 *
 * Every row is tenant-scoped, so the tenant must be resolvable from the Stripe customer
 * before anything is written. If it is not, we THROW rather than invent or null a
 * tenant_id: an unscoped subscription row is the tenant-bleed landmine, and a loud 500
 * that Stripe retries is far better than a quietly mis-attributed row.
 */
export class DbSubscriptionSink implements SubscriptionSink {
  constructor(private readonly db: Db) {}

  async upsert(subscription: TenantSubscription, stripeCustomerId: string): Promise<void> {
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.stripeCustomerId, stripeCustomerId))
      .limit(1);

    if (!tenant) throw new UnknownTenantError(stripeCustomerId);

    await this.db
      .insert(subscriptions)
      .values({
        tenantId: tenant.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        planId: subscription.planId,
        status: subscription.status,
        seatCount: subscription.seatCount,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ? 1 : 0,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          planId: subscription.planId,
          status: subscription.status,
          seatCount: subscription.seatCount,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ? 1 : 0,
          updatedAt: new Date(),
        },
      });
  }
}

export function createDbAdapters(connectionString: string | undefined): {
  db: Db;
  store: DbWebhookEventStore;
  sink: DbSubscriptionSink;
} {
  const db = createDbClient(connectionString);
  return { db, store: new DbWebhookEventStore(db), sink: new DbSubscriptionSink(db) };
}
