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
import { readFileSync } from "node:fs";
import { like } from "drizzle-orm";
import { createDbClient, users } from "@porterdirect/db";

/**
 * Several flows deliberately fail AFTER the user row exists (a refused dispatch domain,
 * for instance), which would otherwise leave orphans accumulating run after run.
 *
 * Scoped to THIS run's domain — see RUN_DOMAIN. A broader pattern deletes other suites'
 * fixtures out from under them.
 */
test.afterAll(async () => {
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
      // Regex over the whole file with the m flag — no line splitting, so no escape
      // sequences to get mangled by whatever writes this file.
      const match = /^DATABASE_URL=(.*)$/m.exec(text);
      if (match && match[1]) url = match[1].trim();
    } catch {
      return;
    }
  }
  if (!url) return;
  await createDbClient(url).delete(users).where(like(users.email, `%@${RUN_DOMAIN}`));
});

const PASSWORD = "correct-horse-battery-staple";

/**
 * A domain unique to THIS run.
 *
 * The cleanup below previously deleted every `%@example.test` user — which is also the
 * domain the membership integration tests use, so an e2e run could delete another
 * suite's fixtures mid-test against the shared database. It showed up exactly once, as
 * an unreproducible failure. Scoping the pattern to one run removes the interference
 * rather than leaving it to timing.
 */
const RUN_DOMAIN = `e2e-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.test`;

