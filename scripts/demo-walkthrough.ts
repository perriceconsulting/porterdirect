/**
 * Stage a complete, demonstrable product — three roles, real accounts, real evidence —
 * and then print the script you read out while clicking.
 *
 *   npm run demo -- <owner email>
 *
 * WHY THIS IS MORE THAN A SEEDER. Having the software work and being able to SHOW it are
 * different problems, and the second one was unsolved: three surfaces need three
 * identities, one browser holds one session at a time, and the interesting states (a job
 * booked by a customer, a job out for delivery, a job with proof attached) each take
 * several steps to reach by hand. Anyone demonstrating this was expected to improvise all
 * of that live. So this creates the accounts, walks the jobs into position, and prints the
 * narrative in the order it should be told.
 *
 * IT NEEDS THE SERVER RUNNING. The driver and customer accounts are created through the
 * real sign-up endpoint rather than by writing password hashes, so the credentials it
 * prints genuinely work — a demo account that cannot sign in is worse than none.
 *
 * Development only, mechanically: this writes rows and uploads objects to whatever
 * DATABASE_URL and STORAGE_* point at.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  customerInvitations,
  orderProofs,
  orders,
  tenantCustomers,
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
/**
 * Passes the real password policy — long, no repeated runs, no keyboard sequence, not in
 * the common list. A demo password the product itself would refuse is an embarrassing way
 * to open a demonstration.
 */
const DEMO_PASSWORD = "harbour lantern copper";

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
console.log(`Staging a demo for ${tenant.name}\n`);

// The server has to be up, and saying so plainly beats a confusing fetch error later.
try {
  const probe = await fetch(`${BASE}/signin`);
  if (!probe.ok) throw new Error(String(probe.status));
} catch {
  throw new Error(
    `Cannot reach ${BASE}. Start the dev server first (npm run dev), or set DEMO_BASE_URL.`,
  );
}

/**
 * Create a person through the REAL sign-up endpoint, or reuse them if they exist.
 *
 * Over HTTP rather than an insert, so the printed password actually works. Better Auth
 * owns credential hashing, and reproducing it here would be a second implementation of
 * the one thing that must not drift.
 */
async function person(email: string, first: string, last: string): Promise<string> {
  const [already] = await db.select().from(users).where(eq(users.email, email));
  if (already) return already.id;

  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Node's fetch sends no Origin, and Better Auth reads a missing one as
      // cross-origin: the first version of this got a flat 403 with no clue why. Set to
      // the host we are calling, which is either baseURL or a trusted origin — a browser
      // would send exactly this.
      Origin: BASE,
    },
    body: JSON.stringify({
      email,
      password: DEMO_PASSWORD,
      name: `${first} ${last}`,
      firstName: first,
      lastName: last,
    }),
  });
  if (!res.ok) throw new Error(`Could not create ${email}: HTTP ${res.status}`);

  const [created] = await db.select().from(users).where(eq(users.email, email));
  if (!created) throw new Error(`${email} was not created`);
  return created.id;
}

const slug = tenant.name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "demo";
const driverEmail = `driver@${slug}.demo.test`;
const customerEmail = `client@${slug}.demo.test`;

const driverId = await person(driverEmail, "Dana", "Okonkwo");
const customerUserId = await person(customerEmail, "Mara", "Whitfield");

// A driver on the roster and a customer with an account. Both idempotent, so re-running
// does not pile up memberships.
await db
  .insert(tenantMembers)
  .values({ tenantId, userId: driverId, role: "driver" })
  .onConflictDoNothing();
await db
  .insert(tenantCustomers)
  .values({ tenantId, userId: customerUserId, companyName: "Whitfield Legal" })
  .onConflictDoNothing();
const [customerAccount] = await db
  .select()
  .from(tenantCustomers)
  .where(eq(tenantCustomers.userId, customerUserId));

