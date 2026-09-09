import { describe, expect, it } from "vitest";
import { ORDER_TYPES } from "@porterdirect/orders";
import {
  RateCardError,
  assertValidRateCard,
  quoteJob,
  type RateCard,
} from "../src/index.js";

/** A plausible small-courier card: $8 out the door, $2.50 a mile, $15 floor, 65% split. */
const card: RateCard = {
  rates: {
    fixed_pickup: { baseCents: 800, perMileCents: 250, minimumCents: 1500 },
    scheduled_courier: { baseCents: 1500, perMileCents: 300, minimumCents: 2500 },
  },
  driverPayPercent: 65,
  maxQuotableMeters: 80_467, // 50 miles
};

const MILE = 1_609.344;

describe("the rate card is exhaustive by construction", () => {
  it("carries a rate for every order type the domain allows", () => {
    // If an order type is added, this card stops compiling — which is the point. The
    // assertion is here so the guarantee is also visible at runtime.
    for (const type of ORDER_TYPES) {
      expect(card.rates[type], `no rate declared for "${type}"`).toBeDefined();
    }
    expect(Object.keys(card.rates).sort()).toEqual([...ORDER_TYPES].sort());
  });
});

describe("quoteJob", () => {
  it("charges base plus mileage", () => {
    // 10 miles at $2.50 = $25.00, plus the $8 base = $33.00.
    const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: Math.round(10 * MILE) });
    expect(q.kind).toBe("quoted");
    if (q.kind !== "quoted") return;
    expect(q.breakdown.baseCents).toBe(800);
    expect(q.breakdown.distanceCents).toBe(2500);
    expect(q.priceCents).toBe(3300);
  });

  it("uses the statute mile exactly, not an approximation", () => {
    // One mile is defined as exactly 1609.344 m. A rounded 1609 would come out a cent
    // short here, and that error grows with every mile of every job.
    //
    // The ceiling is lifted for this one case: 1000 miles is chosen to make a one-cent
    // error visible, and on the real card that distance correctly refuses to quote at
    // all. (Written first with the standard card, which refused — the guard working.)
    const q = quoteJob({
      card: { ...card, maxQuotableMeters: null },
      type: "fixed_pickup",
      distanceMeters: 1_609_344,
    });
    if (q.kind !== "quoted") throw new Error("expected a quote");
    expect(q.breakdown.distanceCents).toBe(250_000); // 1000 miles at $2.50
  });

  it("prices each order type from its own row", () => {
    const metres = Math.round(10 * MILE);
    const pickup = quoteJob({ card, type: "fixed_pickup", distanceMeters: metres });
    const scheduled = quoteJob({ card, type: "scheduled_courier", distanceMeters: metres });
    if (pickup.kind !== "quoted" || scheduled.kind !== "quoted") throw new Error("expected quotes");
    expect(scheduled.priceCents).toBeGreaterThan(pickup.priceCents);
    expect(scheduled.priceCents).toBe(1500 + 3000);
  });

  it("lifts a short job to the minimum and says that it did", () => {
    // Half a mile: 800 + 125 = 925, below the 1500 floor.
    const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: Math.round(0.5 * MILE) });
    if (q.kind !== "quoted") throw new Error("expected a quote");
    expect(q.priceCents).toBe(1500);
    expect(q.breakdown.minimumApplied).toBe(true);
    // The breakdown still reports what was actually computed, so an operator reading it
    // can see WHY the floor applied rather than seeing the floor twice.
    expect(q.breakdown.baseCents + q.breakdown.distanceCents).toBe(925);
  });

  it("does not report a minimum that was not needed", () => {
    const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: Math.round(10 * MILE) });
    if (q.kind !== "quoted") throw new Error("expected a quote");
    expect(q.breakdown.minimumApplied).toBe(false);
  });

  it("returns whole cents for every distance in a long sweep", () => {
    // Money as a float is the landmine; this asserts the arithmetic never produces one.
    for (let metres = 0; metres < 200_000; metres += 337) {
      const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: metres });
      if (q.kind !== "quoted") continue;
      expect(Number.isInteger(q.priceCents), `price at ${metres}m`).toBe(true);
      expect(Number.isInteger(q.driverPayCents), `pay at ${metres}m`).toBe(true);
    }
  });

  describe("driver pay", () => {
    it("is a percentage of the price the customer pays", () => {
      const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: Math.round(10 * MILE) });
      if (q.kind !== "quoted") throw new Error("expected a quote");
      expect(q.driverPayCents).toBe(Math.round(3300 * 0.65));
    });

    it("is always set on a quoted job, because an offer with no pay cannot be accepted", () => {
      // `claimOrder` refuses a job with no driver pay. A customer-booked job goes to the
      // offer board directly, so a quote that produced no pay would create work no driver
      // could take — invisible until a driver taps Accept and is refused.
      for (const type of ORDER_TYPES) {
        const q = quoteJob({ card, type, distanceMeters: 1000 });
        if (q.kind !== "quoted") throw new Error("expected a quote");
        expect(q.driverPayCents).toBeGreaterThan(0);
      }
    });

    it("never exceeds what the customer paid", () => {
      for (let metres = 0; metres < 80_000; metres += 911) {
        const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: metres });
        if (q.kind !== "quoted") continue;
        expect(q.driverPayCents).toBeLessThanOrEqual(q.priceCents);
      }
    });
  });

  describe("what it refuses to price, and hands to a person instead", () => {
    it("needs review when the operator has set no rate card", () => {
      const q = quoteJob({ card: null, type: "fixed_pickup", distanceMeters: 5000 });
      expect(q).toEqual({ kind: "needs_review", reason: "no_rate_card" });
    });

    it("needs review when nothing could measure the route", () => {
      // An unrecognised address or a geocoder outage. Deliberately NOT a straight-line
      // fallback: that is short by a predictable amount in exactly the dense cities where
      // the work is worth most, so it would quietly undercharge.
      const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: null });
      expect(q).toEqual({ kind: "needs_review", reason: "distance_unknown" });
    });

    it("needs review beyond the operator's quotable range", () => {
      const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: 80_468 });
      expect(q).toEqual({ kind: "needs_review", reason: "beyond_quotable_range" });
    });

    it("quotes right up to the ceiling", () => {
      const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: 80_467 });
      expect(q.kind).toBe("quoted");
    });

    it("quotes any distance when the operator sets no ceiling", () => {
      const q = quoteJob({
        card: { ...card, maxQuotableMeters: null },
        type: "fixed_pickup",
        distanceMeters: 4_000_000,
      });
      expect(q.kind).toBe("quoted");
    });
  });
});

