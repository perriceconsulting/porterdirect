import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { PLANS } from "../src/plans.js";
import {
  allPriceEnvVarNames,
  buildPlanPriceMap,
  createPlanIdResolver,
  missingPlanPriceEnvVars,
  planPriceEnvVarNames,
} from "../src/price-map.js";

/** A fully-populated env, derived from the catalog so a new plan can't be forgotten. */
function fullEnv(): Record<string, string> {
  return Object.fromEntries(PLANS.map((p, i) => [p.stripePriceEnv, `price_test_${i}`]));
}

describe("price-map", () => {
  it("declares one env var per catalog plan (derived, not hardcoded)", () => {
    expect(planPriceEnvVarNames()).toEqual(PLANS.map((p) => p.stripePriceEnv));
    expect(new Set(planPriceEnvVarNames()).size).toBe(PLANS.length);
  });

  it("reports every missing plan Price env var", () => {
    expect(missingPlanPriceEnvVars({})).toEqual(PLANS.map((p) => p.stripePriceEnv));
    expect(missingPlanPriceEnvVars(fullEnv())).toEqual([]);
  });

  it("treats a blank or whitespace-only value as missing", () => {
    const env = { ...fullEnv(), [PLANS[0]!.stripePriceEnv]: "   " };
    expect(missingPlanPriceEnvVars(env)).toEqual([PLANS[0]!.stripePriceEnv]);
  });

  it("maps each configured Price id to its catalog plan id", () => {
    const map = buildPlanPriceMap(fullEnv());
    expect(map.size).toBe(PLANS.length);
    PLANS.forEach((p, i) => expect(map.get(`price_test_${i}`)).toBe(p.id));
  });

  it("skips absent vars rather than mapping undefined", () => {
    const map = buildPlanPriceMap({ [PLANS[0]!.stripePriceEnv]: "price_only" });
    expect(map.size).toBe(1);
    expect(map.get("price_only")).toBe(PLANS[0]!.id);
  });

  it("throws when one Price id is claimed by two plans (would bill the wrong tier)", () => {
    const env = Object.fromEntries(PLANS.map((p) => [p.stripePriceEnv, "price_shared"]));
    expect(() => buildPlanPriceMap(env)).toThrow(/mapped to two plans/);
  });

  it("trims surrounding whitespace from a pasted Price id", () => {
    const map = buildPlanPriceMap({ [PLANS[0]!.stripePriceEnv]: "  price_padded  " });
    expect(map.get("price_padded")).toBe(PLANS[0]!.id);
  });

  it("resolver returns the plan id for a known Price", () => {
    const resolve = createPlanIdResolver(fullEnv());
    PLANS.forEach((p, i) => expect(resolve(`price_test_${i}`)).toBe(p.id));
  });

  it("resolver throws for an unknown Price so webhook.ts falls through to the next item", () => {
    const resolve = createPlanIdResolver(fullEnv());
    expect(() => resolve("price_metered_sms")).toThrow(/No catalog plan is mapped/);
  });
});

/**
 * Reconciler: the catalog and the env CONTRACT must describe the same set of Stripe
 * Prices. This is the check that would have caught STRIPE_PRICE_SETUP_FEE_AGENCY —
 * an env var present in .env.example that no catalog entry declared, so no code could
 * ever validate it. Reading the real file (not a fixture) is the point: a fixture
 * would drift from the contract silently, which is the very failure being prevented.
 */
describe("catalog <-> .env.example reconciliation", () => {
  const envExample = readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  const contractVars = [...envExample.matchAll(/^(STRIPE_PRICE_[A-Z0-9_]+)=/gm)]
    .map((m) => m[1]!)
    .sort();

  it("every Price env var in .env.example is declared by the catalog", () => {
    const declared = [...allPriceEnvVarNames()].sort();
    const orphans = contractVars.filter((v) => !declared.includes(v));
    expect(orphans, `orphaned in .env.example: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every Price env var the catalog declares exists in .env.example", () => {
    const declared = [...allPriceEnvVarNames()].sort();
    const undocumented = declared.filter((v) => !contractVars.includes(v));
    expect(undocumented, `missing from .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("declares a setup-fee Price env var for exactly the plans that charge one", () => {
    for (const plan of PLANS) {
      if (plan.oneTimeSetupFeeCents > 0) {
        expect(plan.setupFeePriceEnv, `${plan.id} charges a setup fee`).toBeTruthy();
      } else {
        expect(plan.setupFeePriceEnv, `${plan.id} charges no setup fee`).toBeNull();
      }
    }
  });

  it("uses no Price env var name twice across plans, setup fees and add-ons", () => {
    const all = allPriceEnvVarNames();
    expect(new Set(all).size).toBe(all.length);
  });
});
