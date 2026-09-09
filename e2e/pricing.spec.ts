/**
 * The rate card, in a browser.
 *
 * A rate card is the one screen in the console where a typo is money: a mis-parsed
 * "12,34" or a 700% driver share prices every job the portal quotes after it. So the
 * assertions here are about what an OPERATOR sees when they get it wrong — a form
 * message they can act on, and the previously saved card still intact — rather than
 * about the arithmetic, which is covered deterministically in the pricing package.
 *
 * The other half is a permission boundary that is invisible in unit tests: a dispatcher
 * moves work, they do not set what the firm charges, and the only way to be sure the
 * panel is absent for them is to render the page as one.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDbClient, tenantMembers, tenants, users, type Db } from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const RUN_DOMAIN = `e2e-price-${RUN}.test`;
const PASSWORD = "correct-horse-battery-staple";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const match = /^DATABASE_URL=(.*)$/m.exec(text);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const DB_URL = databaseUrl();

let db: Db;
let tenantId = "";
let ownerId = "";
let dispatcherId = "";

/**
 * Sign in, then go to the console.
 *
 * Deliberately does NOT wait for `/dashboard`: `signInAction` always lands on `/welcome`,
 * which is the page that reads the DATABASE to decide what this account has. A tenant
 * seeded without a subscription — which is every tenant in this suite, because creating
 * one would mean creating a real Stripe customer — legitimately stops there.
 *
 * Written the other way first, and it timed out waiting for a dashboard that was never
 * coming. That was the test's assumption being wrong, not the product's routing.
 */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/signin");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(welcome|dashboard|drive)/),
    page.locator('button[type="submit"]').click(),
  ]);
}

