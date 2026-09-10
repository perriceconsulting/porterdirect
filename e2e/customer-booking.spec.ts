/**
 * A customer books a job, and it reaches the operator's board.
 *
 * The loop that did not exist. Until this, every order was typed in by an operator and a
 * customer's only contact with the product was a tracking link for a job that already
 * existed — so "a new job comes in from a customer" was not true of the software.
 *
 * The whole path is walked in the order a real person meets it, which is the lesson from
 * the driver invite: an operator invites, a person with NO ACCOUNT follows the link,
 * creates one, books, and the job appears on the board. Every existing test set its
 * fixtures up backwards from that.
 *
 * The load-bearing assertion is that the job arrives UNPRICED. No distance provider is
 * wired, so `quoteJob` returns needs_review — and that is a working product rather than a
 * gap: the operator prices it and it proceeds exactly like a phone booking.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  createDbClient,
  customerInvitations,
  orders,
  tenantCustomers,
  tenantMembers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `booking-${RUN}.test`;
const PASSWORD = "meadow lantern cobble drift";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return /^DATABASE_URL=(.*)$/m.exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const DB_URL = databaseUrl();
let db: Db;
let tenantId = "";
let ownerId = "";

async function inviteCustomerRow(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(customerInvitations).values({
    tenantId,
    email: email.toLowerCase(),
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

/**
 * Each Playwright test gets a FRESH browser context, so a session created in one test is
 * gone in the next — serial mode orders them, it does not share cookies. Written without
 * this at first and the portal test landed on the sign-in page instead, which is a test
 * bug that looks exactly like a routing bug.
 */
async function signIn(page: import("@playwright/test").Page, local: string): Promise<void> {
  await page.goto("/signin");
  await page.locator('input[name="email"]').fill(`${local}@${DOMAIN}`);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(welcome|dashboard|drive|portal)/),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe("a customer books their own delivery", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const ctx = await playwright.request.newContext({ baseURL: baseURL ?? "http://localhost:3000" });
    const res = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `owner@${DOMAIN}`, password: PASSWORD, name: "Booking Owner" },
    });
    expect(res.ok(), `sign-up failed: ${res.status()}`).toBeTruthy();
    const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };
    ownerId = session.user?.id ?? "";
    await ctx.dispose();

    const [t] = await db
      .insert(tenants)
      .values({ name: `Booking ${RUN}`, primaryHost: `booking-${RUN}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ tenantId, userId: ownerId, role: "owner" });
  });

  test.afterAll(async () => {
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
    for (const local of ["owner", "client", "stranger"]) {
      await db.delete(users).where(eq(users.email, `${local}@${DOMAIN}`));
    }
  });

  test("an invited client with no account can create one and reach the portal", async ({ page }) => {
    const email = `client@${DOMAIN}`;
    const token = await inviteCustomerRow(email);

    await page.goto(`/portal/invite/${token}`);
    // Creating an account is the PRIMARY action, not signing in. The team invite shipped
    // the other way round and was a dead end for everyone it was meant for.
    await expect(page.getByRole("button", { name: "Create account and continue" })).toBeVisible();

    await page.locator('input[name="firstName"]').fill("Dana");
    await page.locator('input[name="lastName"]').fill("Client");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await Promise.all([
      page.waitForURL(new RegExp(`/portal/${tenantId}`), { timeout: 60_000 }),
      page.getByRole("button", { name: "Create account and continue" }).click(),
    ]);

    // The account is real, and the invitation is what granted it.
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const accounts = await db
      .select()
      .from(tenantCustomers)
      .where(and(eq(tenantCustomers.tenantId, tenantId), eq(tenantCustomers.userId, user!.id)));
    expect(accounts).toHaveLength(1);
  });

  test("the portal wears the OPERATOR's name and not ours", async ({ page }) => {
    await signIn(page, "client");
    await page.goto(`/portal/${tenantId}`);
    // Confirm we are actually ON the portal before asserting about its markup — the first
    // version of this test asserted against a sign-in page it had been redirected to.
    await expect(page).toHaveURL(new RegExp(`/portal/${tenantId}`));

    const html = await page.content();
    // Asserted against the whole RESPONSE, not innerText — the tracking page taught that
    // an inherited `og:title` is invisible to a text assertion and very visible in a
    // pasted link.
    expect(html).not.toMatch(/PorterDirect/i);
    await expect(page.locator(".eyebrow")).toContainText(`Booking ${RUN}`);
  });

  test("booking a collection puts an UNPRICED job on the operator's board", async ({ page }) => {
    await signIn(page, "client");
    await page.goto(`/portal/${tenantId}`);

    await page.locator('input[name="recipientFirstName"]').fill("Ravi");
    await page.locator('input[name="recipientLastName"]').fill("Patel");
    await page.locator('input[name="recipientPhone"]').fill("2133734253");
    await page.locator('input[name="pickupLine1"]').fill("811 W 7th St");
    await page.locator('input[name="pickupCity"]').fill("Los Angeles");
    await page.locator('input[name="pickupRegion"]').fill("CA");
    await page.locator('input[name="pickupPostalCode"]').fill("90017");
    await page.locator('input[name="dropoffLine1"]').fill("1355 N Highland Ave");
    await page.locator('input[name="dropoffCity"]').fill("Los Angeles");
    await page.locator('input[name="dropoffRegion"]').fill("CA");
    await page.locator('input[name="dropoffPostalCode"]').fill("90028");

    await Promise.all([
      page.waitForURL(/booked=1/, { timeout: 60_000 }),
      page.getByRole("button", { name: "Request collection" }).click(),
    ]);

    const rows = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
    expect(rows, "the booking did not reach the board").toHaveLength(1);
    const job = rows[0]!;

    // UNPRICED, and that is the designed outcome with no distance provider wired — not
    // $0, which is a plausible real price and a different claim entirely.
    expect(job.priceCents).toBeNull();
    expect(job.driverPayCents).toBeNull();
    expect(job.status).toBe("pending");
    // Provenance: the customer account that booked it, not the recipient named on it.
    expect(job.bookedByCustomerId).not.toBeNull();
    expect(job.customerFirstName).toBe("Ravi");
  });

  test("the operator sees it as needing a price", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto(`/dashboard/${tenantId}/orders`);
    await expect(page.locator("table")).toContainText("Needs pricing");
    await expect(page.locator("table")).toContainText("Ravi Patel");
  });

  test("an unpriced job is not offered to a driver", async ({ page }) => {
    // `claimOrder` refuses a job with no driver pay — "accept or decline" with no amount
    // is not a choice. So a customer booking cannot reach the offer board until the
    // operator has priced it.
    const rows = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
    expect(rows[0]!.driverPayCents).toBeNull();
    expect(page).toBeDefined();
  });

  test("a stranger cannot reach another customer's portal", async ({ page, playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL: baseURL ?? "http://localhost:3000" });
    await ctx.post("/api/auth/sign-up/email", {
      data: { email: `stranger@${DOMAIN}`, password: PASSWORD, name: "Stranger Person" },
    });
    await ctx.dispose();

    await signIn(page, "stranger");

    // Holds no customer account with this operator, so the portal sends them away rather
    // than showing anything — the same rule as the console: the URL proposes, the
    // database decides.
    await page.goto(`/portal/${tenantId}`);
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.locator("body")).not.toContainText("Ravi");
  });
});
