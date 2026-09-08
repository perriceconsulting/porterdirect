/**
 * Pure subscription-state logic and money math. No I/O, no Stripe SDK, no DB — every
 * function here is a deterministic data invariant that unit tests cover in milliseconds
 * (CLAUDE.md: an invariant belongs in a fast test, not a browser).
 */
import { getPlan, isKnownPlanId, type Plan, type PlanCapability } from "./plans.js";
import type { StripeSubscriptionSnapshot, SubscriptionStatus, TenantSubscription } from "./types.js";

/** Map Stripe's raw status string onto our normalized vocabulary. */
export function normalizeStatus(rawStatus: string): SubscriptionStatus {
  switch (rawStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "incomplete":
    case "paused":
      return rawStatus;
    case "incomplete_expired":
      return "canceled";
    default:
      throw new Error(`Unrecognized Stripe subscription status: ${rawStatus}`);
  }
}

/**
 * Entitlement policy: only active and trialing subscriptions may use the platform.
 * past_due/unpaid are intentionally NOT entitled — dunning gates access. Centralized
 * here so every surface derives entitlement from one rule (DOSI-S).
 */
export function isEntitled(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Does this PLAN include the capability? A commercial question, not an access decision.
 *
 * Use it to decide what the pricing page advertises or what an upgrade would unlock.
 * To decide whether a tenant may actually use something, use `tenantAllows` — a lapsed
 * Agency subscription still has `api_access` in its plan and must not still hold the key.
 */
export function planAllows(planId: string, capability: PlanCapability): boolean {
  return getPlan(planId).capabilities.includes(capability);
}

/**
 * May this tenant use the capability RIGHT NOW?
 *
 * Two conditions, and both are load-bearing: the plan must carry the capability, and the
 * subscription must be entitled. Checking only the plan leaves a cancelled tenant with
 * working API keys and OCR; checking only entitlement gives a $199 courier the freight
 * module. Entitlement is not re-derived here — `isEntitled` remains the one rule
 * (DOSI-S), this composes it.
 *
 * A tenant with no subscription row at all is allowed nothing.
 */
export function tenantAllows(
  subscription: Pick<TenantSubscription, "planId" | "status"> | null | undefined,
  capability: PlanCapability,
): boolean {
  if (!subscription) return false;
  if (!isEntitled(subscription.status)) return false;
  // An unknown plan id is a bug, but refusing is the safe direction for an access check.
  if (!isKnownPlanId(subscription.planId)) return false;
  return planAllows(subscription.planId, capability);
}

/** Convert a webhook snapshot into our canonical TenantSubscription, enforcing invariants. */
export function toTenantSubscription(snapshot: StripeSubscriptionSnapshot): TenantSubscription {
  // Validates the plan id against the catalog; throws on an unknown plan.
  getPlan(snapshot.planId);

  if (!Number.isInteger(snapshot.seatCount) || snapshot.seatCount < 0) {
    throw new Error(`Invalid seatCount: ${snapshot.seatCount} (must be a non-negative integer)`);
  }

  const periodEnd = snapshot.currentPeriodEndUnix;
  if (periodEnd !== null && !Number.isFinite(periodEnd)) {
    // Guards the class of bug where Stripe relocates a field between API versions:
    // reading the wrong place yields undefined, and `new Date(undefined * 1000)` is an
    // Invalid Date that only fails later, deep in the persistence layer.
    throw new Error(
      `Invalid currentPeriodEndUnix: ${String(periodEnd)} for subscription ` +
        `${snapshot.stripeSubscriptionId} (expected unix seconds or null)`,
    );
  }

  const status = normalizeStatus(snapshot.rawStatus);
  return {
    stripeSubscriptionId: snapshot.stripeSubscriptionId,
    planId: snapshot.planId,
    status,
    seatCount: snapshot.seatCount,
    currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    entitled: isEntitled(status),
  };
}

/** Seats billed on top of the plan's included allotment. Never negative. */
export function billableExtraSeats(plan: Plan, seatCount: number): number {
  return Math.max(0, seatCount - plan.includedSeats);
}

/**
 * Recurring monthly total in cents for a plan at a given seat count.
 *
 * PRE-TAX. This mirrors what the graduated Stripe Price charges as the line-item
 * subtotal; Stripe Tax adds sales tax / VAT on top at invoice time. A surface that
 * renders this next to a Stripe invoice TOTAL will legitimately show a smaller number —
 * that is the tax, not a bug. Never add tax here (see plans.ts header).
 * Invariant: total >= base price; extra seats are charged only above the included count.
 * (One-time setup fees are billed separately on the first invoice, not here.)
 */
export function computeMonthlyTotalCents(planId: string, seatCount: number): number {
  const plan = getPlan(planId);
  if (!Number.isInteger(seatCount) || seatCount < 0) {
    throw new Error(`Invalid seatCount: ${seatCount} (must be a non-negative integer)`);
  }
  return plan.monthlyBasePriceCents + billableExtraSeats(plan, seatCount) * plan.extraSeatPriceCents;
}
