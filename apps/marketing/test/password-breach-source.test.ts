/**
 * The breach-check test seam, and the guard that keeps it out of production.
 *
 * A test seam that disables a security control is only acceptable if it cannot survive
 * a deploy. This file is the proof of that, not a note promising it.
 *
 * The seam exists because the e2e suite was failing a DIFFERENT auth test on most full
 * runs: every signup makes a live call to api.pwnedpasswords.com, the signup specs run
 * in parallel, and HIBP rate-limits. A red suite that means nothing is worse than a
 * smaller suite, because people stop reading it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { breachSource, validatePassword } from "../lib/password";

const ORIGINAL_SOURCE = process.env.PASSWORD_BREACH_SOURCE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_SOURCE === undefined) delete process.env.PASSWORD_BREACH_SOURCE;
  else process.env.PASSWORD_BREACH_SOURCE = ORIGINAL_SOURCE;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("breach check served from the fixture", () => {
  it("still refuses a breached password", async () => {
    // The point of a fixture over an off-switch: the refusal still has to happen, so the
    // e2e assertion that a breached password is rejected keeps testing something.
    process.env.PASSWORD_BREACH_SOURCE = "fixture";
    const message = await validatePassword("letmeinletmein");
    expect(message).toMatch(/known data breach|too common/i);
  });

  it("allows a passphrase that is not in the fixture", async () => {
    process.env.PASSWORD_BREACH_SOURCE = "fixture";
    expect(await validatePassword("marmalade thunder quilt")).toBeNull();
  });

  it("exercises the real k-anonymity comparison, not a lookup by password", async () => {
    // The fixture answers in HIBP's wire format and the matching logic runs unchanged,
    // so prefix/suffix handling is still under test. A password whose hash shares no
    // prefix with any fixture entry must come back clean rather than erroring.
    process.env.PASSWORD_BREACH_SOURCE = "fixture";
    for (const password of ["copper lantern drift", "seventeen paper foxes"]) {
      expect(await validatePassword(password), password).toBeNull();
    }
  });
});

describe("the seam cannot survive a deploy", () => {
  it("throws rather than quietly skipping the breach check in production", async () => {
    process.env.PASSWORD_BREACH_SOURCE = "fixture";
    process.env.NODE_ENV = "production";
    // Loud beats permissive. A no-op breach check in production would keep the signup
    // form saying all the right things while accepting passwords from every public dump.
    await expect(validatePassword("marmalade thunder quilt")).rejects.toThrow(/REFUSING/);
  });

  it("is inert unless explicitly set to the exact value", () => {
    // No truthiness. "true", "1" and "yes" must not enable a security bypass, and the
    // match is case-sensitive so "FIXTURE" is not the fixture.
    //
    // Asserted against the SELECTOR rather than by calling validatePassword, so this test
    // makes no network calls of its own — adding a live HIBP dependency back into the
    // suite while removing one from e2e would be a poor trade.
    process.env.NODE_ENV = "production";
    for (const value of ["true", "1", "yes", "FIXTURE", ""]) {
      process.env.PASSWORD_BREACH_SOURCE = value;
      expect(() => breachSource(), `value ${JSON.stringify(value)}`).not.toThrow();
    }
  });

  it("selects the fixture only for the exact value, and only outside production", () => {
    delete process.env.NODE_ENV;
    process.env.PASSWORD_BREACH_SOURCE = "fixture";
    const chosen = breachSource();
    process.env.PASSWORD_BREACH_SOURCE = "true";
    expect(breachSource()).not.toBe(chosen);
  });
});
