/**
 * Rate card persistence, against a real Postgres.
 *
 * The assertion that matters here is the INCOMPLETE CARD one. `RateCard.rates` is a
 * `Record<OrderType, TypeRate>`, and TypeScript is perfectly happy to believe that about
 * an object missing a key — the same trap that let a hand-maintained order-type list
 * compile while silently refusing a legitimate type. A half-written card is not a typing
 * problem here, it is a live one: it is what a failed save leaves behind (neon-http has
 * no transactions) and what adding a new order type does to every card already stored.
 *
 * Skipped (not failed) without DATABASE_URL, so the suite still runs offline.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDbClient,
  tenantRateCardRates,
  tenantRateCards,
  tenants,
  type Db,
} from "@porterdirect/db";
import { ORDER_TYPES } from "@porterdirect/orders";
import { RateCardError, quoteJob, type RateCard } from "@porterdirect/pricing";
import {
  hasRateCard,
  loadRateCard,
  metresToMiles,
  milesToMetres,
  saveRateCard,
} from "../lib/rate-cards";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    for (const raw of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      const m = /^DATABASE_URL=(.*)$/.exec(line);
      if (m && m[1]) return m[1].trim();
    }
  } catch {
    /* no .env.local — fall through to skip */
  }
  return undefined;
}

const DB_URL = databaseUrl();
const suite = DB_URL ? describe : describe.skip;

const card: RateCard = {
  rates: {
    fixed_pickup: { baseCents: 800, perMileCents: 250, minimumCents: 1500 },
    scheduled_courier: { baseCents: 1500, perMileCents: 300, minimumCents: 2500 },
  },
  driverPayPercent: 65,
  maxQuotableMeters: 80_467,
  // No surcharge on this fixture. Stated rather than omitted: the compiler requires it,
  // which is the point — "runs no fuel surcharge" is a decision, not a missing field.
  fuel: null,
};

suite("rate card persistence", () => {
  let db: Db;
  let tenantId = "";
  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `Rate Card Test ${runId}`, primaryHost: `rc-${runId}.example.test` })
      .returning({ id: tenants.id });
    tenantId = tenant!.id;
  });

  afterAll(async () => {
    // Scoped to the tenant this run OWNS. The repo has already deleted a real account
    // with a loose pattern sweep; a cascade from our own tenant id cannot reach anyone.
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it("reports no card before one is saved", async () => {
    expect(await loadRateCard(db, tenantId)).toBeNull();
    expect(await hasRateCard(db, tenantId)).toBe(false);
  });

  it("round-trips a card unchanged", async () => {
    await saveRateCard(db, tenantId, card);
    const loaded = await loadRateCard(db, tenantId);
    expect(loaded).toEqual(card);
  });

  it("updates in place rather than creating a second card", async () => {
    await saveRateCard(db, tenantId, { ...card, driverPayPercent: 70 });
    const rows = await db
      .select()
      .from(tenantRateCards)
      .where(eq(tenantRateCards.tenantId, tenantId));
    // Two cards would give two answers to what a job costs, decided by whichever the
    // query returned first.
    expect(rows).toHaveLength(1);
    const loaded = await loadRateCard(db, tenantId);
    expect(loaded?.driverPayPercent).toBe(70);
    await saveRateCard(db, tenantId, card);
  });

  it("keeps exactly one rate per order type across repeated saves", async () => {
    await saveRateCard(db, tenantId, card);
    await saveRateCard(db, tenantId, card);
    const [row] = await db
      .select({ id: tenantRateCards.id })
      .from(tenantRateCards)
      .where(eq(tenantRateCards.tenantId, tenantId));
    const rates = await db
      .select()
      .from(tenantRateCardRates)
      .where(eq(tenantRateCardRates.rateCardId, row!.id));
    expect(rates).toHaveLength(ORDER_TYPES.length);
  });

  it("stores a card that is scoped to its own tenant", async () => {
    const [other] = await db
      .insert(tenants)
      .values({ name: `Other ${runId}`, primaryHost: `rc-other-${runId}.example.test` })
      .returning({ id: tenants.id });
    try {
      expect(await loadRateCard(db, other!.id)).toBeNull();
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });

  describe("an incomplete card counts as no card at all", () => {
    it("returns null when a type's rate row is missing", async () => {
      await saveRateCard(db, tenantId, card);
      const [row] = await db
        .select({ id: tenantRateCards.id })
        .from(tenantRateCards)
        .where(eq(tenantRateCards.tenantId, tenantId));

      // Exactly what a half-completed save leaves behind, and what adding a new order
      // type does to every card that already exists.
      //
      // Scoped by THIS run's card id as well as the type. Deleting by type alone would
      // have removed the scheduled_courier rate from every tenant's card in the shared
      // database — the same loose-sweep shape that once deleted a real user account.
      // It passed either way today only because no other card exists yet.
      await db
        .delete(tenantRateCardRates)
        .where(
          and(
            eq(tenantRateCardRates.rateCardId, row!.id),
            eq(tenantRateCardRates.type, "scheduled_courier"),
          ),
        );

      expect(await loadRateCard(db, tenantId)).toBeNull();
      expect(await hasRateCard(db, tenantId)).toBe(false);
      expect(row).toBeDefined();

      // And the consequence that guard prevents: a quote from a half-card would read
      // `undefined.baseCents`. Routed to a person instead.
      const q = quoteJob({ card: await loadRateCard(db, tenantId), type: "fixed_pickup", distanceMeters: 5000 });
      expect(q).toEqual({ kind: "needs_review", reason: "no_rate_card" });

      await saveRateCard(db, tenantId, card);
      expect(await loadRateCard(db, tenantId)).toEqual(card);
    });
  });

  it("refuses to save a card that could not be quoted from", async () => {
    // Same validator the quoting path uses, so the form is the last place a person can
    // still fix it. A 700% split is the plausible typo of 70.
    await expect(saveRateCard(db, tenantId, { ...card, driverPayPercent: 700 })).rejects.toThrow(
      RateCardError,
    );
    // And the stored card is untouched.
    expect(await loadRateCard(db, tenantId)).toEqual(card);
  });

  it("saves a card with no quotable ceiling", async () => {
    await saveRateCard(db, tenantId, { ...card, maxQuotableMeters: null });
    expect((await loadRateCard(db, tenantId))?.maxQuotableMeters).toBeNull();
    await saveRateCard(db, tenantId, card);
  });
});

describe("miles at the boundary", () => {
  it("converts a typed mile ceiling to whole metres", () => {
    expect(milesToMetres(50)).toBe(80_467);
    expect(milesToMetres(1)).toBe(1609);
  });

  it("round-trips back to the number the operator typed", () => {
    // The operator entered 50; the screen must not show them 49.9.
    expect(metresToMiles(milesToMetres(50))).toBe(50);
    expect(metresToMiles(milesToMetres(12.5))).toBe(12.5);
  });

  it("refuses a zero or negative ceiling", () => {
    expect(() => milesToMetres(0)).toThrow(/greater than zero/);
    expect(() => milesToMetres(-5)).toThrow(/greater than zero/);
  });
});
