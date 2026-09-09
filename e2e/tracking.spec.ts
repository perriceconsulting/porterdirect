/**
 * The customer tracking page — the one surface with NO login.
 *
 * Two properties matter here and nothing else in the suite protects either:
 *
 *   It carries the OPERATOR's brand and not ours. This is the white-label promise made
 *   concrete; everything before it was an internal tool or a PDF.
 *
 *   It shows only what the recipient is entitled to. The token admits a stranger, so
 *   anything extra on this page — a price, a phone number, another job — is a leak with a
 *   public URL attached.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import {
  createDbClient,
  orderEvents,
  orderProofs,
  orders,
  tenantMembers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const RUN_DOMAIN = `e2e-track-${RUN}.test`;
const PASSWORD = "correct-horse-battery-staple";
const OPERATOR = `Meridian White Glove ${RUN}`;

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return /^DATABASE_URL=(.*)$/m
      .exec(readFileSync(new URL("../.env.local", import.meta.url), "utf8"))?.[1]
      ?.trim();
  } catch {
    return undefined;
  }
}
const DB_URL = databaseUrl();

let db: Db;
let tenantId = "";
let userId = "";
let token = "";

test.describe("the customer tracking page", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const ctx = await playwright.request.newContext({ baseURL: baseURL ?? "http://localhost:3000" });
    await ctx.post("/api/auth/sign-up/email", {
      data: { email: `owner@${RUN_DOMAIN}`, password: PASSWORD, name: "Owner" },
    });
    const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };
    userId = session.user?.id ?? "";
    await ctx.dispose();

    const [t] = await db
      .insert(tenants)
      .values({ name: OPERATOR, primaryHost: `track-${RUN}.test`, defaultCountry: "US" })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });

    const [o] = await db
      .insert(orders)
      .values({
        tenantId,
        reference: `TRK-${RUN.slice(0, 5).toUpperCase()}`,
        type: "fixed_pickup",
        status: "en_route",
        customerFirstName: "Marisol",
        customerLastName: "Vega",
        customerPhone: "+12133734253",
        pickupLine1: "811 W 7th St",
        pickupCity: "Los Angeles",
        pickupRegion: "CA",
        pickupPostalCode: "90017",
        pickupCountry: "US",
        dropoffLine1: "1355 N Highland Ave",
        dropoffCity: "Los Angeles",
        dropoffRegion: "CA",
        dropoffPostalCode: "90028",
        dropoffCountry: "US",
        priceCents: 4850,
        publicToken: `tok${RUN}TRACKINGTOKENabcdefghijkl`,
      })
      .returning({ id: orders.id, publicToken: orders.publicToken });
    token = o!.publicToken!;
  });

  test.afterAll(async () => {
    if (!db || !tenantId) return;
    await db.delete(orderProofs).where(eq(orderProofs.tenantId, tenantId));
    await db.delete(orderEvents).where(eq(orderEvents.tenantId, tenantId));
    await db.delete(orders).where(eq(orders.tenantId, tenantId));
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(users).where(like(users.email, `%@${RUN_DOMAIN}`));
  });

  test("opens with no login at all", async ({ page }) => {
    // A fresh context: no cookie, no session, nothing. This is a stranger with a link.
    await page.goto(`/t/${token}`);
    expect(page.url()).toContain(`/t/${token}`);
    await expect(page.locator("body")).toContainText("On the way");
  });

  test("carries the OPERATOR's name and never ours", async ({ page }) => {
    await page.goto(`/t/${token}`);
    const body = await page.locator("body").innerText();
    expect(body).toContain(OPERATOR);
    // The white-label promise, on the only page a tenant's customer sees.
    expect(body).not.toMatch(/PorterDirect/i);
    // Including the tab title, which is part of the brand surface.
    expect(await page.title()).not.toMatch(/PorterDirect/i);
  });

  test("shows the delivery and withholds everything else", async ({ page }) => {
    await page.goto(`/t/${token}`);
    const body = await page.locator("body").innerText();

    expect(body).toContain("1355 N Highland Ave");

    // The token admits a stranger, so anything beyond the delivery is a leak with a
    // public URL attached. The price is a business arrangement between the operator and
    // whoever booked; the phone number belongs to the customer, not to link-holders.
    expect(body).not.toContain("48.50");
    expect(body).not.toContain("373-4253");
    expect(body).not.toContain("811 W 7th St");
  });

  test("answers identically for a wrong token as for a malformed one", async ({ page }) => {
    // Distinguishing them would turn this into an oracle for guessing links.
    const wrong = await page.goto(`/t/${"z".repeat(32)}`);
    const malformed = await page.goto("/t/nope");
    expect(wrong?.status()).toBe(404);
    expect(malformed?.status()).toBe(404);
  });

  test("an empty token matches no order", async ({ page }) => {
    // The trap: `publicToken` is nullable, so a query on "" must not match every row
    // written before tracking existed.
    const res = await page.goto("/t/%20");
    expect(res?.status()).toBe(404);
  });

  test("is not indexable", async ({ page }) => {
    // A delivery address on a public URL has no business in a search index.
    await page.goto(`/t/${token}`);
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots ?? "").toMatch(/noindex/);
  });
});
