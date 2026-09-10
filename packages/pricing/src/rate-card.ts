/**
 * The operator's rate card, and the quote derived from it.
 *
 * Pure: no database, no environment, no network. The distance is an ARGUMENT, because
 * the thing that measures a road is a paid third-party service and the arithmetic that
 * turns miles into money is ours. Fusing them would mean the price rules could only be
 * tested with a live API key, which is the shape this repo has already been bitten by
 * (the HIBP breach check inside a test path).
 */
import type { OrderType } from "@porterdirect/orders";
import {
  fuelSurchargeCents,
  isFuelPriceUsable,
  type FuelPrice,
  type FuelSettings,
} from "./fuel.js";

/**
 * What one order type costs. Written per type rather than one rate for everything,
 * because a scheduled exact-window run and an on-demand pickup are different products
 * and every operator prices them differently.
 */
export type TypeRate = {
  /** Charged on every job of this type, before a single mile. */
  readonly baseCents: number;
  readonly perMileCents: number;
  /** The floor. A two-block delivery still costs the operator a driver and a van. */
  readonly minimumCents: number;
};

export type RateCard = {
  /**
   * `Record<OrderType, …>` on purpose: the compiler forces an entry for every type, so
   * adding an order type cannot leave a rate card that silently prices nothing. This is
   * the same derivation that makes ORDER_TYPES exhaustive.
   */
  readonly rates: Record<OrderType, TypeRate>;
  /**
   * The driver's cut, as a whole percent of the customer price.
   *
   * This is not decoration. `claimOrder` REFUSES a job with no driver pay — a job on the
   * offer board with no amount is one a driver cannot make a decision about — so a
   * customer-booked job that goes straight to the pool must arrive with pay already set.
   * A percentage rather than a second base+mileage table because the operator's margin
   * is one decision, and two independent formulas can silently invert (a short job
   * paying the driver more than the customer paid).
   */
  readonly driverPayPercent: number;
  /**
   * Beyond this, the portal stops quoting and asks the operator.
   *
   * Null means no ceiling. A ceiling exists because an automatic quote is a PRICE THE
   * OPERATOR IS BOUND TO: without one, a customer types an address four states away and
   * the portal cheerfully sells a job nobody can run. Refusing to auto-quote is not
   * refusing the work — it becomes a job the operator prices by hand.
   */
  readonly maxQuotableMeters: number | null;
  /**
   * What the base rate assumes about fuel, and what the fleet does with it.
   *
   * Null means this operator does not run a fuel surcharge — their per-mile rate is
   * simply their per-mile rate. Absence is a real choice, not a missing value, and it
   * must not be confused with a baseline of zero (which would surcharge the FULL pump
   * price on every mile).
   */
  readonly fuel: FuelSettings | null;
};

export type QuoteBreakdown = {
  readonly baseCents: number;
  readonly distanceCents: number;
  /**
   * The fuel component, shown separately so a price that moves on its own can be
   * explained to the person paying it. Zero when the operator runs no surcharge, or when
   * fuel is at or below the baseline their base rate already assumes.
   */
  readonly fuelCents: number;
  /** What the surcharge was indexed to, so the number can be checked rather than trusted. */
  readonly fuelIndexedTo: { readonly region: string; readonly centsPerGallon: number; readonly asOf: Date } | null;
  /** True when the floor lifted the price above base + distance + fuel. */
  readonly minimumApplied: boolean;
};

/** Why a job could not be priced automatically. A closed set, so it can be counted. */
export type QuoteRefusal =
  | "no_rate_card"
  | "distance_unknown"
  | "beyond_quotable_range"
  /**
   * The operator runs a fuel surcharge and no current published price could be had.
   *
   * Deliberately a REFUSAL rather than quoting without the surcharge. Silently dropping
   * it would undercharge by exactly the amount fuel has moved — largest precisely when
   * the market is moving fastest, which is when it matters most and when nobody is
   * checking. The job goes to a person instead.
   */
  | "fuel_price_unavailable";

export type Quote =
  | {
      readonly kind: "quoted";
      readonly priceCents: number;
      readonly driverPayCents: number;
      readonly distanceMeters: number;
      readonly breakdown: QuoteBreakdown;
    }
  /**
   * Not an error. The job is still bookable — it lands on the board unpriced and the
   * operator sets the number, which is exactly the quote-request flow. A surface that
   * treated this as a failure would refuse work over a geocoder outage.
   */
  | { readonly kind: "needs_review"; readonly reason: QuoteRefusal };

export class RateCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateCardError";
  }
}

/**
 * Exact, because 1 mile is defined as exactly 1609.344 m. Expressed as an integer of
 * millimetres so the arithmetic below never leaves integers until the final division.
 */
const MILLIMETRES_PER_MILE = 1_609_344;

function assertWholeCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    // Same posture as `formatUsdCents`: a fractional amount here means a float leaked in
    // upstream, and quietly rounding it would hide that at the moment it becomes a wrong
    // price on a customer's screen.
    throw new RateCardError(`${field} must be a whole number of cents, got ${value}`);
  }
}

