/**
 * The driver surface, in a browser, at phone size.
 *
 * This exists because "a driver can use the console" was true and misleading. The console
 * is a place to sit down and decide things across many jobs; a driver is standing at a
 * door holding a parcel. The difference is not cosmetic, and the things that make it a
 * driver's screen — no price, no audit trail, targets sized for a thumb — are exactly the
 * kind of thing that erodes silently as the page gets edited.
 *
 * Every assertion here is about what is ABSENT or how big something is, because those are
 * the properties nothing else in the suite protects.
 */
import { expect, test, type Page } from "@playwright/test";
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
const RUN_DOMAIN = `e2e-drive-${RUN}.test`;
const PASSWORD = "correct-horse-battery-staple";
/** A small, real phone. What works at 390 works everywhere above it. */
const PHONE = { width: 390, height: 844 };

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
let userId = "";
let jobId = "";

test.describe("the driver surface", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const ctx = await playwright.request.newContext({ baseURL: baseURL ?? "http://localhost:3000" });
    const res = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `driver@${RUN_DOMAIN}`, password: PASSWORD, name: "Test Driver" },
    });
    expect(res.ok(), `sign-up failed: ${res.status()}`).toBeTruthy();
    const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };
    userId = session.user?.id ?? "";
    await ctx.dispose();

    const [t] = await db
      .insert(tenants)
      .values({ name: `Drive ${RUN}`, primaryHost: `drive-${RUN}.test`, defaultCountry: "US" })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });
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

  async function signIn(page: Page): Promise<void> {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(`driver@${RUN_DOMAIN}`);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|welcome)/);
  }

  /** Raise a job through the board and assign it to this driver. */
  async function seedJob(page: Page): Promise<string> {
    await page.goto(`/dashboard/${tenantId}/orders`);
    await page.getByLabel("First name").fill("Marisol");
    await page.getByLabel("Last name").fill("Vega");
    await page.getByLabel("Phone").fill("2133734253");
    const pickup = page.locator("fieldset.group-pickup");
    await pickup.getByLabel("Street address").fill("811 W 7th St");
    await pickup.getByLabel("City").fill("Los Angeles");
    await pickup.getByLabel("State").fill("CA");
    await pickup.getByLabel("ZIP code").fill("90017");
    const dropoff = page.locator("fieldset.group-dropoff");
    await dropoff.getByLabel("Street address").fill("1355 N Highland Ave");
    await dropoff.getByLabel("City").fill("Los Angeles");
    await dropoff.getByLabel("State").fill("CA");
    await dropoff.getByLabel("ZIP code").fill("90028");
    await page.getByLabel("Price").fill("48.50");
    await page.getByRole("button", { name: "Create job" }).click();

    const row = page.locator("tr").filter({ hasText: "Marisol Vega" });
    await expect(row).toBeVisible();
    const href = await row.locator("a.ref-link").getAttribute("href");
    const id = href!.split("/").pop()!;
    // Assign to this driver so it reaches their board.
    await db.update(orders).set({ assignedUserId: userId }).where(eq(orders.id, id));
    return id;
  }

  test("lists the driver's own jobs, keyed on where they are going", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    jobId = await seedJob(page);

    await page.goto(`/drive/${tenantId}`);
    const card = page.locator("a.drive-card").first();
    await expect(card).toBeVisible();
    // The DESTINATION is the headline — the one thing a driver is scanning for.
    await expect(card).toContainText("1355 N Highland Ave");
  });

  test("shows no price and no audit trail", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    await page.goto(`/drive/${tenantId}/${jobId}`);

    const body = await page.locator("body").innerText();
    // A driver does not collect the money, and showing it invites a conversation at the
    // door they have no authority to have.
    expect(body).not.toContain("48.50");
    // The chain-of-custody trail answers disputes in an office, not "where am I going".
    expect(body).not.toContain("chain-of-custody");
  });

  test("offers one tap to navigate and one to call", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    await page.goto(`/drive/${tenantId}/${jobId}`);

    // These are the payoff of storing E.164 phones and STRUCTURED addresses: a dialable
    // link and a maps query built from real parts rather than a free-text line.
    const tel = page.locator('a[href^="tel:"]');
    await expect(tel).toHaveCount(1);
    await expect(tel).toHaveAttribute("href", /^tel:\+1\d{10}$/);
    await expect(page.locator('a[href*="google.com/maps"]')).toHaveCount(1);
  });

  test("every target is sized for a thumb", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    await page.goto(`/drive/${tenantId}/${jobId}`);

    // 44px is the floor (WCAG 2.5.5); this surface is used one-handed while holding
    // something, so its own controls aim higher. Next's dev-tools button is excluded —
    // it is the framework's, only present in development, and not ours to size.
    const targets = page.locator("a.btn, a.drive-card, form button");
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const el = targets.nth(i);
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      const label = (await el.innerText()).replace(/\s+/g, " ").slice(0, 30);
      expect(box!.height, `"${label}" is ${Math.round(box!.height)}px`).toBeGreaterThanOrEqual(44);
    }
  });

  test("never scrolls sideways on a phone", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    for (const url of [`/drive/${tenantId}`, `/drive/${tenantId}/${jobId}`]) {
      await page.goto(url);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, url).toBeLessThanOrEqual(PHONE.width);
    }
  });

  test("a driver-only member is routed to /drive, not the console", async ({
    page,
    playwright,
    baseURL,
  }) => {
    // The gap this closes: every entry point used to send everyone to the console, so a
    // driver's first experience of the product was a dispatcher's screen and /drive was
    // reachable only by being told the URL — a built surface nobody could find.
    const base = baseURL ?? "http://localhost:3000";
    const driverEmail = `only-driver@${RUN_DOMAIN}`;

    const ctx = await playwright.request.newContext({ baseURL: base });
    const res = await ctx.post("/api/auth/sign-up/email", {
      data: { email: driverEmail, password: PASSWORD, name: "Only Driver" },
    });
    expect(res.ok(), `sign-up failed: ${res.status()}`).toBeTruthy();
    const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };
    const onlyDriverId = session.user?.id ?? "";
    await ctx.dispose();

    // A member whose ONLY role is driver — the shape an invited driver ends up in.
    await db.insert(tenantMembers).values({ tenantId, userId: onlyDriverId, role: "driver" });

    await page.setViewportSize(PHONE);
    await page.goto("/signin");
    await page.getByLabel("Email").fill(driverEmail);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Wait for the sign-in to LAND before navigating. Going straight to /dashboard raced
    // the session cookie and arrived unauthenticated, which looks like a routing failure
    // and is a missing await.
    await page.waitForURL(/\/(welcome|dashboard|drive)/);

    // The generic "take me home" entry point must land them on their own surface.
    await page.goto("/dashboard");
    await page.waitForURL(new RegExp(`/drive/${tenantId}$`));
    expect(page.url()).toContain(`/drive/${tenantId}`);
    await expect(page.locator("body")).not.toContainText("New job");
  });

  test("refuses a job belonging to someone else", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page);
    // Deep-linking is governed by the same rule the console uses, not by the surface.
    await page.goto(`/drive/${tenantId}/00000000-0000-0000-0000-000000000000`);
    await expect(page.locator("body")).not.toContainText("Navigate");
  });
});
