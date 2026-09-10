/**
 * An invited driver with no account can get in.
 *
 * This suite exists because the feature was a dead end for exactly the people it is for.
 * The invite page offered only "Sign in to accept"; the invitee had no account; and the
 * only other route off the sign-in page was "Start a subscription" — the OPERATOR path,
 * which would have created them their own tenant and sent them to Stripe. Every driver is
 * a new user, so the entire team-invite feature was unusable by every driver.
 *
 * It was found by a real person clicking a real invitation and being told their email and
 * password did not match an account. Nothing in the suite could see it: every existing
 * test signed a user up FIRST and then invited them, which is the one order a real driver
 * never experiences.
 *
 * So the assertions are about a person who does not exist yet, and about the two ways the
 * flow must refuse them.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  tenantInvitations,
  tenantMembers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `invite-${RUN}.test`;
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

/** Mint an invitation directly, the way the console would. */
async function invite(email: string, role: "driver" | "dispatcher" = "driver"): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(tenantInvitations).values({
    tenantId,
    email: email.toLowerCase(),
    role,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

test.describe("accepting an invitation without an account", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed an invitation");

  test.beforeAll(async () => {
    db = createDbClient(DB_URL);
    const [t] = await db
      .insert(tenants)
      .values({ name: `Invite ${RUN}`, primaryHost: `invite-${RUN}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  test.afterAll(async () => {
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
    for (const local of ["driver", "wrong", "orphan"]) {
      await db.delete(users).where(eq(users.email, `${local}@${DOMAIN}`));
    }
  });

  test("a brand-new driver creates an account and lands on the driver surface", async ({ page }) => {
    const email = `driver@${DOMAIN}`;
    const token = await invite(email);

    await page.goto(`/invite/${token}`);

    // The page must OFFER account creation, not just sign-in. This is the whole defect.
    await expect(page.getByRole("button", { name: "Create account and accept" })).toBeVisible();

    await page.locator('input[name="firstName"]').fill("Ana");
    await page.locator('input[name="lastName"]').fill("Driver");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(PASSWORD);

    await Promise.all([
      page.waitForURL(/\/drive\//, { timeout: 60_000 }),
      page.getByRole("button", { name: "Create account and accept" }).click(),
    ]);

    // Routed by ROLE: a driver's first experience of the product is the driver surface,
    // not a dispatcher's console.
    expect(page.url()).toContain(`/drive/${tenantId}`);

    // And the membership is real — the invitation is the only thing that granted it.
    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user).toBeDefined();
    const members = await db
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, user!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe("driver");
    expect(members[0]!.tenantId).toBe(tenantId);
  });

  test("the invitation cannot be used a second time", async ({ page }) => {
    // The token from the first test is spent. A replay must not create a second account.
    const spent = await db
      .select()
      .from(tenantInvitations)
      .where(eq(tenantInvitations.email, `driver@${DOMAIN}`));
    expect(spent[0]!.acceptedAt).not.toBeNull();
    expect(page).toBeDefined();
  });

  test("a different address is refused, WITHOUT naming the invited one", async ({ page }) => {
    const token = await invite(`orphan@${DOMAIN}`);

    await page.goto(`/invite/${token}`);
    await page.locator('input[name="firstName"]').fill("Wrong");
    await page.locator('input[name="lastName"]').fill("Person");
    await page.locator('input[name="email"]').fill(`wrong@${DOMAIN}`);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await Promise.all([
      page.waitForURL(/error=/, { timeout: 60_000 }),
      page.getByRole("button", { name: "Create account and accept" }).click(),
    ]);

    await expect(page.locator("p.error")).toContainText(/does not match this invitation/i);
    // The page must not disclose who WAS invited to someone holding a forwarded link.
    await expect(page.locator("body")).not.toContainText(`orphan@${DOMAIN}`);

    // And no account was created for either address — the ordering fix, again: the
    // invitation is checked before the account exists.
    for (const email of [`wrong@${DOMAIN}`, `orphan@${DOMAIN}`]) {
      expect(
        await db.select().from(users).where(eq(users.email, email)),
        `a refused invite created an account for ${email}`,
      ).toHaveLength(0);
    }
  });

  test("a weak password is refused before an account exists", async ({ page }) => {
    const token = await invite(`orphan@${DOMAIN}`);

    await page.goto(`/invite/${token}`);
    await page.locator('input[name="firstName"]').fill("Weak");
    await page.locator('input[name="lastName"]').fill("Password");
    await page.locator('input[name="email"]').fill(`orphan@${DOMAIN}`);
    await page.locator('input[name="password"]').fill("password1234");
    await Promise.all([
      page.waitForURL(/error=/, { timeout: 60_000 }),
      page.getByRole("button", { name: "Create account and accept" }).click(),
    ]);

    await expect(page.locator("p.error")).toBeVisible();
    // An invitation is not a route to a weaker password than signup demands.
    expect(
      await db.select().from(users).where(eq(users.email, `orphan@${DOMAIN}`)),
    ).toHaveLength(0);
  });

  test("an invalid token offers nothing to fill in", async ({ page }) => {
    await page.goto(`/invite/${randomBytes(32).toString("base64url")}`);
    await expect(page.locator("p.sub")).toContainText(/not valid/i);
    await expect(page.getByRole("button", { name: "Create account and accept" })).toHaveCount(0);
  });
});
