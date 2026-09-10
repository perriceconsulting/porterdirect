/**
 * A refused signup must leave NOTHING behind.
 *
 * This spec exists because the unit test for the same fix is not sufficient, and finding
 * that out was the useful part. `validateProvisionInput` has its own tests and they all
 * pass — but deleting the CALL to it from `signUpAction` leaves every one of them green.
 * The function was never the guarantee; the ORDER of the two steps inside the action is,
 * and only a real form post followed by a database read can assert that.
 *
 * Same lesson this repo already recorded when a race test kept passing after the
 * pre-check was restored, because the unique index was still doing the work: a guard
 * proven by reverting the wrong layer proves nothing.
 *
 * The defect being closed: the account was created and the host validated afterwards, so
 * a rejected host left an orphaned user — someone who could sign in to nothing, and who
 * could then never retry with their own address because it was already registered. It was
 * found on production, not here, because nothing in the suite asserted on absence.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDbClient, users, type Db } from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

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

test.describe("a refused signup creates no account", () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to assert on what was not created");

  test.beforeAll(() => {
    db = createDbClient(DB_URL);
  });

  /**
   * Every refusal that used to happen AFTER the account was created. A reserved host is
   * the one that bit in production; the others share the same code path and would have
   * left the same orphan.
   */
  const cases = [
    { label: "a reserved platform host", host: "app.porterdirect.com", error: /invalid-host/ },
    { label: "a malformed host", host: "not a host at all", error: /invalid-host/ },
  ];

  for (const [i, c] of cases.entries()) {
    test(`leaves no user behind for ${c.label}`, async ({ page }) => {
      const email = `orphan-${RUN}-${i}@example.test`;

      await page.goto("/signup");
      await page.locator('input[name="firstName"]').fill("Orphan");
      await page.locator('input[name="lastName"]').fill("Check");
      await page.getByLabel("Work email").fill(email);
      // A clean passphrase on purpose: it must get PAST the password check, so that the
      // only thing standing between this request and a created account is the ordering
      // fix under test. A weak password here would make the test pass for the wrong reason.
      await page.locator('input[name="password"]').fill("meadow lantern cobble drift");
      await page.getByLabel("Company name").fill("Orphan Check Ltd");
      await page.getByLabel("Your dispatch domain").fill(c.host);
      await page.getByRole("button", { name: "Continue to payment" }).click();

      await page.waitForURL(c.error, { timeout: 60_000 });

      // THE ASSERTION. Not "an error was shown" — that was true before the fix too.
      const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(rows, `signup was refused but left a user row for ${email}`).toHaveLength(0);
    });
  }

  test("the same address can still be used after a refusal", async ({ page }) => {
    // The consequence that actually hurt: an orphaned account made the address
    // unusable, so a person whose first attempt was refused could never sign up at all.
    const email = `retry-${RUN}@example.test`;

    for (const host of ["app.porterdirect.com", `retry-${RUN}.example.test`]) {
      await page.goto("/signup");
      await page.locator('input[name="firstName"]').fill("Retry");
      await page.locator('input[name="lastName"]').fill("Check");
      await page.getByLabel("Work email").fill(email);
      await page.locator('input[name="password"]').fill("meadow lantern cobble drift");
      await page.getByLabel("Company name").fill("Retry Check Ltd");
      await page.getByLabel("Your dispatch domain").fill(host);
      await page.getByRole("button", { name: "Continue to payment" }).click();
      await page.waitForURL(/error=|checkout\.stripe\.com|\/welcome/, { timeout: 60_000 });

      // The second attempt uses a valid host, so it must NOT fail with "email taken".
      // Before the fix it did, every time, because the first attempt had banked the email.
      expect(page.url(), `"${host}" reported the email as already registered`).not.toMatch(
        /error=email-taken/,
      );
    }
  });

  test.afterAll(async () => {
    // Scoped to this run's own addresses, read back by exact match — never a pattern
    // sweep. A loose LIKE has already destroyed a real account in this repo once.
    for (const email of [
      `orphan-${RUN}-0@example.test`,
      `orphan-${RUN}-1@example.test`,
      `retry-${RUN}@example.test`,
    ]) {
      await db.delete(users).where(eq(users.email, email));
    }
  });
});
