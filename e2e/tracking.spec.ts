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
    // Audit rows are NOT deleted here, and cannot be: `order_events` is append-only in
    // the database and its rows are retained for six years. Test and demo runs therefore
    // leave their custody trail behind, which is the same thing production does and is
    // the point of the guarantee — a trail a cleanup script can erase is not a trail.
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

  test("carries the OPERATOR's name and never ours — in the whole RESPONSE", async ({
    page,
  }) => {
    const res = await page.goto(`/t/${token}`);
    const body = await page.locator("body").innerText();
    expect(body).toContain(OPERATOR);
    expect(body).not.toMatch(/PorterDirect/i);
    expect(await page.title()).not.toMatch(/PorterDirect/i);

    // The assertion that was missing, and the leak it would have caught: the page
    // embedded the storage provider's signed URL, so `.../porterdirect-pod/tenants/<id>/`
    // sat in a `src` attribute. The visible text read as the operator's while the markup
    // named us, and `innerText` cannot see an attribute. On a white-label surface the
    // question is about the whole response, not the words a person reads.
    const html = (await res!.text());
    expect(html, "our name appears in the markup").not.toMatch(/porterdirect/i);

    // Nor may any image be fetched from somewhere that names us.
    const sources = await page.locator("img").evaluateAll((els) =>
      els.map((e) => (e as HTMLImageElement).getAttribute("src") ?? ""),
    );
    for (const src of sources) {
      expect(src, `image src leaks: ${src}`).not.toMatch(/porterdirect|neon\.tech|storage/i);
    }
  });

  test("refuses an unknown token or an invented image kind", async ({ page }) => {
    // The image route is proxied so the customer's browser never learns where the bytes
    // live — asserted above, on the `src` attributes, which is where the leak was.
    //
    // The 200 path is deliberately NOT asserted here. Serving a real image needs a real
    // object in the bucket, and seeding one would make the browser suite depend on live
    // storage credentials. This project already learned that lesson from the breach
    // check: a live third-party call inside a test path produces a moving failure that
    // reads like a product fault. The round trip is covered by the storage tests and was
    // verified by hand against the real bucket.
    expect((await page.request.get(`/t/${"z".repeat(32)}/photo`)).status()).toBe(404);
    expect((await page.request.get(`/t/${token}/passport`)).status()).toBe(404);
    // A job with no proof has no image, and says so the same way.
    expect((await page.request.get(`/t/${token}/photo`)).status()).toBe(404);
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