// Clear the jobs so the tour is the same every time.
//
// The cost, said plainly because it looks exactly like a bug: a tracking token belongs to
// an ORDER, so this invalidates every customer link a previous run printed. Re-running
// while an old /t/<token> tab is open makes that tab 404 — and the tracking page answers
// "no such token" and "expired" identically, so nothing on the page tells a stale link
// from a broken one.
const existing = await db.select({ id: orders.id }).from(orders).where(eq(orders.tenantId, tenantId));
if (existing.length > 0) {
  await db.delete(orderProofs).where(eq(orderProofs.tenantId, tenantId));
  // order_events is append-only in the database and retained six years, so a re-run adds
  // to the trail rather than replacing it.
  await db.delete(orders).where(eq(orders.tenantId, tenantId));
  console.log(`  cleared ${existing.length} previous job(s) — links from an earlier run now 404`);
}
await db.delete(customerInvitations).where(eq(customerInvitations.tenantId, tenantId));

const addr = (line1: string, city: string, region: string, postalCode: string) => ({
  line1,
  city,
  region,
  postalCode,
  country: "US",
});

const make = async (args: {
  first: string;
  last: string;
  phone: string;
  email?: string;
  price: number | null;
  driverPay?: number;
  bookedBy?: string;
  notes: string;
}) =>
  createOrder(db, {
    tenantId,
    actorUserId: owner.id,
    type: "fixed_pickup",
    customerFirstName: args.first,
    customerLastName: args.last,
    customerPhone: args.phone,
    customerEmail: args.email,
    country: tenant.defaultCountry as never,
    pickup: addr("811 W 7th St", "Los Angeles", "CA", "90017"),
    dropoff: addr("1355 N Highland Ave", "Los Angeles", "CA", "90028"),
    priceCents: args.price,
    driverPayCents: args.driverPay,
    bookedByCustomerId: args.bookedBy,
    notes: args.notes,
    scheduledFor: null,
  });

// A. Booked by the CUSTOMER, unpriced — the newest part of the product, and the one that
//    answers "where do jobs come from".
const booked = await make({
  first: "Ravi",
  last: "Patel",
  phone: "2133734253",
  price: null,
  bookedBy: customerAccount?.id,
  notes: "Sealed envelope — court filing, hand to the clerk",
});

// B. Priced and waiting for a driver: what an offer looks like.
const offered = await make({
  first: "Devon",
  last: "Okafor",
  phone: "2127363100",
  price: 6200,
  driverPay: 4100,
  notes: "Signature required — legal documents",
});

// C. Out for delivery, driver assigned.
const enRoute = await make({
  first: "Marisol",
  last: "Vega",
  phone: "2133734253",
  price: 4850,
  driverPay: 3200,
  notes: "Ring the bell twice",
});
await db.update(orders).set({ assignedUserId: driverId }).where(eq(orders.id, enRoute.id));
for (const to of ["assigned", "en_route"] as const) {
  await transitionOrder(db, { tenantId, orderId: enRoute.id, to, actorUserId: driverId });
}

// D. Delivered WITH evidence — the certificate, and a tracking page with proof on it.
const done = await make({
  first: "Grace",
  last: "Mbeki",
  phone: "2133734253",
  email: ownerEmail,
  price: 5400,
  driverPay: 3600,
  notes: "Leave with reception if unavailable",
});
await db.update(orders).set({ assignedUserId: driverId }).where(eq(orders.id, done.id));
for (const to of ["assigned", "en_route"] as const) {
  await transitionOrder(db, { tenantId, orderId: done.id, to, actorUserId: driverId });
}

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

// Minimal valid PNGs as flat colour — enough to prove the pipeline end to end without a
// rasteriser in a seed script.
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
  capturedByUserId: driverId,
  recipientName: "J. Alvarez",
  signatureKey,
  photoKey,
  lat: "34.098765",
  lng: "-118.329876",
  accuracyM: 12,
});
await transitionOrder(db, { tenantId, orderId: done.id, to: "delivered", actorUserId: driverId });

