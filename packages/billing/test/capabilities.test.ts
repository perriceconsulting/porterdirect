import { describe, expect, it } from "vitest";
import {
  PLANS,
  getPlan,
  planAllows,
  tenantAllows,
  type PlanCapability,
  type PlanId,
} from "../src/index.js";
import type { SubscriptionStatus } from "../src/types.js";

const sub = (planId: string, status: SubscriptionStatus) => ({ planId, status });

describe("plan capabilities", () => {
  it("gives the freight module to freight tiers only", () => {
    // The commercial shape of the product: Rate Con OCR and IFTA are what the $499 tier
    // is FOR. A courier tenant reaching them means the price list means nothing.
    expect(planAllows("direct_courier", "rate_con_ocr")).toBe(false);
    expect(planAllows("direct_courier", "ifta_tracking")).toBe(false);
    expect(planAllows("fleet_freight", "rate_con_ocr")).toBe(true);
    expect(planAllows("fleet_freight", "ifta_tracking")).toBe(true);
  });

  it("keeps agency-only capabilities out of the lower tiers", () => {
    for (const capability of ["api_access", "sub_accounts", "platform_anonymity"] as const) {
      expect(planAllows("direct_courier", capability)).toBe(false);
      expect(planAllows("fleet_freight", capability)).toBe(false);
      expect(planAllows("white_label_agency", capability)).toBe(true);
    }
  });

  it("gives every tier the things every tier is sold on", () => {
    // Custom domain and POD are the whole pitch — a tier without them is not the product.
    for (const plan of PLANS) {
      expect(planAllows(plan.id, "custom_domain")).toBe(true);
      expect(planAllows(plan.id, "proof_of_delivery")).toBe(true);
    }
  });

  it("is monotonic by price: a dearer tier never has fewer capabilities", () => {
    // Asserted as a PROPERTY rather than by reading the three lists. They are written out
    // per tier on purpose (no inheritance), so nothing structural stops someone dropping
    // a capability from the top tier while editing — this is what would catch it.
    const byPrice = [...PLANS].sort((a, b) => a.monthlyBasePriceCents - b.monthlyBasePriceCents);
    for (let i = 1; i < byPrice.length; i++) {
      const cheaper = new Set<PlanCapability>(byPrice[i - 1]!.capabilities);
      const dearer = new Set<PlanCapability>(byPrice[i]!.capabilities);
      for (const capability of cheaper) {
        expect(
          dearer.has(capability),
          `${byPrice[i]!.id} costs more than ${byPrice[i - 1]!.id} but lacks ${capability}`,
        ).toBe(true);
      }
    }
  });

  it("never lets a marketing bullet double as a capability", () => {
    // The reason the two fields exist separately: copy gets reworded, permissions must not
    // move when it does. Nothing should be readable as both.
    for (const plan of PLANS) {
      for (const feature of plan.features) {
        expect(plan.capabilities as readonly string[]).not.toContain(feature);
      }
    }
  });
});

describe("tenantAllows", () => {
  it("refuses a capability the plan does not carry, even when paid up", () => {
    expect(tenantAllows(sub("direct_courier", "active"), "rate_con_ocr")).toBe(false);
  });

  it("refuses a capability the plan DOES carry once the subscription lapses", () => {
    // The failure this function exists to prevent. A cancelled Agency tenant still has
    // "api_access" in its plan; checking the plan alone leaves their API key working.
    expect(planAllows("white_label_agency", "api_access")).toBe(true);
    for (const status of ["canceled", "unpaid", "past_due", "paused", "incomplete"] as const) {
      expect(tenantAllows(sub("white_label_agency", status), "api_access")).toBe(false);
    }
  });

  it("allows it while active or trialing", () => {
    for (const status of ["active", "trialing"] as const) {
      expect(tenantAllows(sub("white_label_agency", status), "api_access")).toBe(true);
    }
  });

  it("allows nothing to a tenant with no subscription at all", () => {
    for (const capability of ["custom_domain", "api_access"] as const) {
      expect(tenantAllows(null, capability)).toBe(false);
      expect(tenantAllows(undefined, capability)).toBe(false);
    }
  });

  it("refuses rather than throws on an unknown plan id", () => {
    // An unknown plan is a bug, but an access check is the wrong place to crash: refusing
    // fails closed, throwing turns a data problem into an outage.
    expect(() => tenantAllows(sub("legacy_tier", "active"), "custom_domain")).not.toThrow();
    expect(tenantAllows(sub("legacy_tier", "active"), "custom_domain")).toBe(false);
  });

  it("does not re-derive entitlement — it agrees with isEntitled for every status", async () => {
    const { isEntitled } = await import("../src/subscription-state.js");
    const statuses: SubscriptionStatus[] = [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "canceled",
      "incomplete",
      "paused",
    ];
    for (const status of statuses) {
      expect(tenantAllows(sub("white_label_agency", status), "api_access")).toBe(
        isEntitled(status),
      );
    }
  });
});

describe("catalogue integrity", () => {
  it("declares capabilities for every plan", () => {
    for (const plan of PLANS) {
      expect(plan.capabilities.length, `${plan.id} has no capabilities`).toBeGreaterThan(0);
    }
  });

  it("lists no capability twice within a plan", () => {
    for (const plan of PLANS) {
      expect(new Set(plan.capabilities).size).toBe(plan.capabilities.length);
    }
  });

  it("resolves through getPlan for every known id", () => {
    const ids: PlanId[] = ["direct_courier", "fleet_freight", "white_label_agency"];
    for (const id of ids) {
      expect(getPlan(id).capabilities.length).toBeGreaterThan(0);
    }
  });
});
