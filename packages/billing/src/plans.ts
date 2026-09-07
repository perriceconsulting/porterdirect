/**
 * CANONICAL PLAN CATALOG — the Single Source of truth for PorterDirect pricing.
 *
 * Everything downstream derives from this: Stripe Prices mirror it (per-account, via
 * the env vars named in `stripePriceEnv`), the marketing pricing page renders from it,
 * and entitlement/seat math reads from it. Amounts here are authoritative; Stripe is a
 * mirror that must reconcile back (DOSI-S). Never hardcode a price anywhere else.
 *
 * Amounts are in USD cents to avoid floating-point money bugs.
 *
 * TAX: every amount here is a TAX-EXCLUSIVE list price. $199 is what the pricing page
 * shows and what the subscription line item charges; sales tax / VAT is added on top by
 * Stripe Tax at invoice time. We never compute tax ourselves — doing so would be both a
 * compliance liability and a second source of truth for money. The matching Stripe
 * Prices are created with `tax_behavior: "exclusive"` and their Products with tax code
 * `txcd_10103001` (SaaS - business use), since tenants are operator businesses.
 *
 * `tax_behavior` is IMMUTABLE on a Stripe Price once set, and Prices cannot be deleted
 * (only archived) — so changing this decision means re-creating every Price and
 * re-pointing the STRIPE_PRICE_* env vars. Treat it as settled, not a default.
 */

export type PlanId = "direct_courier" | "fleet_freight" | "white_label_agency";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly monthlyBasePriceCents: number;
  readonly includedSeats: number; // active drivers / power units included in the base price
  readonly extraSeatPriceCents: number; // per extra seat, per month
  readonly oneTimeSetupFeeCents: number; // 0 when the plan has no setup fee
  /**
   * Env var holding the Stripe Price id for `oneTimeSetupFeeCents`, or null when the
   * plan has no setup fee. Declared here for the same reason as `stripePriceEnv`:
   * an env var no catalog entry names is invisible to the reconciler, so it can be
   * blank or point at the wrong Price and nothing catches it.
   */
  readonly setupFeePriceEnv: string | null;
  readonly features: readonly string[];
  readonly stripePriceEnv: string; // env var holding this plan's Stripe Price id (mirror)
}

export const PLANS: readonly Plan[] = [
  {
    id: "direct_courier",
    name: "Direct Courier",
    monthlyBasePriceCents: 199_00,
    includedSeats: 5,
    extraSeatPriceCents: 25_00,
    oneTimeSetupFeeCents: 0,
    setupFeePriceEnv: null,
    features: [
      "CNAME custom domain mapping",
      "Custom-branded PWA tracking links",
      "Offline-first map caching",
      "Digital proof-of-delivery (signature + photo)",
    ],
    stripePriceEnv: "STRIPE_PRICE_DIRECT_COURIER",
  },
  {
    id: "fleet_freight",
    name: "Fleet & Freight",
    monthlyBasePriceCents: 499_00,
    includedSeats: 15,
    extraSeatPriceCents: 25_00,
    oneTimeSetupFeeCents: 0,
    setupFeePriceEnv: null,
    features: [
      "Everything in Direct Courier",
      "Automated Rate Con OCR parser",
      "Instant PDF invoice / factoring packet generation",
      "IFTA state fuel tracking",
      "Broker GPS share links",
    ],
    stripePriceEnv: "STRIPE_PRICE_FLEET_FREIGHT",
  },
  {
    id: "white_label_agency",
    name: "White-Label Agency",
    monthlyBasePriceCents: 999_00,
    includedSeats: 50,
    extraSeatPriceCents: 25_00,
    oneTimeSetupFeeCents: 1_500_00,
    setupFeePriceEnv: "STRIPE_PRICE_SETUP_FEE_AGENCY",
    features: [
      "Everything in Fleet & Freight",
      "Multi-tenant dispatch dashboard with sub-accounts",
      "White-labeled native app store deployment",
      "API / Webhook access",
      "100% platform anonymity",
    ],
    stripePriceEnv: "STRIPE_PRICE_WHITE_LABEL_AGENCY",
  },
];

/** Stripe tax code for every plan Product: SaaS sold for business use. */
export const SAAS_BUSINESS_TAX_CODE = "txcd_10103001";

/**
 * Tax behavior for every plan Price. Exclusive = the catalog amount is pre-tax and tax
 * is added at invoice time. IMMUTABLE on a Stripe Price once set (see the file header).
 */
export const PLAN_PRICE_TAX_BEHAVIOR = "exclusive" as const;

/**
 * Each plan's Stripe Price is a GRADUATED per-seat recurring Price built from this
 * catalog: a flat first tier of `monthlyBasePriceCents` up to `includedSeats`, then
 * `extraSeatPriceCents` per seat beyond it. The subscription's item quantity is the
 * total active seats — there is no separate "extra seat" Price to keep in sync.
 * `computeMonthlyTotalCents` mirrors exactly what this graduated Price charges.
 */

export type AddOnKind = "one_time" | "metered";

export interface AddOn {
  readonly id: string;
  readonly name: string;
  readonly kind: AddOnKind;
  readonly priceCents: number | null; // null for pass-through metered pricing
  readonly stripePriceEnv: string;
}

export const ADD_ONS: readonly AddOn[] = [
  {
    id: "app_store_deploy",
    name: "Native App Store Deployment",
    kind: "one_time",
    priceCents: 499_00,
    stripePriceEnv: "STRIPE_PRICE_APP_STORE_DEPLOY",
  },
  {
    id: "sms_notifications",
    name: "SMS / WhatsApp Notifications",
    kind: "metered", // pass-through + 20%; unit price set on the Stripe metered Price
    priceCents: null,
    stripePriceEnv: "STRIPE_PRICE_SMS_METERED",
  },
];

const PLAN_BY_ID: ReadonlyMap<string, Plan> = new Map(PLANS.map((p) => [p.id, p]));

/** Resolve a plan by catalog id. Throws on an unknown id — an unmapped plan is a bug. */
export function getPlan(id: string): Plan {
  const plan = PLAN_BY_ID.get(id);
  if (!plan) {
    throw new Error(`Unknown plan id: ${id}. Known plans: ${PLANS.map((p) => p.id).join(", ")}`);
  }
  return plan;
}

export function isKnownPlanId(id: string): id is PlanId {
  return PLAN_BY_ID.has(id);
}
