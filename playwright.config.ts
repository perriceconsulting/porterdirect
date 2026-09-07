/**
 * PHAST — concurrent assertions against a running app.
 *
 * The point is failures that only exist under PARALLELISM: session bleed, cache bleed,
 * one tenant's context leaking into another's response. A single-threaded pass cannot
 * surface those, and types, lint and unit tests never see them.
 *
 * Pillars built here, and the ones deliberately not:
 *   BUILT  — tenant isolation and auth/session isolation. Both exist now that tenancy
 *            and auth are real, and both are genuinely concurrency-only concerns.
 *   NOT    — realtime DOM reactivity and render stability. There is no live map and no
 *            dashboard yet; a spec asserting against them would assert against nothing
 *            and read as coverage (CLAUDE.md, the I caveat).
 *   NOT    — data-integrity invariants. Seat maths, entitlement and webhook idempotency
 *            are deterministic rules, so they live in unit and integration tests that
 *            run in milliseconds rather than a browser rendering of the rule.
 */
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./phast",
  // Stress suites open many contexts that all load and idle; Playwright's 30s default
  // is a harness limit, not a product failure, and its "Test ended" message reads like
  // one. Specs raise this further per-describe where they fan out wider.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky isolation assertion is a finding, never something to retry away
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: { accept: "application/json" },
  },
  webServer: {
    command: "npm run dev -w @porterdirect/marketing",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