/** Validate a card once, at the boundary, rather than trusting every read of it. */
export function assertValidRateCard(card: RateCard): void {
  for (const [type, rate] of Object.entries(card.rates)) {
    assertWholeCents(rate.baseCents, `${type}.baseCents`);
    assertWholeCents(rate.perMileCents, `${type}.perMileCents`);
    assertWholeCents(rate.minimumCents, `${type}.minimumCents`);
  }
  if (!Number.isInteger(card.driverPayPercent) || card.driverPayPercent < 0) {
    throw new RateCardError(`driverPayPercent must be a whole percent, got ${card.driverPayPercent}`);
  }
  if (card.driverPayPercent > 100) {
    // Paying the driver more than the customer paid is a loss on every job. It is a
    // plausible typo (70 -> 700), and it would not surface until payroll.
    throw new RateCardError(`driverPayPercent above 100 would pay out more than was charged`);
  }
  if (card.maxQuotableMeters !== null) {
    if (!Number.isInteger(card.maxQuotableMeters) || card.maxQuotableMeters <= 0) {
      throw new RateCardError(`maxQuotableMeters must be a positive whole number of metres`);
    }
  }
}

/**
 * The mileage charge, in whole cents.
 *
 * Integer arithmetic until one final division, so the result is deterministic and cannot
 * drift by a cent between two machines. `metres * perMileCents * 1000` stays far inside
 * Number.MAX_SAFE_INTEGER even for a transcontinental run (~4e6 m => ~2e13).
 */
function distanceCharge(metres: number, perMileCents: number): number {
  return Math.round((metres * 1000 * perMileCents) / MILLIMETRES_PER_MILE);
}

/**
 * Price a job.
 *
 * `distanceMeters` is null when nothing could measure the route — an unrecognised
 * address, a geocoder outage, a routing API refusing. That is a NEEDS_REVIEW, never a
 * guess: straight-line distance is systematically short exactly where the money is
 * (dense cities, rivers, one-way systems), so falling back to it would quietly undercharge
 * on the operator's most valuable work.
 */
export function quoteJob(args: {
  readonly card: RateCard | null;
  readonly type: OrderType;
  readonly distanceMeters: number | null;
  /**
   * The current published pump price. Required only when the card runs a surcharge —
   * an operator with `fuel: null` quotes exactly as before, with no feed involved.
   */
  readonly fuelPrice?: FuelPrice | null;
  /** Injected so staleness is testable without waiting a fortnight. */
  readonly now?: Date;
}): Quote {
  if (!args.card) return { kind: "needs_review", reason: "no_rate_card" };
  if (args.distanceMeters === null) return { kind: "needs_review", reason: "distance_unknown" };

  assertValidRateCard(args.card);

  const metres = args.distanceMeters;
  if (!Number.isInteger(metres) || metres < 0) {
    throw new RateCardError(`distanceMeters must be a non-negative whole number, got ${metres}`);
  }
  if (args.card.maxQuotableMeters !== null && metres > args.card.maxQuotableMeters) {
    return { kind: "needs_review", reason: "beyond_quotable_range" };
  }

  // Fuel, before the minimum is considered: the floor is a floor on the whole price,
  // and applying it before the surcharge would let a short expensive-fuel run come out
  // under the minimum the operator set.
  let fuelCents = 0;
  let fuelIndexedTo: QuoteBreakdown["fuelIndexedTo"] = null;
  if (args.card.fuel) {
    const price = args.fuelPrice ?? null;
    // Usable means current AND for the right fuel. A diesel fleet priced off gasoline is
    // wrong by a margin that varies week to week and looks entirely plausible.
    if (!price || price.basis !== args.card.fuel.basis || !isFuelPriceUsable(price, args.now)) {
      return { kind: "needs_review", reason: "fuel_price_unavailable" };
    }
    fuelCents = fuelSurchargeCents({ settings: args.card.fuel, price, distanceMeters: metres });
    fuelIndexedTo = { region: price.region, centsPerGallon: price.centsPerGallon, asOf: price.asOf };
  }

  const rate = args.card.rates[args.type];
  const baseCents = rate.baseCents;
  const distanceCents = distanceCharge(metres, rate.perMileCents);
  const subtotal = baseCents + distanceCents + fuelCents;
  const minimumApplied = subtotal < rate.minimumCents;
  const priceCents = minimumApplied ? rate.minimumCents : subtotal;

  // Rounded, not floored: a floor makes the operator's split quietly worse than the
  // percentage they set, on every single job.
  const driverPayCents = Math.round((priceCents * args.card.driverPayPercent) / 100);

  return {
    kind: "quoted",
    priceCents,
    driverPayCents,
    distanceMeters: metres,
    breakdown: { baseCents, distanceCents, fuelCents, fuelIndexedTo, minimumApplied },
  };
}
