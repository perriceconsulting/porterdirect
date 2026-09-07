/**
 * Seed a tenant's dispatch board with realistic jobs.
 *
 * Development only, and it says so mechanically: this INSERTS rows into whatever
 * database DATABASE_URL points at, and a seed script that quietly runs against
 * production is how demo data ends up on a customer's board.
 *
 * The data is deliberately real-shaped — dialable phone numbers, genuine street
 * addresses, prices that look like courier work — because a board full of "Test
 * Customer / 123 Test St / $0" tells you nothing about whether the layout survives real
 * content. Every number here is a valid, dialable US number; 555 area codes are reserved
 * for fiction and would be refused by our own validator.
 *
 *   npm run seed:demo -- workers@demo.test
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  orderEvents,
  orders,
  tenantMembers,
  tenants,
  users,
} from "../packages/db/src/index.js";
import { createOrder, transitionOrder } from "../apps/marketing/lib/orders.js";
import type { OrderStatus, OrderType } from "../packages/orders/src/index.js";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const eqAt = line.indexOf("=");
    if (eqAt < 1) continue;
    env[line.slice(0, eqAt).trim()] = line.slice(eqAt + 1).trim();
  }
  return env;
}

const env = loadEnv();
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

if (process.env.NODE_ENV === "production") {
  throw new Error("REFUSING: seed data must never be written to production.");
}

const ownerEmail = process.argv[2];
if (!ownerEmail) {
  throw new Error('Usage: npm run seed:demo -- <owner email>   e.g. workers@demo.test');
}

interface Seed {
  readonly type: OrderType;
  readonly first: string;
  readonly last: string;
  readonly phone: string;
  readonly pickup: [string, string, string, string];
  readonly dropoff: [string, string, string, string];
  readonly price: number;
  readonly notes?: string;
  /** Statuses to walk through after creation, in order. */
  readonly advanceTo: readonly OrderStatus[];
  readonly scheduledFor?: Date;
}

const HOUR = 60 * 60 * 1000;

const SEEDS: readonly Seed[] = [
  {
    type: "fixed_pickup",
    first: "Marisol", last: "Vega", phone: "2133734253",
    pickup: ["811 W 7th St", "Los Angeles", "CA", "90017"],
    dropoff: ["1355 N Highland Ave", "Los Angeles", "CA", "90028"],
    price: 4850, notes: "Signature required — legal documents",
    advanceTo: [],
  },
  {
    type: "fixed_pickup",
    first: "Devon", last: "Okafor", phone: "2125550123",
    pickup: ["11 Wall St", "New York", "NY", "10005"],
    dropoff: ["30 Rockefeller Plaza", "New York", "NY", "10112"],
    price: 6200, notes: "Reception closes at 5pm",
    advanceTo: ["assigned"],
  },
  {
    type: "scheduled_courier",
    first: "Priya", last: "Raman", phone: "6502530000",
    pickup: ["1600 Amphitheatre Pkwy", "Mountain View", "CA", "94043"],
    dropoff: ["3500 Deer Creek Rd", "Palo Alto", "CA", "94304"],
    price: 12500, notes: "White-glove — fragile lab samples, keep upright",
    advanceTo: ["assigned", "en_route"],
    scheduledFor: new Date(Date.now() + 6 * HOUR),
  },
  {
    type: "shop_in_store",
    first: "Ana", last: "Delgado", phone: "4155552671",
    pickup: ["2001 Market St", "San Francisco", "CA", "94114"],
    dropoff: ["1 Ferry Building", "San Francisco", "CA", "94111"],
    price: 3400, notes: "Substitutions need approval before checkout",
    advanceTo: ["assigned", "shopping"],
  },
  {
    type: "errand",
    first: "Thomas", last: "Whitfield", phone: "2024561111",
    pickup: ["950 Independence Ave SW", "Washington", "DC", "20560"],
    dropoff: ["1600 Pennsylvania Avenue NW", "Washington", "DC", "20500"],
    price: 2900, notes: "Collect framed print, then deliver",
    advanceTo: ["assigned", "shopping", "checkout"],
  },
  {
    type: "fixed_pickup",
    first: "Grace", last: "Mbeki", phone: "2133734253",
    pickup: ["221 N Figueroa St", "Los Angeles", "CA", "90012"],
    dropoff: ["100 Universal City Plaza", "Universal City", "CA", "91608"],
    price: 5400,
    advanceTo: ["assigned", "en_route", "delivered"],
  },
  {
    type: "fixed_pickup",
    first: "Owen", last: "Barrett", phone: "2125550123",
    pickup: ["405 Lexington Ave", "New York", "NY", "10174"],
    dropoff: ["89 E 42nd St", "New York", "NY", "10017"],
    price: 3100, notes: "Customer cancelled — recipient unavailable",
    advanceTo: ["cancelled"],
  },
];

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

console.log(`Seeding ${tenant.name} (${tenant.primaryHost}) as ${ownerEmail}`);

const existing = await db.select().from(orders).where(eq(orders.tenantId, tenant.id));
if (existing.length > 0) {
  console.log(`  clearing ${existing.length} existing job(s) first`);
  await db.delete(orderEvents).where(eq(orderEvents.tenantId, tenant.id));
  await db.delete(orders).where(eq(orders.tenantId, tenant.id));
}

const country = tenant.defaultCountry;

for (const seed of SEEDS) {
  const order = await createOrder(db, {
    tenantId: tenant.id,
    actorUserId: owner.id,
    type: seed.type,
    customerFirstName: seed.first,
    customerLastName: seed.last,
    customerPhone: seed.phone,
    country: country as never,
    pickup: {
      line1: seed.pickup[0], city: seed.pickup[1],
      region: seed.pickup[2], postalCode: seed.pickup[3], country,
    },
    dropoff: {
      line1: seed.dropoff[0], city: seed.dropoff[1],
      region: seed.dropoff[2], postalCode: seed.dropoff[3], country,
    },
    priceCents: seed.price,
    notes: seed.notes,
    scheduledFor: seed.scheduledFor ?? null,
  });

  // Walked through the real state machine rather than written straight to a status, so
  // the seeded board carries a genuine chain-of-custody trail — and so an illegal path
  // in this file fails loudly instead of producing a row nothing can move.
  let current = order;
  for (const to of seed.advanceTo) {
    current = await transitionOrder(db, {
      tenantId: tenant.id,
      orderId: order.id,
      to,
      actorUserId: owner.id,
    });
  }

  // Assign the driver on anything past pending, so a driver's board is not empty.
  if (seed.advanceTo.length > 0) {
    await db
      .update(orders)
      .set({ assignedUserId: owner.id })
      .where(eq(orders.id, order.id));
  }

  console.log(`  ${order.reference}  ${seed.type.padEnd(18)} ${current.status}`);
}

const all = await db.select().from(orders).where(eq(orders.tenantId, tenant.id));
console.log(`\n${all.length} jobs seeded on ${tenant.name}.`);
