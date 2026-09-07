/**
 * Stripe Price id → catalog plan id resolution.
 *
 * The catalog (plans.ts) is the Single Source; the Stripe Price ids live in env vars
 * whose NAMES the catalog itself declares (`stripePriceEnv`). This module is the
 * reconciler between the two: it never hardcodes an env var name or a plan id, it
 * derives both from the catalog, so adding a plan cannot silently skip its Price.
 *
 * Price ids are per-account and DO NOT transfer between Stripe accounts (CLAUDE.md).
 */
import { ADD_ONS, PLANS } from "./plans.js";

export type EnvLike = Record<string, string | undefined>;

/** Catalog-declared env var names for the plan Prices, in catalog order. */
export function planPriceEnvVarNames(): readonly string[] {
  return PLANS.map((p) => p.stripePriceEnv);
}

/**
 * EVERY Stripe Price env var the catalog declares: plan Prices, one-time setup-fee
 * Prices, and add-on Prices. This is the reconciler's view of the env contract — an
 * env var that appears in .env.example but not here is an orphan with no canonical
 * origin, and nothing would ever validate it (that is exactly how
 * STRIPE_PRICE_SETUP_FEE_AGENCY went unchecked). Keep the catalog the only source.
 */
export function allPriceEnvVarNames(): readonly string[] {
  return [
    ...PLANS.map((p) => p.stripePriceEnv),
    ...PLANS.map((p) => p.setupFeePriceEnv).filter((n): n is string => n !== null),
    ...ADD_ONS.map((a) => a.stripePriceEnv),
  ];
}

/** Env vars the catalog requires that are absent/blank — the pre-flight check. */
export function missingPlanPriceEnvVars(env: EnvLike): readonly string[] {
  return PLANS.filter((p) => !env[p.stripePriceEnv]?.trim()).map((p) => p.stripePriceEnv);
}

/**
 * Build the Price id → plan id map from env. Throws if one Price id is claimed by two
 * plans: that means the env mirrors the catalog wrongly, and would silently bill the
 * wrong tier. Absent vars are skipped (reported by `missingPlanPriceEnvVars`).
 */
export function buildPlanPriceMap(env: EnvLike): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plan of PLANS) {
    const priceId = env[plan.stripePriceEnv]?.trim();
    if (!priceId) continue;
    const claimed = map.get(priceId);
    if (claimed && claimed !== plan.id) {
      throw new Error(
        `Stripe Price ${priceId} is mapped to two plans (${claimed} and ${plan.id}). ` +
          `Check ${plan.stripePriceEnv} in .env.local — a shared Price id bills the wrong tier.`,
      );
    }
    map.set(priceId, plan.id);
  }
  return map;
}

/**
 * A `resolvePlanId` for the webhook dispatcher. Throws for a Price we don't know —
 * webhook.ts treats a throw as "not the plan line item" and keeps looking, so a
 * metered add-on Price correctly falls through instead of resolving to a plan.
 */
export function createPlanIdResolver(env: EnvLike): (priceId: string) => string {
  const map = buildPlanPriceMap(env);
  return (priceId: string): string => {
    const planId = map.get(priceId);
    if (!planId) {
      throw new Error(`No catalog plan is mapped to Stripe Price ${priceId}`);
    }
    return planId;
  };
}
