/**
 * Turning a signup into a paying tenant.
 *
 * ORDERING IS LOAD-BEARING. The Stripe webhook resolves a subscription to a tenant by
 * `stripe_customer_id`, and `DbSubscriptionSink` refuses (loudly, with a 500 Stripe will
 * retry) when no tenant matches. So the tenant row and its Stripe customer id must both
 * exist BEFORE checkout is started — otherwise the first `customer.subscription.created`
 * arrives for a customer we have never heard of and retries until it gives up.
 *
 *   1. tenant row
 *   2. owner membership
 *   3. Stripe customer, id written back to the tenant
 *   4. checkout session
 *
 * The neon-http driver does not support multi-statement transactions (see
 * packages/db/src/client.ts), so steps 1–2 cannot be one atomic unit. Rather than
 * pretend otherwise, step 2 rolls step 1 back on failure: a tenant with no owner is
 * unreachable by anyone and would sit there forever holding its host.
 */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { createDbClient, tenantMembers, tenants, type Db } from "@porterdirect/db";
import { assignableTenantHost, type HostRejection } from "@porterdirect/auth";
import { isSupportedCountry } from "@porterdirect/contact";
import { createStripeClient, getPlan, type PlanId } from "@porterdirect/billing";

export type ProvisionFailure =
  | { readonly kind: "invalid-host"; readonly reason: HostRejection }
  | { readonly kind: "host-taken" }
  | { readonly kind: "invalid-name" }
  | { readonly kind: "unknown-plan" }
  | { readonly kind: "invalid-country" };

export type ProvisionResult =
  | { readonly ok: true; readonly tenantId: string; readonly stripeCustomerId: string }
  | { readonly ok: false; readonly failure: ProvisionFailure };

export interface ProvisionInput {
  readonly name: string;
  readonly host: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly planId: string;
  /**
   * ISO 3166-1 alpha-2. Decides how this operator's phone numbers are read and which
   * address labels their dispatchers see, so it is STATED at signup rather than left to
   * a column default that silently makes every tenant American.
   */
  readonly country: string;
}

function stripe(): Stripe {
  return createStripeClient(process.env.STRIPE_SECRET_KEY);
}

export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) {
    return { ok: false, failure: { kind: "invalid-name" } };
  }

  // Validated against the same rule that classifies incoming requests, so a tenant can
  // never register a host we would treat as one of our own surfaces.
  const assignment = assignableTenantHost(input.host);
  if (!assignment.ok) {
    return { ok: false, failure: { kind: "invalid-host", reason: assignment.reason } };
  }

  if (!isSupportedCountry(input.country)) {
    return { ok: false, failure: { kind: "invalid-country" } };
  }

  let planId: PlanId;
  try {
    planId = getPlan(input.planId).id;
  } catch {
    return { ok: false, failure: { kind: "unknown-plan" } };
  }

  const db: Db = createDbClient(process.env.DATABASE_URL);

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.primaryHost, assignment.host))
    .limit(1);
  if (existing) {
    return { ok: false, failure: { kind: "host-taken" } };
  }

  // 1. Tenant.
  const [tenant] = await db
    .insert(tenants)
    .values({ name, primaryHost: assignment.host, defaultCountry: input.country.toUpperCase() })
    .returning({ id: tenants.id });
  const tenantId = tenant!.id;

  // 2. Owner membership. Roll the tenant back if this fails — a tenant with no owner is
  //    unreachable and would hold its host indefinitely.
  try {
    await db.insert(tenantMembers).values({
      tenantId,
      userId: input.ownerUserId,
      role: "owner",
    });
  } catch (err) {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    throw err;
  }

  // 3. Stripe customer, written back before any checkout can start.
  const customer = await stripe().customers.create({
    name,
    email: input.ownerEmail,
    metadata: { tenantId, planId },
  });
  await db
    .update(tenants)
    .set({ stripeCustomerId: customer.id })
    .where(eq(tenants.id, tenantId));

  return { ok: true, tenantId, stripeCustomerId: customer.id };
}

/**
 * Is Stripe Tax calculation enabled for this account?
 *
 * Stripe refuses `automatic_tax` until the account has a head office address and tax
 * registrations, so this cannot simply be hardcoded on — a fresh account would fail
 * every checkout. It also must not quietly default on-forever-off: shipping with tax
 * calculation disabled means collecting no sales tax or VAT at all, which is a
 * compliance problem rather than a smaller feature.
 *
 * So: opt-in by env, and a HARD REFUSAL to run a live key without it. The one
 * configuration that must never happen is real customers being charged with no tax.
 */
function automaticTaxEnabled(secretKey: string): boolean {
  const enabled = (process.env.STRIPE_AUTOMATIC_TAX ?? "").toLowerCase() === "true";
  const isLive = /^(sk|rk)_live_/.test(secretKey);
  if (isLive && !enabled) {
    throw new Error(
      "REFUSING: STRIPE_AUTOMATIC_TAX is not enabled while running a LIVE key. " +
        "Configure Stripe Tax (head office address + registrations) and set " +
        "STRIPE_AUTOMATIC_TAX=true before charging real customers.",
    );
  }
  return enabled;
}

export interface CheckoutInput {
  readonly tenantId: string;
  readonly stripeCustomerId: string;
  readonly planId: string;
  readonly seats: number;
  readonly origin: string;
}

/**
 * Start a subscription checkout for a provisioned tenant.
 *
 * The Price id comes from the env var the CATALOGUE names, so the amount charged always
 * traces back to `plans.ts` rather than to a value typed here. Quantity is total active
 * seats — the graduated Price applies the included allotment itself, which is why there
 * is no separate "extra seat" line item to keep in sync.
 */
export async function createCheckoutSession(input: CheckoutInput): Promise<string> {
  const plan = getPlan(input.planId);
  const priceId = process.env[plan.stripePriceEnv];
  if (!priceId) {
    throw new Error(
      `${plan.stripePriceEnv} is not set; run "npm run stripe:prices -- --apply" first.`,
    );
  }
  if (!Number.isInteger(input.seats) || input.seats < 1) {
    throw new Error(`Seats must be a positive integer, received ${input.seats}`);
  }

  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const withTax = automaticTaxEnabled(secretKey);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: input.stripeCustomerId,
    line_items: [{ price: priceId, quantity: input.seats }],
    // Stripe Tax computes sales tax and VAT at invoice time; we never compute it.
    // Catalogue amounts are tax-exclusive (plans.ts), which is what makes this correct.
    automatic_tax: { enabled: withTax },
    // Only meaningful alongside automatic tax, and Stripe rejects it otherwise.
    ...(withTax ? { customer_update: { address: "auto" as const } } : {}),
    subscription_data: { metadata: { tenantId: input.tenantId, planId: plan.id } },
    success_url: `${input.origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/#pricing`,
  });

  if (!session.url) throw new Error("Stripe returned a checkout session with no URL");
  return session.url;
}
