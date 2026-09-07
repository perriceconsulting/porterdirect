import { describe, it, expect } from "vitest";
import { PLANS } from "../src/plans.js";
import { formatUsdCents } from "../src/format.js";

describe("formatUsdCents", () => {
  it.each([
    [0, "$0"],
    [19900, "$199"],
    [49900, "$499"],
    [99900, "$999"],
    [150000, "$1,500"],
    [2500, "$25"],
    [1, "$0.01"],
    [1999, "$19.99"],
    [100000000, "$1,000,000"],
    [-2500, "-$25"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatUsdCents(cents)).toBe(expected);
  });

  it("refuses a non-integer amount rather than rounding it silently", () => {
    // Money is integer cents. A fractional amount here means a float leaked in upstream,
    // and rounding it would hide that at the exact moment it becomes a wrong price.
    expect(() => formatUsdCents(19.99)).toThrow(/integer cents/);
  });

  it("renders every catalog price without a trailing .00", () => {
    for (const plan of PLANS) {
      expect(formatUsdCents(plan.monthlyBasePriceCents)).not.toContain(".");
      expect(formatUsdCents(plan.extraSeatPriceCents)).not.toContain(".");
    }
  });
});
