import { describe, it, expect } from "vitest";
import { PLANS } from "../src/plans.js";
import { formatUsdCents, parseUsdToCents } from "../src/format.js";

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

describe("parseUsdToCents", () => {
  it.each([
    ["49.50", 4950],
    ["199", 19900],
    ["$1,500.00", 150000],
    ["1,234,567.89", 123456789],
    ["0", 0],
    ["0.05", 5],
    ["0.5", 50],
    ["  12.34  ", 1234],
  ])("parses %j as %i cents", (input, expected) => {
    expect(parseUsdToCents(input)).toBe(expected);
  });

  it("round-trips against the formatter", () => {
    for (const cents of [0, 5, 50, 4950, 19900, 150000]) {
      expect(parseUsdToCents(formatUsdCents(cents))).toBe(cents);
    }
  });

  it.each([
    "",
    "abc",
    "1.234",
    "-5",
    "1.2.3",
    "1e3",
    // European decimal notation. Stripping the comma as a thousands separator would
    // read this as $1,234 — a hundredfold error on an invoice. Refuse it instead.
    "12,34",
    "1,23",
    "1,2345",
    // Commas outside thousands positions are equally ambiguous.
    "1,00,000",
    "12,3456",
  ])(
    "returns null for malformed input %j",
    (input) => {
      // Null rather than a guess: a malformed price must be a visible error, never a
      // silent zero on an invoice.
      expect(parseUsdToCents(input)).toBeNull();
    },
  );

  it("never routes through a float", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754; rounding hides it, string parsing
    // avoids it entirely.
    expect(parseUsdToCents("19.99")).toBe(1999);
    expect(parseUsdToCents("0.29")).toBe(29);
    expect(parseUsdToCents("1.005")).toBeNull();
  });
});