test.describe("the operator's rate card", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const base = baseURL ?? "http://localhost:3000";

    // Sign up through the real endpoint but provision the tenant directly, so no Stripe
    // customer is created. Four real customers leaked from an e2e run once.
    const make = async (local: string): Promise<string> => {
      const ctx = await playwright.request.newContext({ baseURL: base });
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email: `${local}@${RUN_DOMAIN}`, password: PASSWORD, name: `Price ${local}` },
      });
      expect(res.ok(), `sign-up failed: HTTP ${res.status()}`).toBeTruthy();
      const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
        user?: { id?: string };
      };
      await ctx.dispose();
      const id = session.user?.id ?? "";
      expect(id, "no user id after sign-up").toBeTruthy();
      return id;
    };

    ownerId = await make("owner");
    dispatcherId = await make("dispatcher");

    const [tenant] = await db
      .insert(tenants)
      .values({ name: `Price ${RUN}`, primaryHost: `price-${RUN}.test`, defaultCountry: "US" })
      .returning({ id: tenants.id });
    tenantId = tenant!.id;
    await db.insert(tenantMembers).values([
      { tenantId, userId: ownerId, role: "owner" },
      { tenantId, userId: dispatcherId, role: "dispatcher" },
    ]);
  });

  test.afterAll(async () => {
    // Scoped to what this run created. Cascades clear the rate card and membership.
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
    for (const id of [ownerId, dispatcherId]) {
      if (id) await db.delete(users).where(eq(users.id, id));
    }
  });

  test("an owner can save a rate card and sees it come back", async ({ page }) => {
    await signIn(page, `owner@${RUN_DOMAIN}`);
    await page.goto(`/dashboard/${tenantId}`);

    await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();

    await page.locator('input[name="fixed_pickup_base"]').fill("8.00");
    await page.locator('input[name="fixed_pickup_perMile"]').fill("2.50");
    await page.locator('input[name="fixed_pickup_minimum"]').fill("15.00");
    await page.locator('input[name="scheduled_courier_base"]').fill("15.00");
    await page.locator('input[name="scheduled_courier_perMile"]').fill("3.00");
    await page.locator('input[name="scheduled_courier_minimum"]').fill("25.00");
    await page.locator('input[name="driverPayPercent"]').fill("65");
    await page.locator('input[name="maxQuotableMiles"]').fill("50");

    await Promise.all([
      page.waitForURL(/priced=1/),
      page.getByRole("button", { name: "Save rate card" }).click(),
    ]);

    await expect(page.locator("p.notice")).toContainText("Rate card saved");
    // The round trip an operator actually judges: the numbers they typed, back in the
    // boxes. A form that saves correctly and redisplays blanks reads as a failed save.
    await expect(page.locator('input[name="fixed_pickup_perMile"]')).toHaveValue("2.50");
    await expect(page.locator('input[name="driverPayPercent"]')).toHaveValue("65");
    await expect(page.locator('input[name="maxQuotableMiles"]')).toHaveValue("50");
  });

  test("a nonsense driver share is refused as a message, not a runtime error", async ({ page }) => {
    await signIn(page, `owner@${RUN_DOMAIN}`);
    const res = await page.goto(`/dashboard/${tenantId}`);
    expect(res?.status(), "console did not render").toBe(200);

    // 700 is the plausible typo of 70, and it would pay out more than was charged on
    // every job. The status code is the version-proof signal that nothing threw — a
    // server component that throws returns 5xx whatever the error overlay is called.
    await page.locator('input[name="driverPayPercent"]').fill("700");
    await Promise.all([
      page.waitForURL(/priceError=/),
      page.getByRole("button", { name: "Save rate card" }).click(),
    ]);

    await expect(page.locator("p.error")).toBeVisible();
    await expect(page.locator("p.error")).toContainText(/more than was charged/i);

    // And the card that was already saved is untouched.
    await expect(page.locator('input[name="driverPayPercent"]')).toHaveValue("65");
  });

  test("an unreadable amount names the field rather than failing opaquely", async ({ page }) => {
    await signIn(page, `owner@${RUN_DOMAIN}`);
    await page.goto(`/dashboard/${tenantId}`);

    await page.locator('input[name="fixed_pickup_base"]').fill("eight dollars");
    await Promise.all([
      page.waitForURL(/priceError=/),
      page.getByRole("button", { name: "Save rate card" }).click(),
    ]);
    await expect(page.locator("p.error")).toContainText(/Base fare/i);
  });

  test("a dispatcher never sees the pricing panel", async ({ page }) => {
    await signIn(page, `dispatcher@${RUN_DOMAIN}`);
    const res = await page.goto(`/dashboard/${tenantId}`);
    expect(res?.status()).toBe(200);

    // Present for the owner in the first test, absent here — so this asserts a boundary
    // rather than a selector that never matches anything.
    await expect(page.getByRole("heading", { name: "Pricing" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Customer accounts" })).toHaveCount(0);
    await expect(page.locator('input[name="driverPayPercent"]')).toHaveCount(0);
  });

  test("customer registration is invite-only until someone changes it", async ({ page }) => {
    await signIn(page, `owner@${RUN_DOMAIN}`);
    await page.goto(`/dashboard/${tenantId}`);

    // The safe default, and the reason the control exists at all: a setting nobody can
    // change is a hardcoded value wearing a configuration costume.
    await expect(page.locator('select[name="mode"]')).toHaveValue("invite_only");

    await page.locator('select[name="mode"]').selectOption("open");
    await Promise.all([
      page.waitForURL(/signup=open/),
      page.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    await expect(page.locator('select[name="mode"]')).toHaveValue("open");
  });

  test("the pricing form is usable on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, `owner@${RUN_DOMAIN}`);
    await page.goto(`/dashboard/${tenantId}`);

    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrolls, "the page scrolls sideways at 390px").toBe(false);

    // 44px is the floor, and a "secondary" control is not exempt — a smaller target
    // misfires identically, and this one sets what the firm charges.
    const save = page.getByRole("button", { name: "Save rate card" });
    const box = await save.boundingBox();
    expect(box, "save button not rendered").not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const percent = page.locator('input[name="driverPayPercent"]');
    const pbox = await percent.boundingBox();
    expect(pbox!.height).toBeGreaterThanOrEqual(44);
    // Below 16px, mobile Safari zooms the whole page the moment this is focused.
    //
    // Not `parseFloat`, which is banned repo-wide because it is how money becomes a
    // float. A font size is not money, but taking the exemption would put the banned
    // call in the codebase for the next reader to copy — and `getComputedStyle` always
    // returns pixels, so there is nothing to parse loosely.
    const size = await percent.evaluate((el) => Number(getComputedStyle(el).fontSize.replace("px", "")));
    expect(size).toBeGreaterThanOrEqual(16);
  });
});
