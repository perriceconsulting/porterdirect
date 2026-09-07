/**
 * Browser flows for sign-in and sign-up.
 *
 * This suite exists because of a specific failure. A wrong password rendered an
 * unhandled runtime error page while 169 unit and integration tests passed: the cause
 * was `err instanceof APIError` returning false inside a Next server action, where the
 * bundler had given the same class two identities. Nothing below the browser exercised
 * the actual form submission, so nothing could see it.
 *
 * The lesson these tests encode: a server action's error path is only real once a
 * browser posts a form at it. Assert on what the USER sees — the message in the form —
 * not on a status code, because the broken version returned a perfectly ordinary 200
 * with an error overlay painted on top.
 */
import { expect, test } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

function uniqueEmail(prefix: string): string {
  return `${prefix}+${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.test`;
}

/**
 * Watch for an unhandled server error during a test.
 *
 * Not by looking for Next's dev overlay: `nextjs-portal` is present on every healthy
 * page (it hosts the dev indicator), and the internal dialog markers are private DOM
 * that changes between versions — two selectors were tried and both were wrong.
 *
 * The version-proof signal is the HTTP response. A server component or server action
 * that throws returns 5xx, whatever the overlay happens to be called this release.
 */
function watchForServerErrors(page: import("@playwright/test").Page): () => void {
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 500) failures.push(`${res.status()} ${res.url()}`);
  });
  return () => {
    expect(failures, `server returned an error response: ${failures.join(", ")}`).toEqual([]);
  };
}

test.describe("sign-in", () => {
  test("shows a form message for a wrong password, not a runtime error", async ({ page }) => {
    const assertNoServerError = watchForServerErrors(page);
    await page.goto("/signin");
    await page.getByLabel("Work email").fill("nobody@example.test");
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p.error")).toContainText("do not match an account");
    assertNoServerError();
  });

  test("keeps the email so the user does not retype it", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Work email").fill("someone@example.test");
    await page.getByLabel("Password").fill("wrong-password-here");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByLabel("Work email")).toHaveValue("someone@example.test");
  });

  test("gives the SAME message for an unknown account as for a wrong password", async ({
    page,
  }) => {
    // No account-enumeration oracle: the two must be indistinguishable to a visitor.
    await page.goto("/signin");
    await page.getByLabel("Work email").fill(uniqueEmail("ghost"));
    await page.getByLabel("Password").fill("some-password-value");
    await page.getByRole("button", { name: "Sign in" }).click();
    const unknownAccount = await page.locator("p.error").innerText();

    await page.goto("/signin");
    await page.getByLabel("Work email").fill("nobody@example.test");
    await page.getByLabel("Password").fill("another-wrong-value");
    await page.getByRole("button", { name: "Sign in" }).click();
    const wrongPassword = await page.locator("p.error").innerText();

    expect(unknownAccount).toBe(wrongPassword);
  });

  test("requires both fields", async ({ page }) => {
    await page.goto("/signin?error=missing-fields");
    await expect(page.locator("p.error")).toContainText("email address and password");
  });
});

test.describe("sign-up", () => {
  test("refuses one of our own hosts as a dispatch domain", async ({ page }) => {
    const assertNoServerError = watchForServerErrors(page);
    // The signup-abuse case: nothing self-service may claim a platform surface.
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Impostor");
    await page.getByLabel("Work email").fill(uniqueEmail("impostor"));
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Company name").fill("Impostor Ltd");
    await page.getByLabel("Your dispatch domain").fill("app.porterdirect.com");
    await page.getByRole("button", { name: "Continue to payment" }).click();

    await expect(page.locator("p.error")).toContainText("cannot be used");
    assertNoServerError();
  });

  test("rejects a password under twelve characters", async ({ page }) => {
    const assertNoServerError = watchForServerErrors(page);
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Shorty");
    await page.getByLabel("Work email").fill(uniqueEmail("short"));
    await page.getByLabel("Password").fill("short");
    await page.getByLabel("Company name").fill("Shorty Ltd");
    await page.getByLabel("Your dispatch domain").fill("dispatch.shorty.example");

    // The browser's own minLength should stop this before any request is made.
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page).toHaveURL(/\/signup$/);
    assertNoServerError();
  });

  test("offers every catalogue plan, with the full label visible", async ({ page }) => {
    await page.goto("/signup");
    const select = page.getByLabel("Plan");
    await expect(select.locator("option")).toHaveCount(3);

    // The regression this guards: the longest label was clipped under the select's
    // chevron when plan shared a row with the seat count.
    const box = await select.boundingBox();
    expect(box, "plan select has no layout box").not.toBeNull();
    expect(box!.width, "plan select is too narrow for its longest option").toBeGreaterThan(260);
  });
});

test.describe("pricing page", () => {
  test("renders every catalogue tier with its price", async ({ page }) => {
    await page.goto("/");
    for (const [name, price] of [
      ["Direct Courier", "$199"],
      ["Fleet & Freight", "$499"],
      ["White-Label Agency", "$999"],
    ] as const) {
      // Filter on the tier's own heading: "Everything in Direct Courier" appears in
      // another card's feature list, so matching whole-card text finds two.
      const card = page.locator(".tier").filter({
        has: page.locator("h3.tier-name", { hasText: name }),
      });
      await expect(card, `expected exactly one "${name}" tier card`).toHaveCount(1);
      await expect(card).toContainText(price);
    }
  });

  test("has no horizontally scrolling body on a phone viewport", async ({ page }) => {
    // Mobile-first is the standard here; a page that scrolls sideways on a phone has
    // broken it regardless of what the stylesheet claims.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls horizontally on a 375px viewport").toBeLessThanOrEqual(1);
  });

  test("every primary action is a real 44px tap target", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const buttons = page.locator("a.btn, button.btn");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (!box) continue;
      const label = (await buttons.nth(i).innerText()).trim();
      // An <a> styled as a button takes height from its text and ignores vertical
      // padding unless it is given a display and a min-height. This catches that.
      expect(box.height, `"${label}" is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(
        44,
      );
    }
  });
});

test.describe("protected routes", () => {
  test("redirects an anonymous visitor away from the account page", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/signin/);
  });
});
