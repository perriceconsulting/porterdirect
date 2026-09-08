# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e\auth-flows.spec.ts >> password policy >> accepts a plain lowercase passphrase with no digits or symbols
- Location: e2e\auth-flows.spec.ts:374:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('p.error')
Expected substring: "cannot be used"
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" locator('p.error') with timeout 15000ms
  - waiting for locator('p.error')

```

```yaml
- alert
```

# Test source

```ts
  290 | });
  291 | 
  292 | test.describe("forgot password", () => {
  293 |   test("gives the same confirmation whether or not the account exists", async ({ page }) => {
  294 |     // Probing this form needs no password at all, so an honest "no such account" here
  295 |     // would be a wide-open enumeration oracle.
  296 |     await page.goto("/forgot");
  297 |     await page.getByLabel("Work email").fill(uniqueEmail("definitely-not-a-user"));
  298 |     await page.getByRole("button", { name: "Send reset link" }).click();
  299 |     const unknown = await page.getByRole("status").innerText();
  300 | 
  301 |     await page.goto("/forgot");
  302 |     await page.getByLabel("Work email").fill("perriceconsulting@gmail.com");
  303 |     await page.getByRole("button", { name: "Send reset link" }).click();
  304 |     const known = await page.getByRole("status").innerText();
  305 | 
  306 |     expect(unknown).toBe(known);
  307 |     expect(known).toContain("If that address has an account");
  308 |   });
  309 | 
  310 |   test("is reachable from the sign-in page", async ({ page }) => {
  311 |     await page.goto("/signin");
  312 |     await page.getByRole("link", { name: "Forgot your password?" }).click();
  313 |     await expect(page).toHaveURL(/\/forgot/);
  314 |   });
  315 | });
  316 | 
  317 | test.describe("reset password", () => {
  318 |   test("asks for a link when opened without a token", async ({ page }) => {
  319 |     await page.goto("/reset");
  320 |     await expect(page.getByText("This page needs a reset link")).toBeVisible();
  321 |     await expect(page.locator('input[name="password"]')).toHaveCount(0);
  322 |   });
  323 | 
  324 |   test("shows the form when a token is present", async ({ page }) => {
  325 |     await page.goto("/reset?token=some-token-value");
  326 |     await expect(page.locator('input[name="password"]')).toBeVisible();
  327 |     await expect(page.locator('input[name="confirm"]')).toBeVisible();
  328 |   });
  329 | 
  330 |   test("rejects mismatched passwords without spending the token", async ({ page }) => {
  331 |     await page.goto("/reset?token=some-token-value");
  332 |     await page.locator('input[name="password"]').fill("first-password-entry");
  333 |     await page.locator('input[name="confirm"]').fill("second-password-entry");
  334 |     await page.getByRole("button", { name: "Set new password" }).click();
  335 | 
  336 |     await expect(page.locator("p.error")).toContainText("do not match");
  337 |     // The token must survive, or a typo would force the user to request a new link.
  338 |     await expect(page.locator('input[name="password"]')).toBeVisible();
  339 |   });
  340 | 
  341 |   test("explains an expired or spent link", async ({ page }) => {
  342 |     await page.goto("/reset?error=invalid-token");
  343 |     await expect(page.locator("p.error")).toContainText("expired or has already been used");
  344 |   });
  345 | });
  346 | 
  347 | test.describe("password policy", () => {
  348 |   /**
  349 |    * The policy follows NIST SP 800-63B: length and breach-checking rather than
  350 |    * composition rules. These assert the decision, so nobody "fixes" it later by adding
  351 |    * an uppercase-digit-symbol requirement that produces Password1! and reuse.
  352 |    */
  353 |   async function attemptSignUp(page: import("@playwright/test").Page, password: string) {
  354 |     await page.goto("/signup");
  355 |     await page.locator('input[name="firstName"]').fill("Policy");
  356 |     await page.locator('input[name="lastName"]').fill("Tester");
  357 |     await page.getByLabel("Work email").fill(uniqueEmail("policy"));
  358 |     await page.locator('input[name="password"]').fill(password);
  359 |     await page.getByLabel("Company name").fill("Policy Test Ltd");
  360 |     await page.getByLabel("Your dispatch domain").fill(`d${Date.now().toString(36)}.example.org`);
  361 |     await page.getByRole("button", { name: "Continue to payment" }).click();
  362 |   }
  363 | 
  364 |   test("refuses a password that appears in a known breach", async ({ page }) => {
  365 |     await attemptSignUp(page, "letmeinletmein");
  366 |     await expect(page.locator("p.error")).toContainText(/known data breach|too common/i);
  367 |   });
  368 | 
  369 |   test("refuses a password containing the product name", async ({ page }) => {
  370 |     await attemptSignUp(page, "porterdirect-forever");
  371 |     await expect(page.locator("p.error")).toContainText("product name");
  372 |   });
  373 | 
  374 |   test("accepts a plain lowercase passphrase with no digits or symbols", async ({ page }) => {
  375 |     // The absence of composition rules is deliberate; this proves it holds.
  376 |     //
  377 |     // A RESERVED host is used so the request fails at provisioning, AFTER the password
  378 |     // check. Letting it succeed would create a real tenant and a real Stripe customer on
  379 |     // every run — this suite had already leaked four of each before that was noticed.
  380 |     // Seeing the host error is positive proof the password got past the policy.
  381 |     await page.goto("/signup");
  382 |     await page.locator('input[name="firstName"]').fill("Policy");
  383 |     await page.locator('input[name="lastName"]').fill("Tester");
  384 |     await page.getByLabel("Work email").fill(uniqueEmail("policy"));
  385 |     await page.locator('input[name="password"]').fill("meadow lantern cobble drift");
  386 |     await page.getByLabel("Company name").fill("Policy Test Ltd");
  387 |     await page.getByLabel("Your dispatch domain").fill("app.porterdirect.com");
  388 |     await page.getByRole("button", { name: "Continue to payment" }).click();
  389 | 
> 390 |     await expect(page.locator("p.error")).toContainText("cannot be used");
      |                                           ^ Error: expect(locator).toContainText(expected) failed
  391 |     await expect(page).not.toHaveURL(/error=password-policy/);
  392 |   });
  393 | });
  394 | 
  395 | test.describe("form layout", () => {
  396 |   /**
  397 |    * Regression: `.row-2` was set to `2fr 1fr` to stop one dropdown clipping, then the
  398 |    * dropdown moved to its own row and the ratio stayed — silently skewing every other
  399 |    * pair, so "first name" rendered twice the width of "last name" on two forms.
  400 |    *
  401 |    * A class named for its structure must not carry one caller's proportions, and the
  402 |    * cheapest way to keep that true is to measure it.
  403 |    */
  404 |   test("paired name fields are equal width on a desktop viewport", async ({ page }) => {
  405 |     await page.setViewportSize({ width: 1280, height: 900 });
  406 |     await page.goto("/signup");
  407 | 
  408 |     const first = await page.locator('input[name="firstName"]').boundingBox();
  409 |     const last = await page.locator('input[name="lastName"]').boundingBox();
  410 |     expect(first).not.toBeNull();
  411 |     expect(last).not.toBeNull();
  412 | 
  413 |     // Same row, so same vertical position...
  414 |     expect(Math.abs(first!.y - last!.y)).toBeLessThanOrEqual(1);
  415 |     // ...and the same width, within a sub-pixel rounding tolerance.
  416 |     expect(
  417 |       Math.abs(first!.width - last!.width),
  418 |       `first ${Math.round(first!.width)}px vs last ${Math.round(last!.width)}px`,
  419 |     ).toBeLessThanOrEqual(1);
  420 |   });
  421 | 
  422 |   test("paired fields stack to full width on a phone", async ({ page }) => {
  423 |     // Mobile-first: the base rule is one column, and the pair only splits when there is
  424 |     // room. Two half-width inputs on a 375px screen is what the standard exists to stop.
  425 |     await page.setViewportSize({ width: 375, height: 812 });
  426 |     await page.goto("/signup");
  427 | 
  428 |     const first = await page.locator('input[name="firstName"]').boundingBox();
  429 |     const last = await page.locator('input[name="lastName"]').boundingBox();
  430 |     expect(first!.y, "fields should stack, not sit side by side").toBeLessThan(last!.y);
  431 |     expect(first!.width).toBeGreaterThan(250);
  432 |   });
  433 | });
  434 | 
```