function uniqueEmail(prefix: string): string {
  return `${prefix}+${Math.floor(Math.random() * 1e9).toString(36)}@${RUN_DOMAIN}`;
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
    await page.locator('input[name="password"]').fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p.error")).toContainText("do not match an account");
    assertNoServerError();
  });

  test("keeps the email so the user does not retype it", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Work email").fill("someone@example.test");
    await page.locator('input[name="password"]').fill("wrong-password-here");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByLabel("Work email")).toHaveValue("someone@example.test");
  });

  test("gives the SAME message for an unknown account as for a wrong password", async ({
    page,
  }) => {
    // No account-enumeration oracle: the two must be indistinguishable to a visitor.
    await page.goto("/signin");
    await page.getByLabel("Work email").fill(uniqueEmail("ghost"));
    await page.locator('input[name="password"]').fill("some-password-value");
    await page.getByRole("button", { name: "Sign in" }).click();
    const unknownAccount = await page.locator("p.error").innerText();

    await page.goto("/signin");
    await page.getByLabel("Work email").fill("nobody@example.test");
    await page.locator('input[name="password"]').fill("another-wrong-value");
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
    await page.locator('input[name="firstName"]').fill("Im");
    await page.locator('input[name="lastName"]').fill("Postor");
    await page.getByLabel("Work email").fill(uniqueEmail("impostor"));
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByLabel("Company name").fill("Impostor Ltd");
    await page.getByLabel("Your dispatch domain").fill("app.porterdirect.com");
    await page.getByRole("button", { name: "Continue to payment" }).click();

    await expect(page.locator("p.error")).toContainText("cannot be used");
    assertNoServerError();
  });

  test("rejects a password under twelve characters", async ({ page }) => {
    const assertNoServerError = watchForServerErrors(page);
    await page.goto("/signup");
    await page.locator('input[name="firstName"]').fill("Short");
    await page.locator('input[name="lastName"]').fill("Person");
    await page.getByLabel("Work email").fill(uniqueEmail("short"));
    await page.locator('input[name="password"]').fill("short");
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

test.describe("password visibility toggle", () => {
  test("reveals and re-hides the password", async ({ page }) => {
    await page.goto("/signin");
    const input = page.locator('input[name="password"]');
    await input.fill("hunter2-and-then-some");

    await expect(input).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(input).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(input).toHaveAttribute("type", "password");
  });

  test("keeps the typed value across a toggle", async ({ page }) => {
    // Re-rendering the input with a different `type` must not reset what was typed.
    await page.goto("/signin");
    const input = page.locator('input[name="password"]');
    await input.fill("do-not-lose-this-value");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(input).toHaveValue("do-not-lose-this-value");
  });

  test("does not submit the form when tapped", async ({ page }) => {
    // A <button> inside a form defaults to type="submit"; getting this wrong posts the
    // form on the first tap of the eye icon.
    await page.goto("/signin");
    await page.getByLabel("Work email").fill("someone@example.test");
    await page.locator('input[name="password"]').fill("some-password-value");
    await page.getByRole("button", { name: "Show password" }).click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.locator("p.error")).toHaveCount(0);
  });

  test("is a real 44px tap target", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/signin");
    const box = await page.getByRole("button", { name: "Show password" }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test("password text never runs underneath the toggle", async ({ page }) => {
    await page.goto("/signin");
    const input = page.locator('input[name="password"]');
    const button = page.getByRole("button", { name: "Show password" });
    const inputBox = (await input.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    const paddingRight = await input.evaluate((el) =>
      // The parseFloat ban exists to keep MONEY in integer cents. This parses a CSS
      // pixel length, where a float is the correct representation and no currency is
      // involved. The directive must sit on the line IMMEDIATELY above the code — an
      // explanation between them silently detaches it.
      // eslint-disable-next-line no-restricted-properties
      Number.parseFloat(getComputedStyle(el).paddingRight),
    );
    const textRightEdge = inputBox.x + inputBox.width - paddingRight;
    expect(textRightEdge, "text can render under the toggle button").toBeLessThanOrEqual(
      buttonBox.x + 1,
    );
  });
});

test.describe("forgot password", () => {
  test("gives the same confirmation whether or not the account exists", async ({ page }) => {
    // Probing this form needs no password at all, so an honest "no such account" here
    // would be a wide-open enumeration oracle.
    await page.goto("/forgot");
    await page.getByLabel("Work email").fill(uniqueEmail("definitely-not-a-user"));
    await page.getByRole("button", { name: "Send reset link" }).click();
    const unknown = await page.getByRole("status").innerText();

    await page.goto("/forgot");
    await page.getByLabel("Work email").fill("perriceconsulting@gmail.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    const known = await page.getByRole("status").innerText();

    expect(unknown).toBe(known);
    expect(known).toContain("If that address has an account");
  });

  test("is reachable from the sign-in page", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot/);
  });
});

test.describe("reset password", () => {
  test("asks for a link when opened without a token", async ({ page }) => {
    await page.goto("/reset");
    await expect(page.getByText("This page needs a reset link")).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveCount(0);
  });

  test("shows the form when a token is present", async ({ page }) => {
    await page.goto("/reset?token=some-token-value");
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="confirm"]')).toBeVisible();
  });

  test("rejects mismatched passwords without spending the token", async ({ page }) => {
    await page.goto("/reset?token=some-token-value");
    await page.locator('input[name="password"]').fill("first-password-entry");
    await page.locator('input[name="confirm"]').fill("second-password-entry");
    await page.getByRole("button", { name: "Set new password" }).click();

    await expect(page.locator("p.error")).toContainText("do not match");
    // The token must survive, or a typo would force the user to request a new link.
    await expect(page.locator('input[name="password"]')).toBeVisible();
  });

  test("explains an expired or spent link", async ({ page }) => {
    await page.goto("/reset?error=invalid-token");
    await expect(page.locator("p.error")).toContainText("expired or has already been used");
  });
});

test.describe("password policy", () => {
  /**
   * The policy follows NIST SP 800-63B: length and breach-checking rather than
   * composition rules. These assert the decision, so nobody "fixes" it later by adding
   * an uppercase-digit-symbol requirement that produces Password1! and reuse.
   */
  async function attemptSignUp(page: import("@playwright/test").Page, password: string) {
    await page.goto("/signup");
    await page.locator('input[name="firstName"]').fill("Policy");
    await page.locator('input[name="lastName"]').fill("Tester");
    await page.getByLabel("Work email").fill(uniqueEmail("policy"));
    await page.locator('input[name="password"]').fill(password);
    await page.getByLabel("Company name").fill("Policy Test Ltd");
    await page.getByLabel("Your dispatch domain").fill(`d${Date.now().toString(36)}.example.org`);
    await page.getByRole("button", { name: "Continue to payment" }).click();
  }

  test("refuses a password that appears in a known breach", async ({ page }) => {
    await attemptSignUp(page, "letmeinletmein");
    await expect(page.locator("p.error")).toContainText(/known data breach|too common/i);
  });

  test("refuses a password containing the product name", async ({ page }) => {
    await attemptSignUp(page, "porterdirect-forever");
    await expect(page.locator("p.error")).toContainText("product name");
  });

  test("accepts a plain lowercase passphrase with no digits or symbols", async ({ page }) => {
    // The absence of composition rules is deliberate; this proves it holds.
    await attemptSignUp(page, "meadow lantern cobble drift");
    // Assert on the URL, not on the absence of an error element: when the password is
    // accepted there is no `p.error` at all, and `not.toContainText` fails on a missing
    // element rather than passing. The URL exists either way.
    await expect(page).not.toHaveURL(/error=password-policy/);
    await expect(page).not.toHaveURL(/error=weak-password/);
  });
});
