/**
 * PHAST — assignment isolation under concurrency, in REAL browsers.
 *
 * A new pillar, and it exists because the driver surface introduced a scoping question
 * the tenant spec cannot answer. Tenant isolation asks "does licensee A ever see
 * licensee B's data". This asks the harder one INSIDE a single tenant: does driver A
 * ever see driver B's job, when both are signed in and loading at the same moment?
 *
 * That is a concurrency question rather than a logic one. The predicate is in the query
 * and unit-tested, so a single-threaded pass proves nothing new — what could still bleed
 * is a session, a cached render, or a memoised request context, and none of those show
 * up until two people load the same route simultaneously.
 *
 * Browsers rather than request contexts, unlike the tenant spec: this pillar is about
 * what is PAINTED. A driver seeing another driver's address in a rendered page is the
 * failure, and a JSON body would not exercise the render path or the router cache.
 *
 * Run `npm run phast:headed` to watch it happen.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
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
const RUN_DOMAIN = `phast-drv-${RUN}.test`;
const PASSWORD = "correct-horse-battery-staple";

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

/**
 * Three drivers in ONE tenant, each with a job at a distinctive address.
 *
 * Distinctive on purpose: a leak has to be unambiguous in the assertion. "Saw the wrong
 * street" is a finding; "saw a job" is not.
 */
const DRIVERS = [
  { key: "ana", street: "1355 N Highland Ave", userId: "", orderId: "" },
  { key: "bea", street: "600 Montgomery St", userId: "", orderId: "" },
  { key: "cal", street: "30 Rockefeller Plaza", userId: "", orderId: "" },
];

let db: Db;
let tenantId = "";

// The phast project defaults to `accept: application/json` for the API-shaped specs.
// This pillar is about what gets PAINTED, so it asks for HTML like a browser would.
test.use({ extraHTTPHeaders: {} });

test.describe("driver assignment isolation under concurrency", () => {
  // Several browser contexts signing in and fanning out blows Playwright's 30s default,
  // and the resulting "Test ended" reads like a product failure while being a harness
  // limit (CLAUDE.md).
  test.describe.configure({ timeout: 180_000, mode: "serial" });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const base = baseURL ?? "http://localhost:3000";

    const [t] = await db
      .insert(tenants)
      .values({ name: `phast drv ${RUN}`, primaryHost: `phastdrv-${RUN}.test`, defaultCountry: "US" })
      .returning({ id: tenants.id });
    tenantId = t!.id;

    for (const d of DRIVERS) {
      const ctx = await playwright.request.newContext({ baseURL: base });
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email: `${d.key}@${RUN_DOMAIN}`, password: PASSWORD, name: d.key },
      });
      expect(res.ok(), `sign-up failed for ${d.key}`).toBeTruthy();
      const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
        user?: { id?: string };
      };
      d.userId = session.user?.id ?? "";
      expect(d.userId, `no user id for ${d.key}`).toBeTruthy();
      await ctx.dispose();

      // All three are DRIVERS in the SAME tenant. Tenant isolation cannot help here —
      // they are legitimately in the same tenant. Only assignment separates them.
      await db.insert(tenantMembers).values({ tenantId, userId: d.userId, role: "driver" });

      const [o] = await db
        .insert(orders)
        .values({
          tenantId,
          reference: `PH-${d.key.toUpperCase()}${RUN.slice(0, 4)}`,
          type: "fixed_pickup",
          status: "assigned",
          customerFirstName: "Cust",
          customerLastName: d.key,
          pickupLine1: "811 W 7th St",
          pickupCity: "Los Angeles",
          pickupRegion: "CA",
          pickupPostalCode: "90017",
          pickupCountry: "US",
          dropoffLine1: d.street,
          dropoffCity: "Los Angeles",
          dropoffRegion: "CA",
          dropoffPostalCode: "90028",
          dropoffCountry: "US",
          priceCents: 4850,
          assignedUserId: d.userId,
        })
        .returning({ id: orders.id });
      d.orderId = o!.id;
    }
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

  /** A signed-in page for one driver, in its own browser context (its own cookie jar). */
  async function pageFor(browser: Browser, key: string): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(`${key}@${RUN_DOMAIN}`);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/(welcome|dashboard|drive)/);
    return page;
  }

  test("each driver's board shows only their own job when all load CONCURRENTLY", async ({
    browser,
  }) => {
    const pages = await Promise.all(DRIVERS.map((d) => pageFor(browser, d.key)));

    // The whole point: fired together, not one after another.
    await Promise.all(pages.map((p) => p.goto(`/drive/${tenantId}`)));
    const bodies = await Promise.all(pages.map((p) => p.locator("main").innerText()));

    for (const [i, body] of bodies.entries()) {
      const mine = DRIVERS[i]!;
      expect(body, `${mine.key} cannot see their own job`).toContain(mine.street);
      for (const other of DRIVERS.filter((d) => d.key !== mine.key)) {
        expect(body, `LEAK: ${mine.key} saw ${other.key}'s address`).not.toContain(other.street);
      }
    }

    await Promise.all(pages.map((p) => p.context().close()));
  });

  test("holds under a sustained burst of interleaved loads", async ({ browser }) => {
    // The tenant spec learned this the hard way: a leak from a lazily-warmed cache is
    // INVISIBLE on the first round. All three actors fire before the cache populates, so
    // the single pass above passes while the bug is present. Repetition is the test.
    const pages = await Promise.all(DRIVERS.map((d) => pageFor(browser, d.key)));

    for (let round = 0; round < 4; round++) {
      await Promise.all(pages.map((p) => p.goto(`/drive/${tenantId}`)));
      const bodies = await Promise.all(pages.map((p) => p.locator("main").innerText()));
      for (const [i, body] of bodies.entries()) {
        const mine = DRIVERS[i]!;
        expect(body, `round ${round}: ${mine.key} lost their own job`).toContain(mine.street);
        for (const other of DRIVERS.filter((d) => d.key !== mine.key)) {
          expect(
            body,
            `LEAK on round ${round}: ${mine.key} saw ${other.key}'s address`,
          ).not.toContain(other.street);
        }
      }
    }

    await Promise.all(pages.map((p) => p.context().close()));
  });

  test("a driver cannot open another driver's job by URL, even under load", async ({
    browser,
  }) => {
    // Deep links are governed by the same rule as the list. Guessing a job id is not the
    // threat — a forwarded link is.
    const pages = await Promise.all(DRIVERS.map((d) => pageFor(browser, d.key)));

    await Promise.all(
      pages.map((p, i) => {
        const victim = DRIVERS[(i + 1) % DRIVERS.length]!;
        return p.goto(`/drive/${tenantId}/${victim.orderId}`);
      }),
    );

    for (const [i, p] of pages.entries()) {
      const victim = DRIVERS[(i + 1) % DRIVERS.length]!;
      const body = await p.locator("body").innerText();
      expect(body, `LEAK: ${DRIVERS[i]!.key} opened ${victim.key}'s job`).not.toContain(
        victim.street,
      );
    }

    await Promise.all(pages.map((p) => p.context().close()));
  });

  test("a driver's page is not stored by a shared cache", async ({ browser }) => {
    // A per-driver page cached by a proxy or the browser's bfcache and served to the next
    // driver is the same leak arriving through infrastructure rather than through code.
    const page = await pageFor(browser, "ana");
    const res = await page.goto(`/drive/${tenantId}`);
    const cc = res?.headers()["cache-control"] ?? "";
    expect(cc, `cache-control was "${cc}"`).toMatch(/no-store|no-cache|private/);
    await page.context().close();
  });
});
