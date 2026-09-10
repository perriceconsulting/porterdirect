/**
 * Closing a job, and re-attempting one that failed — in a browser.
 *
 * This suite exists because of a defect that every one of 323 unit tests was blind to:
 * the order page picked its status colour with `isTerminal(status)`, which is true of
 * delivered, cancelled AND failed. A job that never arrived rendered in the same success
 * green as a delivered one. The rule was right, the state machine was right, the reason
 * was recorded correctly — and the page told the operator the opposite of the truth.
 *
 * So the assertions here are about what an operator SEES: the colour of the outcome, the
 * refusal when no reason is given, and the fact that a failed job is re-attempted as a
 * new job rather than by reopening the old one.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import {
  createDbClient,
  orders,
  tenantMembers,
  tenants,
  users,
  type Db,
} from "@porterdirect/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const RUN_DOMAIN = `e2e-close-${RUN}.test`;
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
let userId = "";
/** en_route — the page that offers the closing moves. */
let liveOrderId = "";
/** already failed — the page that offers re-dispatch. */
let failedOrderId = "";

test.describe("closing and re-dispatching a job", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  test.skip(!DB_URL, "DATABASE_URL is required to seed a tenant");

  test.beforeAll(async ({ playwright, baseURL }) => {
    db = createDbClient(DB_URL);
    const base = baseURL ?? "http://localhost:3000";
    const ctx = await playwright.request.newContext({ baseURL: base });

    const signUp = await ctx.post("/api/auth/sign-up/email", {
      data: { email: `owner@${RUN_DOMAIN}`, password: PASSWORD, name: "Close Runner" },
    });
    expect(signUp.ok(), `sign-up failed: HTTP ${signUp.status()}`).toBeTruthy();
    const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
      user?: { id?: string };
    };
    userId = session.user?.id ?? "";
    expect(userId, "no user id after sign-up").toBeTruthy();
    await ctx.dispose();

    const [tenant] = await db
      .insert(tenants)
      .values({ name: `Close ${RUN}`, primaryHost: `close-${RUN}.test`, defaultCountry: "US" })
      .returning({ id: tenants.id });
    tenantId = tenant!.id;
    await db.insert(tenantMembers).values({ tenantId, userId, role: "owner" });
  });

  test.afterAll(async () => {
    if (!db || !tenantId) return;
    // Audit rows are NOT deleted here, and cannot be: `order_events` is append-only in
    // the database and its rows are retained for six years. Test and demo runs therefore
    // leave their custody trail behind, which is the same thing production does and is
    // the point of the guarantee — a trail a cleanup script can erase is not a trail.
    await db.delete(orders).where(eq(orders.tenantId, tenantId));
    await db.delete(tenantMembers).where(eq(tenantMembers.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(users).where(like(users.email, `%@${RUN_DOMAIN}`));
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(`owner@${RUN_DOMAIN}`);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Landing page depends on billing state — a tenant with no subscription is sent to
    // /welcome. Either is a successful sign-in; the console itself does not gate on
    // entitlement, so waiting specifically for /dashboard would wait forever.
    await page.waitForURL(/\/(dashboard|welcome)/);
  }

  /**
   * Raise a job through the board's own form and walk it to `en_route` by clicking the
   * moves — rather than writing rows directly.
   *
   * Deliberate: a fixture that inserts its own rows can produce a state the product
   * cannot actually reach, and then asserts against fiction. This also means the create
   * form and the forward transitions are covered on the way past.
   */
  async function raiseLiveJob(page: Page, first: string, last: string): Promise<string> {
    await page.goto(`/dashboard/${tenantId}/orders`);
    await page.getByLabel("First name").fill(first);
    await page.getByLabel("Last name").fill(last);
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

    // Scoped to THIS customer's row, not the first ORD- link on the page. The board is
    // shared and already holds earlier jobs; taking the first link opened the wrong one.
    const row = page.locator("tr").filter({ hasText: `${first} ${last}` });
    await expect(row).toBeVisible();
    await row.locator("a.ref-link").click();
    await page.waitForURL(/\/orders\/[^/]+$/);
    const id = page.url().split("/").pop()!;

    for (const move of ["Assigned", "On the way"]) {
      await page.getByRole("button", { name: move, exact: true }).click();
      await expect(page.locator(".pill").first()).toHaveText(new RegExp(move, "i"));
    }
    return id;
  }

  test("a live job offers separate cancel and fail forms, each asking why", async ({ page }) => {
    await signIn(page);
    liveOrderId = await raiseLiveJob(page, "Marisol", "Vega");

    // Two closers, and they are NOT the same control with a different word. Cancelled
    // and failed carry different reason sets because they are different events.
    const cancel = page.locator("form.close-form").filter({ hasText: "Cancel this job" });
    const fail = page.locator("form.close-form").filter({ hasText: "Mark it failed" });
    await expect(cancel).toBeVisible();
    await expect(fail).toBeVisible();

    const cancelReasons = await cancel.locator("select option").allInnerTexts();
    const failReasons = await fail.locator("select option").allInnerTexts();
    expect(cancelReasons).toContain("Customer cancelled");
    expect(failReasons).toContain("Nobody there to receive it");
    // The distinction is the whole point of the field: a job nobody attempted cannot
    // have failed because the recipient was out.
    expect(cancelReasons).not.toContain("Nobody there to receive it");
    expect(failReasons).not.toContain("Customer cancelled");
  });

  test("refuses to close a job without a reason", async ({ page }) => {
    await signIn(page);
    await page.goto(`/dashboard/${tenantId}/orders/${liveOrderId}`);

    const fail = page.locator("form.close-form").filter({ hasText: "Mark it failed" });
    await fail.getByRole("button", { name: "Mark failed" }).click();

    // Either the browser blocks the submit on a required select, or the server refuses.
    // Both are correct; what must NOT happen is the job closing with no reason.
    await expect(page.locator(".pill").first()).toHaveText(/ON THE WAY/i);
  });

  test("records the reason, and shows it on the job and in the history", async ({ page }) => {
    await signIn(page);
    failedOrderId = await raiseLiveJob(page, "Grace", "Mbeki");

    const fail = page.locator("form.close-form").filter({ hasText: "Mark it failed" });
    await fail.locator("select").selectOption("recipient_unavailable");
    await fail.locator("input[name='note']").fill("Buzzer not working, no answer");
    await fail.getByRole("button", { name: "Mark failed" }).click();

    await expect(page.locator(".pill").first()).toHaveText(/FAILED/i);
    await expect(page.getByText("Why it ended")).toBeVisible();
    // The reason reads as the operator's own words, on the job and in the audit trail —
    // a coded value nobody can read is a field that stops getting filled in honestly.
    await expect(page.getByText(/Nobody there to receive it/).first()).toBeVisible();
    await expect(page.getByText(/Buzzer not working, no answer/).first()).toBeVisible();
  });

  test("does not colour a failed job as a success", async ({ page }) => {
    await signIn(page);
    await page.goto(`/dashboard/${tenantId}/orders/${failedOrderId}`);

    const pill = page.locator(".pill").first();
    await expect(pill).toHaveText(/FAILED/i);
    // The actual defect, asserted the way a person saw it. `isTerminal` was true here,
    // so the pill took the success style and a failed job rendered green.
    await expect(pill).toHaveClass(/warn/);
    await expect(pill).not.toHaveClass(/good/);
  });

  test("re-attempts a failed job as a NEW job, leaving the failure on the record", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`/dashboard/${tenantId}/orders/${failedOrderId}`);

    await expect(page.getByText(/Terminal states cannot be reopened/)).toBeVisible();
    await page.getByRole("button", { name: /Try again/ }).click();

    // Lands on a DIFFERENT order, which is pending.
    await page.waitForURL(new RegExp(`/dashboard/${tenantId}/orders/(?!${failedOrderId})`));
    await expect(page.locator(".pill").first()).toHaveText(/UNASSIGNED/i);

    // ...and the original is still failed. Reopening would have erased the first
    // attempt from the operator's own numbers.
    await page.goto(`/dashboard/${tenantId}/orders/${failedOrderId}`);
    await expect(page.locator(".pill").first()).toHaveText(/FAILED/i);
  });

  test("every closure control is a real tap target on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(`/dashboard/${tenantId}/orders/${liveOrderId}`);

    // 44px is the hard minimum, not a preference — and a select that LOOKS big can
    // still be a small target, so measure rather than trust the padding.
    const controls = page.locator("form.close-form select, form.close-form input, form.close-form button");
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible())) continue; // hidden inputs carry ids, not targets
      const box = await control.boundingBox();
      expect(box, `control ${i} has no box`).not.toBeNull();
      expect(box!.height, `control ${i} is ${box!.height}px tall`).toBeGreaterThanOrEqual(44);
    }
  });
});
