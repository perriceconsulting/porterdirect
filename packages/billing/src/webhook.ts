/**
 * Stripe webhook handling: signature verification + idempotent dispatch.
 *
 * Two responsibilities kept separate for testability:
 *  - verifyStripeEvent: trusts nothing; verifies the signature (needs the real secret).
 *  - handleStripeEvent: pure dispatch over a *verified* event, idempotent via a store.
 *
 * Idempotency is mandatory: Stripe re-delivers events, and a retry without dedupe
 * double-applies (CLAUDE.md). The store records processed event ids exactly-once.
 */
import type Stripe from "stripe";
import { toTenantSubscription } from "./subscription-state.js";
import type { StripeSubscriptionSnapshot, TenantSubscription } from "./types.js";

/** The minimal structural shape we read off a Stripe Subscription object. */
export interface RawStripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number | null;
  items: { data: Array<{ quantity?: number | null; price: { id: string } }> };
}

/**
 * Idempotency ledger port (backed by processed_webhook_events at the wiring layer).
 *
 * The contract is a single ATOMIC CLAIM, deliberately not `hasProcessed` +
 * `markProcessed`. A check-then-act pair leaves a window in which two CONCURRENT
 * deliveries of the same event both pass the check and both apply — which is not
 * hypothetical: it was observed in live `stripe listen` traffic, where six events
 * were each handled twice. Sequential redelivery is caught by a read-then-write;
 * concurrent redelivery is not, and Stripe retrying over a slow first attempt (or two
 * app instances behind a load balancer) makes concurrency the normal case.
 */
export interface WebhookEventStore {
  /**
   * Atomically claim `event.id`. Returns true if THIS caller won the claim, false if
   * it was already claimed. MUST be one atomic operation — an INSERT relying on the
   * `processed_webhook_events.event_id` primary key, treating a unique violation as
   * `false`. Implementing it as a read followed by a write reintroduces the race.
   */
  claimEvent(event: { id: string; type: string }): Promise<boolean>;

  /**
   * Release a previously won claim so a later redelivery can retry. Called only when
   * applying the event failed AFTER the claim was won — otherwise the failed event
   * would be permanently marked processed and Stripe's retry silently skipped,
   * trading a double-apply for a lost update.
   */
  releaseEvent(eventId: string): Promise<void>;
}

/** Persistence port for the reconciled subscription (backed by the DB at wiring layer). */
export interface SubscriptionSink {
  upsert(subscription: TenantSubscription, stripeCustomerId: string): Promise<void>;
}

export interface WebhookDeps {
  readonly store: WebhookEventStore;
  readonly sink: SubscriptionSink;
  /** Map a Stripe Price id to a catalog plan id; throws for non-plan prices. */
  readonly resolvePlanId: (priceId: string) => string;
}

const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export function extractCustomerId(customer: string | { id: string }): string {
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * Extract our normalized snapshot from a Stripe Subscription. Assumes the plan is
 * carried on a graduated per-seat Price whose `quantity` is the total active seats
 * (included allotment is applied via Stripe price tiers, not a separate line item).
 */
export function snapshotFromStripeSubscription(
  sub: RawStripeSubscriptionLike,
  resolvePlanId: (priceId: string) => string,
): StripeSubscriptionSnapshot {
  const items = sub.items?.data ?? [];
  if (items.length === 0) {
    throw new Error(`Subscription ${sub.id} has no line items`);
  }

  let planId: string | null = null;
  let seatCount = 0;
  for (const item of items) {
    try {
      planId = resolvePlanId(item.price.id);
      seatCount = item.quantity ?? 0;
      break;
    } catch {
      // Not the plan Price (e.g. a metered add-on) — keep looking.
    }
  }
  if (planId === null) {
    throw new Error(`Subscription ${sub.id} has no line item matching a known plan Price`);
  }

  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: extractCustomerId(sub.customer),
    rawStatus: sub.status,
    planId,
    seatCount,
    currentPeriodEndUnix: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

export type HandleResult =
  | { status: "processed" }
  | { status: "skipped_duplicate" }
  | { status: "ignored"; reason: string };

/**
 * Idempotent dispatch for a verified Stripe event.
 *
 * Claim first, then apply. Claiming up front is what makes concurrent redelivery safe;
 * releasing on failure is what keeps a failed apply retryable.
 */
export async function handleStripeEvent(
  event: { id: string; type: string; data: { object: unknown } },
  deps: WebhookDeps,
): Promise<HandleResult> {
  const won = await deps.store.claimEvent(event);
  if (!won) {
    return { status: "skipped_duplicate" };
  }

  try {
    if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
      // The claim stands: an ignored event is fully handled, not deferred.
      return { status: "ignored", reason: `Unhandled event type: ${event.type}` };
    }

    const raw = event.data.object as RawStripeSubscriptionLike;
    const snapshot = snapshotFromStripeSubscription(raw, deps.resolvePlanId);
    const subscription = toTenantSubscription(snapshot);
    await deps.sink.upsert(subscription, snapshot.stripeCustomerId);
    return { status: "processed" };
  } catch (err) {
    // Hand the event back so Stripe's retry can re-process it. A failure to release
    // must not mask the real error — the caller needs the original to decide on a 500.
    try {
      await deps.store.releaseEvent(event.id);
    } catch {
      /* swallow: the original error below is the one worth surfacing */
    }
    throw err;
  }
}

/**
 * Verify a raw webhook payload's signature and return the trusted event.
 * Throws on a forged/mismatched signature — the caller must not process on throw.
 */
export function verifyStripeEvent(
  stripe: Stripe,
  rawBody: string | Buffer,
  signatureHeader: string,
  webhookSecret: string,
): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}
