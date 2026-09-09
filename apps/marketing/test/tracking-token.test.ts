/**
 * The customer tracking token.
 *
 * This is the only thing standing between a stranger and one delivery's details, and it
 * sits on a page with no login at all. Everything else in this app is guarded by a
 * session; this is guarded by a string, so the string has to be right.
 */
import { describe, expect, it } from "vitest";
import { newPublicToken } from "../lib/orders";

describe("the tracking token is generated like a secret", () => {
  it("is long enough that guessing is not a strategy", () => {
    // 24 random bytes ≈ 192 bits, base64url-encoded to 32 characters. An attacker with
    // the whole internet gets nowhere; the practical threat is a forwarded link, not a
    // brute force, and that is a different problem.
    const token = newPublicToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("is URL, SMS and QR safe without escaping", () => {
    // The three places it will actually live. A `+` or `/` from plain base64 would break
    // silently in exactly one of them, which is the worst way to find out.
    for (let i = 0; i < 200; i++) {
      expect(newPublicToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newPublicToken());
    expect(seen.size).toBe(5000);
  });

  it("is not derived from anything guessable", () => {
    // A token derived from the order id, the reference, or a timestamp would make every
    // delivery reachable from a scrap of paper — a reference is READ DOWN A PHONE and
    // ends up in inboxes and spreadsheets.
    const a = newPublicToken();
    const b = newPublicToken();
    // Consecutive tokens share no meaningful prefix; a counter or a timestamp would.
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared++;
    expect(shared).toBeLessThan(6);
  });

  it("has no discernible bias across the alphabet", () => {
    // A cheap sanity check that this is random rather than, say, a hash of something
    // low-entropy: every position should vary across a sample.
    const sample = Array.from({ length: 400 }, () => newPublicToken());
    for (const pos of [0, 5, 15, 31]) {
      const distinct = new Set(sample.map((t) => t[pos]));
      expect(distinct.size, `position ${pos} barely varies`).toBeGreaterThan(8);
    }
  });
});
