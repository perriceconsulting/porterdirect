/**
 * Rate card persistence.
 *
 * The arithmetic lives in `@porterdirect/pricing` and never comes near this file. What
 * happens here is loading the operator's inputs and saving them back, tenant-scoped in
 * the WHERE clause like everything else that is owned.
 */
import { and, eq } from "drizzle-orm";
import {
  tenantRateCardRates,
  tenantRateCards,
  type Db,
} from "@porterdirect/db";
import { ORDER_TYPES, type OrderType } from "@porterdirect/orders";
import {
  assertValidRateCard,
  assertValidFuelSettings,
  type FuelSettings,
  type RateCard,
  type TypeRate,
} from "@porterdirect/pricing";

export class RateCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateCardValidationError";
  }
}

/**
 * This operator's rate card, or null if they have not set one.
 *
 * Null is a legitimate answer that `quoteJob` already handles by returning
 * `needs_review`, so a tenant who has never opened the pricing screen simply gets jobs
 * an operator prices by hand.
 *
 * INCOMPLETE COUNTS AS ABSENT, and that is the load-bearing part. `RateCard.rates` is a
 * `Record<OrderType, TypeRate>`, which TypeScript is happy to believe about an object
 * that is missing a key — the same "a typed list can be INCOMPLETE and still compile"
 * trap that let a validator silently refuse a legitimate order type. Here the
 * consequence is worse than a refusal: `card.rates[type]` would be `undefined`, and
 * reading `.baseCents` off it throws inside a quote, or — if a later change added a
 * fallback — prices a job at zero. So a card missing any type's row is reported as no
 * card at all, which routes the job to a person instead.
 *
 * This is not hypothetical. It is exactly what a half-finished save leaves behind (see
 * `saveRateCard`, which cannot be transactional), and what adding a new order type does
 * to every card that already exists.
 */
export async function loadRateCard(db: Db, tenantId: string): Promise<RateCard | null> {
  const [card] = await db
    .select()
    .from(tenantRateCards)
    .where(eq(tenantRateCards.tenantId, tenantId))
    .limit(1);
  if (!card) return null;

  const rows = await db
    .select()
    .from(tenantRateCardRates)
    .where(eq(tenantRateCardRates.rateCardId, card.id));

  const rates: Partial<Record<OrderType, TypeRate>> = {};
  for (const row of rows) {
    rates[row.type] = {
      baseCents: row.baseCents,
      perMileCents: row.perMileCents,
      minimumCents: row.minimumCents,
    };
  }
  for (const type of ORDER_TYPES) {
    if (!rates[type]) return null;
  }

  return {
    rates: rates as Record<OrderType, TypeRate>,
    driverPayPercent: card.driverPayPercent,
    maxQuotableMeters: card.maxQuotableMeters,
    fuel: readFuelSettings(card),
  };
}

/**
 * The fuel settings, or null when this operator runs no surcharge.
 *
 * ALL THREE columns must be present. A partially-filled set is treated as no surcharge
 * rather than being patched with defaults, because every default available here is
 * wrong in a way that shows up as money: a baseline of zero surcharges the entire pump
 * price on top of a per-mile rate that already covers fuel, and a guessed mpg misprices
 * every mile. Null is the only safe reading of an incomplete set.
 */
function readFuelSettings(card: {
  fuelBasis: "gasoline" | "diesel" | null;
  fuelBaselineCentsPerGallon: number | null;
  milesPerGallonTenths: number | null;
}): FuelSettings | null {
  if (
    card.fuelBasis === null ||
    card.fuelBaselineCentsPerGallon === null ||
    card.milesPerGallonTenths === null
  ) {
    return null;
  }
  return {
    basis: card.fuelBasis,
    baselineCentsPerGallon: card.fuelBaselineCentsPerGallon,
    milesPerGallonTenths: card.milesPerGallonTenths,
  };
}

