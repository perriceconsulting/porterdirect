/**
 * Set up a complete, clickable demo of the whole delivery loop, then print the URLs.
 *
 *   npm run demo -- workers@demo.test
 *
 * Development only, and it says so mechanically: this writes rows and uploads objects to
 * whatever DATABASE_URL and STORAGE_* point at. A demo script that quietly runs against
 * production is how staged data reaches a customer's board.
 *
 * Leaves the tenant with one job in each of the states worth LOOKING at, rather than one
 * of every state that exists — a demo is a tour, not an inventory.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  orderEvents,
  orderProofs,
  orders,
  tenantMembers,
  tenants,
  users,
} from "../packages/db/src/index.js";
import {
  backfillPublicTokens,
  createOrder,
  recordProof,
  transitionOrder,
} from "../apps/marketing/lib/orders.js";
import { presignProofUpload } from "../apps/marketing/lib/storage.js";

for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  const at = line.indexOf("=");
  if (at < 1) continue;
  process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
}

if (process.env.NODE_ENV === "production") {
  throw new Error("REFUSING: demo data must never be written to production.");
}

const ownerEmail = process.argv[2];
if (!ownerEmail) throw new Error("Usage: npm run demo -- <owner email>");

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const db = createDbClient(process.env.DATABASE_URL);

const [owner] = await db.select().from(users).where(eq(users.email, ownerEmail));
if (!owner) throw new Error(`No user found for ${ownerEmail}`);
const [membership] = await db
  .select()
  .from(tenantMembers)
  .where(eq(tenantMembers.userId, owner.id));
if (!membership) throw new Error(`${ownerEmail} is not a member of any tenant`);
const [tenant] = await db.select().from(tenants).where(eq(tenants.id, membership.tenantId));
if (!tenant) throw new Error("Tenant row missing");

const tenantId = tenant.id;
console.log(`Setting up a demo for ${tenant.name}\n`);

// Clear first, so the tour is the same every time it is run.
//
// The cost of that, said plainly because it looks exactly like a bug: a tracking token
// belongs to an ORDER, so deleting the jobs invalidates every customer link a previous
// run printed. Re-running while an old /t/<token> tab is open makes that tab 404 — and
// the tracking page deliberately answers "no such token" and "expired" identically, so
// there is nothing on the page to tell a stale link from a broken one.
const existing = await db.select({ id: orders.id }).from(orders).where(eq(orders.tenantId, tenantId));
if (existing.length > 0) {
  await db.delete(orderProofs).where(eq(orderProofs.tenantId, tenantId));
  await db.delete(orderEvents).where(eq(orderEvents.tenantId, tenantId));
  await db.delete(orders).where(eq(orders.tenantId, tenantId));
  console.log(`  cleared ${existing.length} previous job(s) — links printed by an earlier run now 404`);
}

const addr = (line1: string, city: string, region: string, postalCode: string) => ({
  line1,
  city,
  region,
  postalCode,
  country: "US",
});

const make = async (
  first: string,
  last: string,
  phone: string,
  email: string | undefined,
  price: number,
  driverPay: number,
) =>
  createOrder(db, {
    tenantId,
    actorUserId: owner.id,
    type: "fixed_pickup",
    customerFirstName: first,
    customerLastName: last,
    customerPhone: phone,
    customerEmail: email,
    country: tenant.defaultCountry as never,
    pickup: addr("811 W 7th St", "Los Angeles", "CA", "90017"),
    dropoff: addr("1355 N Highland Ave", "Los Angeles", "CA", "90028"),
    priceCents: price,
    driverPayCents: driverPay,
    notes: "Signature required — legal documents",
    scheduledFor: null,
  });

// 1. Waiting for a driver.
// Unassigned and PRICED — this is the one that appears as an offer to a driver.
const waiting = await make("Devon", "Okafor", "2127363100", undefined, 6200, 4100);

// 2. Out for delivery — this is the one the DRIVER surface acts on.
const enRoute = await make("Marisol", "Vega", "2133734253", undefined, 4850, 3200);
await db.update(orders).set({ assignedUserId: owner.id }).where(eq(orders.id, enRoute.id));
for (const to of ["assigned", "en_route"] as const) {
  await transitionOrder(db, { tenantId, orderId: enRoute.id, to, actorUserId: owner.id });
}

// 3. Delivered WITH evidence — the customer-facing tracking page and certificate.
const done = await make("Grace", "Mbeki", "2133734253", ownerEmail, 5400, 3600);
await db.update(orders).set({ assignedUserId: owner.id }).where(eq(orders.id, done.id));
for (const to of ["assigned", "en_route"] as const) {
  await transitionOrder(db, { tenantId, orderId: done.id, to, actorUserId: owner.id });
}

// Real evidence in the real bucket, so the tracking page and PDF have something to show.
const upload = async (kind: "photo" | "signature", png: Buffer) => {
  const { url, key } = await presignProofUpload({
    tenantId,
    orderId: done.id,
    kind,
    contentType: "image/png",
    contentLength: png.byteLength,
  });
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png });
  if (!res.ok) throw new Error(`${kind} upload failed: ${res.status}`);
  return key;
};

// Minimal valid PNGs drawn as flat colour — enough to prove the pipeline end to end
// without needing a rasteriser in a seed script.
const solidPng = (hex: string) =>
  Buffer.from(
    `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42${hex}AAAAASUVORK5CYII=`,
    "base64",
  );

const signatureKey = await upload("signature", solidPng("mP8z8BQDwAEhQGAhKmMIQ"));
const photoKey = await upload("photo", solidPng("mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg"));

await recordProof(db, {
  tenantId,
  orderId: done.id,
  capturedByUserId: owner.id,
  recipientName: "J. Alvarez",
  signatureKey,
  photoKey,
  lat: "34.098765",
  lng: "-118.329876",
  accuracyM: 12,
});
await transitionOrder(db, { tenantId, orderId: done.id, to: "delivered", actorUserId: owner.id });

// Orders created before tracking existed have no link; give them one.
const filled = await backfillPublicTokens(db, tenantId);
if (filled > 0) console.log(`  backfilled ${filled} tracking token(s)`);

const [deliveredRow] = await db.select().from(orders).where(eq(orders.id, done.id));
const token = deliveredRow?.publicToken ?? "";

// Every job gets its links printed together, because the point of a demo is to follow
// ONE delivery across all three surfaces. Printing a different job per surface — which
// this script did first — makes them look out of sync when they simply are not the same
// delivery.
const rows = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
const byId = new Map(rows.map((r) => [r.id, r]));

const line = (label: string, id: string, note: string) => {
  const o = byId.get(id);
  if (!o) return "";
  return `
  ${label}  —  ${o.reference}  (${o.status})
    ${note}
    office    ${BASE}/dashboard/${tenantId}/orders/${o.id}
    driver    ${o.assignedUserId ? `${BASE}/drive/${tenantId}/${o.id}` : `${BASE}/drive/${tenantId}   (appears as an OFFER, not yet taken)`}
    customer  ${o.publicToken ? `${BASE}/t/${o.publicToken}` : "(no tracking link)"}`;
};

console.log(`
────────────────────────────────────────────────────────────
  THE WALKTHROUGH — sign in as ${ownerEmail}
────────────────────────────────────────────────────────────

  Boards:  office   ${BASE}/dashboard/${tenantId}/orders
           driver   ${BASE}/drive/${tenantId}

  THREE SEPARATE JOBS, each shown on all three surfaces. Pick ONE
  and open its three links side by side — that is the same delivery
  seen by the office, the driver and the customer.
${line("A. OFFERED", waiting.id, "Unassigned and priced. The driver sees $41.00 with Accept / Decline.")}
${line("B. OUT FOR DELIVERY", enRoute.id, "Taken. The driver can navigate, call, and capture proof.")}
${line("C. DELIVERED", done.id, "Signed and photographed. The customer link shows the proof.")}

Note: office and driver need a session; the customer link deliberately
does not — that is the white-label surface, and it must open for a stranger.

Use the links ABOVE, not ones from an earlier run. This script replaces the
jobs each time, and a tracking token dies with its order — an old customer
tab will 404, which is correct behaviour and looks like a broken page.
────────────────────────────────────────────────────────────
`);