const filled = await backfillPublicTokens(db, tenantId);
if (filled > 0) console.log(`  backfilled ${filled} tracking token(s)`);

const rows = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
const byId = new Map(rows.map((r) => [r.id, r]));
const ref = (id: string) => byId.get(id)?.reference ?? "?";
const track = (id: string) => {
  const token = byId.get(id)?.publicToken;
  return token ? `${BASE}/t/${token}` : "(no tracking link)";
};

console.log(`
════════════════════════════════════════════════════════════════════
  THE DEMO — read top to bottom while you click
════════════════════════════════════════════════════════════════════

  ONE BROWSER HOLDS ONE SESSION. Open each role in a SEPARATE window:
  a normal window, a private window, and a second private window (or a
  different browser). Signing in as one role signs you out of the last.

  Everyone's password:  ${DEMO_PASSWORD}

────────────────────────────────────────────────────────────────────
  1. THE PITCH, BEFORE ANY CLICKING
────────────────────────────────────────────────────────────────────

  "You can't bid on the hospital contract because you can't produce a
   chain of custody, proof of delivery, or an audit trail. I can."

  Everything below is that sentence, demonstrated.

────────────────────────────────────────────────────────────────────
  2. THE CUSTOMER BOOKS  —  window A (private)
────────────────────────────────────────────────────────────────────

  Sign in as   ${customerEmail}
  Go to        ${BASE}/portal/${tenantId}

  Point out:  their courier's name at the top, not ours.
              They already booked ${ref(booked.id)} — it reads "Needs pricing",
              because the price is the operator's decision, not theirs.

  Book one live. It reaches the board immediately.

────────────────────────────────────────────────────────────────────
  3. THE OFFICE PRICES AND DISPATCHES  —  window B (normal)
────────────────────────────────────────────────────────────────────

  Sign in as   ${ownerEmail}
  Board        ${BASE}/dashboard/${tenantId}/orders

  Point out:  the job they just booked, marked "Needs pricing".
              ${ref(offered.id)} is priced and waiting for a driver.
              Open any job to see its full chain of custody.

────────────────────────────────────────────────────────────────────
  4. THE DRIVER  —  window C (private), or your PHONE
────────────────────────────────────────────────────────────────────

  Sign in as   ${driverEmail}
  Board        ${BASE}/drive/${tenantId}

  Point out:  offers show the DRIVER'S pay, never the customer price.
              ${ref(enRoute.id)} is out for delivery — tap it to navigate,
              call, and capture proof.

  On a phone this is the whole product: signature, photo, geotag.

────────────────────────────────────────────────────────────────────
  5. THE CUSTOMER WATCHES  —  no login at all
────────────────────────────────────────────────────────────────────

  Out for delivery   ${track(enRoute.id)}
  Delivered, w/ proof
                     ${track(done.id)}

  Point out:  the operator's name, no login, no app — and the
              certificate on the delivered one: signature, photo,
              geotag, time, their branding.

────────────────────────────────────────────────────────────────────
  6. THE PART NOBODY ELSE SELLS  —  window B
────────────────────────────────────────────────────────────────────

  Console      ${BASE}/dashboard/${tenantId}

  Scroll to EVIDENCE PACK and download all three:

    Deliveries        what you carried, and when
    Chain of custody  who held it, and when it changed hands
    Access log        who has opened the evidence since

  "This is what you hand the lab. The third file is the one your
   competitors can't produce — it proves the record has only been
   seen by the people who should have seen it."

  Then the quiet part: the custody trail is append-only in the
  database, kept six years, and this download was itself logged.

════════════════════════════════════════════════════════════════════
  Staged:  ${ref(booked.id)}  customer-booked, unpriced
           ${ref(offered.id)}  priced, waiting for a driver
           ${ref(enRoute.id)}  out for delivery
           ${ref(done.id)}  delivered with proof
════════════════════════════════════════════════════════════════════
`);
