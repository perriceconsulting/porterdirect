/**
 * The chain of custody is append-only IN THE DATABASE.
 *
 * `CLAUDE.prd.md` used to list "append-only audit trail" under what was built. It was a
 * comment in the schema and nothing else: zero triggers, zero revoked grants, no
 * row-level security anywhere in the migration history, and any UPDATE or DELETE simply
 * worked. That is the failure class this project catalogues — it passes every test,
 * returns 200, and then a procurement reviewer asks you to prove it.
 *
 * So these tests ATTEMPT the tampering and expect the database to refuse. Reading a grant
 * or asserting that a trigger exists would prove only that something is installed, not
 * that it bites.
 *
 * AND THEY CLASSIFY BY SQLSTATE, not by message text. Written first with
 * `.rejects.toThrow(/append-only/i)`, all four assertions failed while the trigger was
 * working perfectly: Drizzle wraps the driver error and its message is the failed SQL, so
 * the match saw "Failed query: update ..." and reported the guard as absent. That is the
 * landmine this repo has now hit three times — classify by shape.
 *
 * Skipped (not failed) without DATABASE_URL — the guarantee lives in Postgres, so there is
 * nothing to assert without one.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbClient, isRestrictViolation, orderEvents, type Db } from "@porterdirect/db";
import { retainUntil } from "../lib/retention";

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

/**
 * Assert the DATABASE refused, by SQLSTATE. `restrict_violation` (23001) is what the
 * trigger raises; anything else means the statement failed for an unrelated reason and
 * the test would otherwise pass for the wrong one.
 */
async function expectRefused(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isRestrictViolation(err), `refused, but not by the append-only rule: ${String(err)}`).toBe(true);
    return;
  }
  throw new Error("the database allowed it — order_events is not append-only");
}

suite("order_events is append-only", () => {
  let db: Db;
  const tenantId = randomUUID();
  const orderId = randomUUID();
  let eventId = "";

  beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [row] = await db
      .insert(orderEvents)
      .values({
        tenantId,
        orderId,
        toStatus: "pending",
        note: "append-only probe",
        retainUntil: retainUntil(),
      })
      .returning({ id: orderEvents.id });
    eventId = row!.id;
  });

  afterAll(async () => {
    // The probe row cannot be deleted while retained — that is the point of the suite —
    // so it is aged past retention with the trigger briefly disabled, then removed. Doing
    // this in application code would be a hole; doing it in a test teardown against a row
    // this run created is housekeeping.
    if (!eventId) return;
    await db.execute(sql`alter table order_events disable trigger order_events_append_only_trigger`);
    await db
      .update(orderEvents)
      .set({ retainUntil: new Date(Date.now() - 86_400_000) })
      .where(eq(orderEvents.id, eventId));
    await db.execute(sql`alter table order_events enable trigger order_events_append_only_trigger`);
    await db.delete(orderEvents).where(eq(orderEvents.id, eventId));
  });

  it("refuses to change what an event says", async () => {
    await expectRefused(
      db.update(orderEvents).set({ note: "tampered" }).where(eq(orderEvents.id, eventId)),
    );
  });

  it("refuses to change the status an event recorded", async () => {
    // The one that would actually matter: rewriting history so a failed delivery reads as
    // delivered.
    await expectRefused(
      db.update(orderEvents).set({ toStatus: "delivered" }).where(eq(orderEvents.id, eventId)),
    );
  });

  it("refuses to delete an event inside its retention period", async () => {
    await expectRefused(
      db.delete(orderEvents).where(eq(orderEvents.id, eventId)),
    );
  });

  it("refuses to SHORTEN a retention period", async () => {
    // The subtle attack, and the one the design closes for free: backdating
    // `retain_until` to make a row deletable is itself an UPDATE, so the same guard
    // refuses it. Retention cannot be quietly reduced on a record already written.
    await expectRefused(
      db
        .update(orderEvents)
        .set({ retainUntil: new Date("2000-01-01T00:00:00.000Z") })
        .where(eq(orderEvents.id, eventId)),
    );
  });

  it("still accepts new events, because append-only means append", async () => {
    const [added] = await db
      .insert(orderEvents)
      .values({
        tenantId,
        orderId,
        fromStatus: "pending",
        toStatus: "assigned",
        note: "second probe",
        retainUntil: new Date(Date.now() - 86_400_000),
      })
      .returning({ id: orderEvents.id });
    expect(added).toBeDefined();

    // And a row genuinely past its retention date CAN be removed — the six-year policy is
    // enforced by the trigger rather than by remembering to run something. Deleting is not
    // forbidden, it is DATED.
    await db.delete(orderEvents).where(eq(orderEvents.id, added!.id));
    expect(
      await db.select().from(orderEvents).where(eq(orderEvents.id, added!.id)),
    ).toHaveLength(0);
  });

  it("survives the tenant and order it describes being deleted", async () => {
    // No foreign keys, deliberately. `tenant_id` and `order_id` here point at rows that
    // never existed in this test, which is the strongest possible demonstration: nothing
    // about their fate can reach the trail.
    const [row] = await db.select().from(orderEvents).where(eq(orderEvents.id, eventId));
    expect(row).toBeDefined();
    expect(row!.tenantId).toBe(tenantId);
    expect(row!.orderId).toBe(orderId);
  });
});
