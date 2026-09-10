/**
 * The retention sweep, on a schedule.
 *
 * WHY THIS ROUTE EXISTS AT ALL. `sweepExpiredObjects` and `purgeExpiredAccessEvents` were
 * written, tested and then called by nothing. So retention meant "we CAN destroy on time"
 * rather than "we DO" — and under a BAA the commitment is the second one. A function with
 * no caller is a claim, not a control.
 *
 * IT DESTROYS ONLY WHAT IS ALREADY PAST ITS DATE. Every deletion here is gated on a
 * `retain_until` that has passed, and for `order_events` the database refuses anything
 * else outright: the append-only trigger permits a delete only after the retention date,
 * so even a bug in this file cannot erase a live custody record. That is the point of
 * putting the rule in Postgres rather than in application code.
 *
 * AUTHORIZATION. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without the
 * secret set the route REFUSES rather than running openly — an unauthenticated endpoint
 * that deletes things is not something to leave to obscurity, and "it only deletes expired
 * rows" is a reason it is survivable, not a reason to leave it open.
 */
import { NextResponse } from "next/server";
import { eq, lte } from "drizzle-orm";
import { createDbClient, orderEvents } from "@porterdirect/db";
import { purgeExpiredAccessEvents } from "../../../../lib/access-log";
import { sweepExpiredObjects } from "../../../../lib/retention";
import { bucketDestroyer, isStorageConfigured } from "../../../../lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long enough for a real backlog; Vercel caps this per plan. */
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means no run. Failing closed here costs a night's sweep and
  // makes the misconfiguration visible; failing open would put an unauthenticated delete
  // endpoint on a public domain.
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const db = createDbClient(process.env.DATABASE_URL);
  const now = new Date();

  // 1. Objects in the bucket. Skipped rather than failed when storage is unconfigured —
  //    a deployment without credentials has nothing to sweep, and erroring would make the
  //    cron look broken every night for a reason that is not a fault.
  const objects = isStorageConfigured()
    ? await sweepExpiredObjects(db, bucketDestroyer, now)
    : { considered: 0, destroyed: 0, failed: [] as readonly string[] };

  // 2. Audit rows for reads of that evidence.
  const accessPurged = await purgeExpiredAccessEvents(db, now);

  // 3. The custody trail. Deleted one row at a time and only past its date — the
  //    append-only trigger refuses anything else, so this cannot become a way to erase a
  //    live record even by accident.
  const dueEvents = await db
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(lte(orderEvents.retainUntil, now))
    .limit(1000);
  let custodyPurged = 0;
  for (const row of dueEvents) {
    try {
      await db.delete(orderEvents).where(eq(orderEvents.id, row.id));
      custodyPurged += 1;
    } catch (err) {
      // The trigger refusing is a correct outcome, not a crash. Logged and stepped over,
      // so one stuck row cannot stop the rest of the sweep.
      console.error(`[retention] could not purge event ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const summary = {
    ranAt: now.toISOString(),
    objectsConsidered: objects.considered,
    objectsDestroyed: objects.destroyed,
    objectsFailed: objects.failed.length,
    accessEventsPurged: accessPurged,
    custodyEventsPurged: custodyPurged,
  };

  // Logged as well as returned: the response goes to Vercel's cron runner and nobody
  // reads it, while "what did the sweep do last night" is a question an auditor asks.
  console.log("[retention]", JSON.stringify(summary));

  // Failed object deletions are reported but do not fail the run — the row stays unmarked
  // so tomorrow retries it, which is the behaviour the sweep was built with.
  return NextResponse.json(summary, { status: 200 });
}
