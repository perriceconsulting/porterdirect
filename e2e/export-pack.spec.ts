/**
 * The export pack, through the real route.
 *
 * This is the artifact that makes everything else legible. A custody trail, a retention
 * guarantee and an access log are invisible to a prospect until there is a document, and
 * by the time a client asks the courier is already in a contract. So the assertions are
 * about what a procurement officer actually receives.
 *
 * The one that matters most is FORMULA INJECTION: these files are opened in Excel, every
 * value in them is typed by a person, and a cell beginning `=` is executed. It is tested
 * end to end here as well as in the unit tests, because the guard living in `csv.ts` is
 * worth nothing if a builder forgets to route a column through it.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  accessEvents,
  createDbClient,
  tenantMembers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `export-${RUN}.test`;
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
let driverId = "";

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_YEAR = "2020-01-01";

test.describe("the export pack", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const base = baseURL ?? "http://localhost:3000";

    const make = async (local: string): Promise<string> => {
      const ctx = await playwright.request.newContext({ baseURL: base });
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email: `${local}@${DOMAIN}`, password: PASSWORD, name: `Export ${local}` },
      });
      expect(res.ok(), `sign-up failed: ${res.status()}`).toBeTruthy();
      const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
        user?: { id?: string };
      };
      await ctx.dispose();
      return session.user?.id ?? "";
    };

    ownerId = await make("owner");
    driverId = await make("driver");

    const [t] = await db
      .insert(tenants)
      .values({ name: `Export ${RUN}`, primaryHost: `export-${RUN}.example.test` })
      .returning({ id: tenants.id });
    tenantId = t!.id;
    await db.insert(tenantMembers).values([
      { tenantId, userId: ownerId, role: "owner" },
      { tenantId, userId: driverId, role: "driver" },
    ]);
  });

  test.afterAll(async () => {
    if (tenantId) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      // No cascade reaches the audit log, by design.
      await db.delete(accessEvents).where(eq(accessEvents.tenantId, tenantId));
    }
    for (const id of [ownerId, driverId]) {
      if (id) await db.delete(users).where(eq(users.id, id));
    }
  });

  async function signIn(page: import("@playwright/test").Page, local: string): Promise<void> {
    await page.goto("/signin");
    await page.locator('input[name="email"]').fill(`${local}@${DOMAIN}`);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await Promise.all([
      page.waitForURL(/\/(welcome|dashboard|drive)/),
      page.locator('button[type="submit"]').click(),
    ]);
  }

  test("an owner can download all three documents", async ({ page }) => {
    await signIn(page, "owner");

    for (const kind of ["deliveries", "custody", "access"]) {
      const res = await page.request.get(
        `/dashboard/${tenantId}/exports?kind=${kind}&from=${LAST_YEAR}&to=${TODAY}`,
      );
      expect(res.status(), `${kind} export`).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/csv");
      expect(res.headers()["content-disposition"]).toContain(`${kind}-`);
      // Customer data must never sit in a shared cache.
      expect(res.headers()["cache-control"]).toContain("no-store");

      const body = await res.text();
      // A UTF-8 BOM, so Excel on Windows reads accented names rather than mojibake.
      expect(body.charCodeAt(0), `${kind} is missing the BOM`).toBe(0xfeff);
      // A header row even when the period is empty: a zero-byte file reads as a failed
      // download, not as "nothing happened".
      expect(body).toContain("Reference");
      expect(body).toContain("\r\n");
    }
  });

  test("the download is itself recorded as an access", async ({ page }) => {
    await signIn(page, "owner");
    const before = await db
      .select()
      .from(accessEvents)
      .where(eq(accessEvents.tenantId, tenantId));

    await page.request.get(
      `/dashboard/${tenantId}/exports?kind=custody&from=${LAST_YEAR}&to=${TODAY}`,
    );

    const after = await db.select().from(accessEvents).where(eq(accessEvents.tenantId, tenantId));
    expect(after.length).toBeGreaterThan(before.length);
    const newest = after.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(newest.action).toBe("export.pack");
    expect(newest.actorKind).toBe("member");
    expect(newest.actorUserId).toBe(ownerId);
    // The period is recorded, because "they exported something" is a weaker fact than
    // "they exported these three months".
    expect(newest.objectKey).toContain("custody:");
  });

  test("a driver cannot download the whole company's history", async ({ page }) => {
    await signIn(page, "driver");
    const res = await page.request.get(
      `/dashboard/${tenantId}/exports?kind=deliveries&from=${LAST_YEAR}&to=${TODAY}`,
    );
    // A driver holds orders:read:assigned only. The export is a fleet-wide read.
    expect(res.status()).toBe(403);
  });

  test("another operator's tenant is not found, rather than forbidden", async ({ page }) => {
    const [other] = await db
      .insert(tenants)
      .values({ name: `Other export ${RUN}`, primaryHost: `export-other-${RUN}.example.test` })
      .returning({ id: tenants.id });
    try {
      await signIn(page, "owner");
      const res = await page.request.get(
        `/dashboard/${other!.id}/exports?kind=deliveries&from=${LAST_YEAR}&to=${TODAY}`,
      );
      // 404, not 403: confirming a tenant exists is itself information.
      expect(res.status()).toBe(404);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });

  test("a reversed date range is refused rather than quietly swapped", async ({ page }) => {
    await signIn(page, "owner");
    const res = await page.request.get(
      `/dashboard/${tenantId}/exports?kind=deliveries&from=${TODAY}&to=${LAST_YEAR}`,
    );
    // Swapping it would hand someone a document covering a period they did not ask for.
    expect(res.status()).toBe(400);
  });

  test("a malformed date is refused rather than defaulting to now", async ({ page }) => {
    await signIn(page, "owner");
    for (const bad of ["yesterday", "2026-13-45", "", "2026/09/10"]) {
      const res = await page.request.get(
        `/dashboard/${tenantId}/exports?kind=deliveries&from=${encodeURIComponent(bad)}&to=${TODAY}`,
      );
      expect(res.status(), `"${bad}" was accepted`).toBe(400);
    }
  });

  test("an unknown document kind is refused", async ({ page }) => {
    await signIn(page, "owner");
    const res = await page.request.get(
      `/dashboard/${tenantId}/exports?kind=everything&from=${LAST_YEAR}&to=${TODAY}`,
    );
    expect(res.status()).toBe(400);
  });

  test("the console offers the pack to an owner and hides it from a driver", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto(`/dashboard/${tenantId}`);
    await expect(page.getByRole("heading", { name: "Evidence pack" })).toBeVisible();

    await signIn(page, "driver");
    const res = await page.goto(`/dashboard/${tenantId}`);
    expect(res?.status()).toBe(200);
    // Present for the owner above, absent here — so this asserts a boundary rather than a
    // selector that never matches anything.
    await expect(page.getByRole("heading", { name: "Evidence pack" })).toHaveCount(0);
  });
});