/**
 * Whether this operator can quote automatically at all.
 *
 * Separate from loading the card because the console asks a different question than the
 * quoting path does — "is pricing set up" is a setup-checklist item, and answering it by
 * loading the whole card and comparing it to null reads as though the card were wanted.
 */
export async function hasRateCard(db: Db, tenantId: string): Promise<boolean> {
  return (await loadRateCard(db, tenantId)) !== null;
}

/**
 * Write the operator's rate card.
 *
 * Validated through `assertValidRateCard` — the same function the quoting path uses —
 * so a card that could not be quoted from cannot be saved in the first place. Rejecting
 * at the form is the only place a person can still fix it.
 *
 * NOT TRANSACTIONAL: neon-http has no transactions, so a failure part-way leaves a card
 * with some of its rates. That is survivable precisely because `loadRateCard` treats an
 * incomplete card as absent — the operator sees "pricing not set up" and saves again,
 * rather than the portal quoting from half a card.
 */
export async function saveRateCard(db: Db, tenantId: string, card: RateCard): Promise<void> {
  assertValidRateCard(card);
  // Validated with the SAME function the quoting path uses, so a surcharge that could
  // not be computed from cannot be stored in the first place.
  if (card.fuel) assertValidFuelSettings(card.fuel);

  const [existing] = await db
    .select({ id: tenantRateCards.id })
    .from(tenantRateCards)
    .where(eq(tenantRateCards.tenantId, tenantId))
    .limit(1);

  let cardId: string;
  if (existing) {
    cardId = existing.id;
    await db
      .update(tenantRateCards)
      .set({
        driverPayPercent: card.driverPayPercent,
        maxQuotableMeters: card.maxQuotableMeters,
        fuelBasis: card.fuel?.basis ?? null,
        fuelBaselineCentsPerGallon: card.fuel?.baselineCentsPerGallon ?? null,
        milesPerGallonTenths: card.fuel?.milesPerGallonTenths ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(tenantRateCards.id, cardId), eq(tenantRateCards.tenantId, tenantId)));
  } else {
    const [created] = await db
      .insert(tenantRateCards)
      .values({
        tenantId,
        driverPayPercent: card.driverPayPercent,
        maxQuotableMeters: card.maxQuotableMeters,
        fuelBasis: card.fuel?.basis ?? null,
        fuelBaselineCentsPerGallon: card.fuel?.baselineCentsPerGallon ?? null,
        milesPerGallonTenths: card.fuel?.milesPerGallonTenths ?? null,
      })
      .returning({ id: tenantRateCards.id });
    if (!created) throw new RateCardValidationError("Could not save the rate card.");
    cardId = created.id;
  }

  // Every type, every time. Writing only the changed ones would leave a card that is
  // complete in the form and incomplete in the database the first time a type is added.
  for (const type of ORDER_TYPES) {
    const rate = card.rates[type];
    await db
      .insert(tenantRateCardRates)
      .values({
        rateCardId: cardId,
        type,
        baseCents: rate.baseCents,
        perMileCents: rate.perMileCents,
        minimumCents: rate.minimumCents,
      })
      .onConflictDoUpdate({
        target: [tenantRateCardRates.rateCardId, tenantRateCardRates.type],
        set: {
          baseCents: rate.baseCents,
          perMileCents: rate.perMileCents,
          minimumCents: rate.minimumCents,
        },
      });
  }
}

/**
 * Miles, as an operator types them, to whole metres.
 *
 * The ceiling is entered in miles because that is the unit the operator thinks in, and
 * stored in metres because that is what every routing API returns — converting once, at
 * the boundary, rather than at each comparison.
 */
export function milesToMetres(miles: number): number {
  if (!Number.isFinite(miles) || miles <= 0) {
    throw new RateCardValidationError("Enter a distance in miles greater than zero.");
  }
  return Math.round(miles * 1609.344);
}

export function metresToMiles(metres: number): number {
  return Math.round((metres / 1609.344) * 10) / 10;
}
