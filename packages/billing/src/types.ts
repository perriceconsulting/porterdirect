/** Billing domain types (semantic intent: names mirror the billing domain, not Stripe's). */

/** Normalized subscription status — our vocabulary, mapped from Stripe's raw statuses. */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "paused";

/**
 * A normalized snapshot extracted from a Stripe Subscription at the webhook boundary.
 * Kept deliberately narrow so the pure state logic never touches the full Stripe type.
 */
export interface StripeSubscriptionSnapshot {
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly rawStatus: string; // Stripe's status string, normalized by our mapper
  readonly planId: string; // resolved from the subscription's Price → catalog
  readonly seatCount: number; // total active driver/power-unit seats
  readonly currentPeriodEndUnix: number | null; // seconds since epoch
  readonly cancelAtPeriodEnd: boolean;
}

/** Our canonical, persisted view of a tenant's subscription (mirror of Stripe). */
export interface TenantSubscription {
  readonly stripeSubscriptionId: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly seatCount: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  /** Derived: may the tenant currently use the platform? */
  readonly entitled: boolean;
}
