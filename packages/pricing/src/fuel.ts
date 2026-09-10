/**
 * The fuel surcharge: the part of a quote that tracks the market on its own.
 *
 * Pure, like the rest of pricing. The published pump price arrives as an ARGUMENT; what
 * fetches it is an adapter at the app layer. So the arithmetic that decides what a
 * customer pays is testable with no key, no network and no waiting for a weekly release.
 *
 * WHY A SEPARATE COMPONENT RATHER THAN A MOVING PER-MILE RATE.
 *
 * Both automate equally — neither needs a human — but only one is explainable. Folding
 * fuel into the base rate means two customers quoted an hour apart get different numbers
 * for the same run and the operator has nothing to point at. Indexed to a published
 * price and shown as its own line, the same movement is checkable by the person paying
 * it. This is how freight has done it for decades, and it is the reason customers accept
 * a price that moves.
 *
 * THE FORMULA is the standard one:
 *
 *     surcharge per mile = (pump price − baseline price) ÷ miles per gallon
 *
 * The BASELINE is the pump price the operator's base rate already assumes. At baseline
 * the surcharge is zero and the customer pays the agreed rate; the surcharge only ever
 * prices the DIFFERENCE. That is what stops it double-charging for fuel already covered.
 */

export type FuelBasis = "gasoline" | "diesel";

/**
 * What the operator's base rate assumes about fuel, and what their vehicles do with it.
 *
 * `milesPerGallonTenths` is an integer — 185 is 18.5 mpg. Same discipline as cents: a
 * fractional field here would put a float directly into a money calculation, and this
 * repo bans `parseFloat` outright for that reason.
 */
export type FuelSettings = {
  readonly basis: FuelBasis;
  readonly baselineCentsPerGallon: number;
  readonly milesPerGallonTenths: number;
};

/**
 * A published pump price.
 *
 * `asOf` is the date the PRICE is for, not the moment we fetched it. Those differ —
 * EIA publishes weekly — and conflating them is how a three-month-old number passes an
 * age check because it was fetched this morning.
 */
export type FuelPrice = {
  readonly basis: FuelBasis;
  readonly centsPerGallon: number;
  readonly asOf: Date;
  /** The published series this came from, so a quote can say what it was indexed to. */
  readonly region: string;
};

/**
 * How old a published price may be before it stops being usable.
 *
 * EIA publishes weekly, so a fortnight covers a missed release and a holiday without
 * quietly pricing this month's fuel at last quarter's rate. Past it the surcharge cannot
 * be computed at all — the quote becomes one an operator prices, rather than one that
 * silently undercharges. A stale number used confidently is worse than no number.
 */
export const FUEL_PRICE_MAX_AGE_DAYS = 14;

export class FuelSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FuelSettingsError";
  }
}

export function assertValidFuelSettings(settings: FuelSettings): void {
  if (!Number.isInteger(settings.baselineCentsPerGallon) || settings.baselineCentsPerGallon < 0) {
    throw new FuelSettingsError(
      `Baseline fuel price must be a whole number of cents per gallon, got ${settings.baselineCentsPerGallon}`,
    );
  }
  if (!Number.isInteger(settings.milesPerGallonTenths) || settings.milesPerGallonTenths <= 0) {
    // Zero would be a division by zero inside a price. It is also a plausible empty form
    // field, which is exactly why it is refused here rather than guarded at the call.
    throw new FuelSettingsError("Miles per gallon must be greater than zero.");
  }
}

export function isFuelPriceUsable(price: FuelPrice, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - price.asOf.getTime();
  if (!Number.isFinite(ageMs)) return false;
  // A price dated in the FUTURE is a clock or parsing problem, not a fresh price, and
  // trusting it would let a bad feed pin the surcharge indefinitely.
  if (ageMs < 0) return false;
  return ageMs <= FUEL_PRICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Exact: one mile is defined as exactly 1609.344 m, expressed in millimetres. */
const MILLIMETRES_PER_MILE = 1_609_344;

/**
 * The surcharge for one trip, in whole cents.
 *
 * FLOORED AT ZERO. When fuel is cheaper than the baseline the surcharge is nothing, not
 * a credit: the base rate is the price the operator agreed to charge, and a negative
 * surcharge would discount it below that without anyone deciding to. Standard practice
 * in published freight tables for the same reason.
 *
 * Integer arithmetic until one final division, so the result cannot drift by a cent
 * between two machines.
 */
export function fuelSurchargeCents(args: {
  readonly settings: FuelSettings;
  readonly price: FuelPrice;
  readonly distanceMeters: number;
}): number {
  assertValidFuelSettings(args.settings);

  if (args.price.basis !== args.settings.basis) {
    // Pricing a diesel truck off gasoline is wrong by a margin that varies week to week,
    // and it would look entirely plausible on the invoice.
    throw new FuelSettingsError(
      `Fuel price is ${args.price.basis} but this rate card is priced on ${args.settings.basis}.`,
    );
  }
  if (!Number.isInteger(args.distanceMeters) || args.distanceMeters < 0) {
    throw new FuelSettingsError(`Distance must be a non-negative whole number of metres.`);
  }

  const deltaCents = args.price.centsPerGallon - args.settings.baselineCentsPerGallon;
  if (deltaCents <= 0) return 0;

  // metres → miles → gallons → cents, as one integer expression:
  //   miles   = metres * 1000 / MILLIMETRES_PER_MILE
  //   gallons = miles * 10 / milesPerGallonTenths
  //   cents   = gallons * deltaCents
  const numerator = args.distanceMeters * 1000 * 10 * deltaCents;
  const denominator = MILLIMETRES_PER_MILE * args.settings.milesPerGallonTenths;
  return Math.round(numerator / denominator);
}

/**
 * The surcharge expressed per mile, for display.
 *
 * Operators and customers both talk in cents per mile, and a quote that only shows a
 * trip total gives neither of them anything to check the index against. Returned in
 * TENTHS of a cent because the real figure is routinely under a cent a mile and rounding
 * it to whole cents would show "0" for a surcharge that is genuinely being applied.
 */
export function fuelSurchargeTenthsPerMile(settings: FuelSettings, price: FuelPrice): number {
  assertValidFuelSettings(settings);
  const deltaCents = price.centsPerGallon - settings.baselineCentsPerGallon;
  if (deltaCents <= 0) return 0;
  return Math.round((deltaCents * 10 * 10) / settings.milesPerGallonTenths);
}