describe("assertValidRateCard", () => {
  it("accepts a well-formed card", () => {
    expect(() => assertValidRateCard(card)).not.toThrow();
  });

  it("refuses fractional cents rather than rounding them", () => {
    const bad = { ...card, rates: { ...card.rates, fixed_pickup: { ...card.rates.fixed_pickup, perMileCents: 250.5 } } };
    expect(() => assertValidRateCard(bad)).toThrow(RateCardError);
  });

  it("refuses a negative rate", () => {
    const bad = { ...card, rates: { ...card.rates, fixed_pickup: { ...card.rates.fixed_pickup, baseCents: -1 } } };
    expect(() => assertValidRateCard(bad)).toThrow(RateCardError);
  });

  it("refuses a driver split above 100 percent", () => {
    // The plausible typo is 70 -> 700, and it would not surface until payroll.
    expect(() => assertValidRateCard({ ...card, driverPayPercent: 700 })).toThrow(/more than was charged/);
  });

  it("refuses a fractional percent", () => {
    expect(() => assertValidRateCard({ ...card, driverPayPercent: 62.5 })).toThrow(RateCardError);
  });

  it("names the offending field", () => {
    const bad = { ...card, rates: { ...card.rates, scheduled_courier: { ...card.rates.scheduled_courier, minimumCents: 1.5 } } };
    expect(() => assertValidRateCard(bad)).toThrow(/scheduled_courier\.minimumCents/);
  });

  it("refuses a zero or negative quotable ceiling", () => {
    expect(() => assertValidRateCard({ ...card, maxQuotableMeters: 0 })).toThrow(RateCardError);
  });
});

describe("quoteJob validates its distance", () => {
  it("refuses a fractional distance rather than silently rounding it", () => {
    expect(() => quoteJob({ card, type: "fixed_pickup", distanceMeters: 1000.4 })).toThrow(RateCardError);
  });

  it("refuses a negative distance", () => {
    expect(() => quoteJob({ card, type: "fixed_pickup", distanceMeters: -1 })).toThrow(RateCardError);
  });

  it("prices a zero-distance job at the minimum", () => {
    // Same building, different floor. Real, and it must not price at the base alone.
    const q = quoteJob({ card, type: "fixed_pickup", distanceMeters: 0 });
    if (q.kind !== "quoted") throw new Error("expected a quote");
    expect(q.priceCents).toBe(1500);
  });
});
