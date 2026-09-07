import { describe, it, expect } from "vitest";
import { PLANS, ADD_ONS, getPlan, isKnownPlanId } from "../src/plans.js";

describe("plan catalog (Single Source)", () => {
  it("defines the three canonical tiers", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["direct_courier", "fleet_freight", "white_label_agency"]);
  });

  it("prices match the published tiers (in cents)", () => {
    expect(getPlan("direct_courier").monthlyBasePriceCents).toBe(199_00);
    expect(getPlan("fleet_freight").monthlyBasePriceCents).toBe(499_00);
    expect(getPlan("white_label_agency").monthlyBasePriceCents).toBe(999_00);
  });

  it("charges a one-time setup fee only on the agency tier", () => {
    expect(getPlan("direct_courier").oneTimeSetupFeeCents).toBe(0);
    expect(getPlan("fleet_freight").oneTimeSetupFeeCents).toBe(0);
    expect(getPlan("white_label_agency").oneTimeSetupFeeCents).toBe(1_500_00);
  });

  it("prices the extra seat at $25/mo across every tier", () => {
    for (const plan of PLANS) {
      expect(plan.extraSeatPriceCents).toBe(25_00);
    }
  });

  it("has positive base prices, non-negative included seats, and non-empty features", () => {
    for (const plan of PLANS) {
      expect(plan.monthlyBasePriceCents).toBeGreaterThan(0);
      expect(plan.includedSeats).toBeGreaterThanOrEqual(0);
      expect(plan.features.length).toBeGreaterThan(0);
      expect(plan.stripePriceEnv).toMatch(/^STRIPE_PRICE_/);
    }
  });

  it("uses unique plan ids and unique Stripe price env names", () => {
    const ids = PLANS.map((p) => p.id);
    const envs = PLANS.map((p) => p.stripePriceEnv);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("resolves known plans and rejects unknown ones", () => {
    expect(isKnownPlanId("direct_courier")).toBe(true);
    expect(isKnownPlanId("nope")).toBe(false);
    expect(() => getPlan("nope")).toThrow(/Unknown plan id/);
  });

  it("defines the add-on catalog", () => {
    const byId = new Map(ADD_ONS.map((a) => [a.id, a]));
    expect(byId.get("app_store_deploy")?.priceCents).toBe(499_00);
    expect(byId.get("sms_notifications")?.kind).toBe("metered");
  });
});
