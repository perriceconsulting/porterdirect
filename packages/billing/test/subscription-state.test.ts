import { describe, it, expect } from "vitest";
import {
  normalizeStatus,
  isEntitled,
  toTenantSubscription,
  billableExtraSeats,
  computeMonthlyTotalCents,
} from "../src/subscription-state.js";
import { getPlan } from "../src/plans.js";
import type { StripeSubscriptionSnapshot } from "../src/types.js";

const snapshot = (over: Partial<StripeSubscriptionSnapshot> = {}): StripeSubscriptionSnapshot => ({
  stripeSubscriptionId: "sub_1",
  stripeCustomerId: "cus_1",
  rawStatus: "active",
  planId: "direct_courier",
  seatCount: 5,
  currentPeriodEndUnix: 1_700_000_000,
  cancelAtPeriodEnd: false,
  ...over,
});

describe("normalizeStatus", () => {
  it("passes through known statuses", () => {
    expect(normalizeStatus("active")).toBe("active");
    expect(normalizeStatus("trialing")).toBe("trialing");
    expect(normalizeStatus("past_due")).toBe("past_due");
  });

  it("maps incomplete_expired to canceled", () => {
    expect(normalizeStatus("incomplete_expired")).toBe("canceled");
  });

  it("throws on an unrecognized status", () => {
    expect(() => normalizeStatus("banana")).toThrow(/Unrecognized/);
  });
});

describe("isEntitled", () => {
  it("entitles only active and trialing", () => {
    expect(isEntitled("active")).toBe(true);
    expect(isEntitled("trialing")).toBe(true);
    expect(isEntitled("past_due")).toBe(false);
    expect(isEntitled("unpaid")).toBe(false);
    expect(isEntitled("canceled")).toBe(false);
  });
});

describe("toTenantSubscription", () => {
  it("maps a valid snapshot and derives entitlement + period end", () => {
    const sub = toTenantSubscription(snapshot({ rawStatus: "active", seatCount: 7 }));
    expect(sub.planId).toBe("direct_courier");
    expect(sub.status).toBe("active");
    expect(sub.entitled).toBe(true);
    expect(sub.seatCount).toBe(7);
    expect(sub.currentPeriodEnd).toEqual(new Date(1_700_000_000 * 1000));
  });

  it("treats a null current_period_end as null", () => {
    expect(toTenantSubscription(snapshot({ currentPeriodEndUnix: null })).currentPeriodEnd).toBeNull();
  });

  it("rejects an unknown plan id", () => {
    expect(() => toTenantSubscription(snapshot({ planId: "ghost" }))).toThrow(/Unknown plan id/);
  });

  it("rejects a negative or non-integer seat count", () => {
    expect(() => toTenantSubscription(snapshot({ seatCount: -1 }))).toThrow(/Invalid seatCount/);
    expect(() => toTenantSubscription(snapshot({ seatCount: 2.5 }))).toThrow(/Invalid seatCount/);
  });
});

describe("seat math (money invariants)", () => {
  it("bills no extra seats at or below the included allotment", () => {
    const plan = getPlan("direct_courier"); // 5 included
    expect(billableExtraSeats(plan, 3)).toBe(0);
    expect(billableExtraSeats(plan, 5)).toBe(0);
    expect(computeMonthlyTotalCents("direct_courier", 5)).toBe(199_00);
  });

  it("bills $25 per seat above the included allotment", () => {
    // 7 seats on Direct Courier = base + 2 extra
    expect(computeMonthlyTotalCents("direct_courier", 7)).toBe(199_00 + 2 * 25_00);
    // agency: 50 included, 52 seats = base + 2 extra
    expect(computeMonthlyTotalCents("white_label_agency", 52)).toBe(999_00 + 2 * 25_00);
  });

  it("invariant: total is never below the base price", () => {
    for (const seats of [0, 1, 5, 15, 50, 200]) {
      for (const id of ["direct_courier", "fleet_freight", "white_label_agency"]) {
        expect(computeMonthlyTotalCents(id, seats)).toBeGreaterThanOrEqual(getPlan(id).monthlyBasePriceCents);
      }
    }
  });

  it("rejects a negative seat count", () => {
    expect(() => computeMonthlyTotalCents("direct_courier", -3)).toThrow(/Invalid seatCount/);
  });
});
