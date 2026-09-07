/**
 * Stripe client construction with a mechanical test-mode guard. Mirrors
 * scripts/guard-stripe-env.sh so the refusal exists in both the shell and the app
 * (CLAUDE.md: live and test keys differ by four characters — make the refusal mechanical).
 * This module NEVER logs a key value.
 */
import Stripe from "stripe";

const TEST_KEY = /^(sk|rk)_test_/;

/** Throw unless the secret key is a Stripe test-mode key. */
export function assertTestModeKey(secretKey: string): void {
  if (!TEST_KEY.test(secretKey)) {
    throw new Error(
      "REFUSING: STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_). " +
        "Dev and test must never run a live key.",
    );
  }
}

/**
 * Build a Stripe client. In dev/test the test-mode guard is enforced; pass
 * { allowLiveMode: true } only in a production wiring path that has vetted the key.
 */
export function createStripeClient(
  secretKey: string | undefined,
  opts: { allowLiveMode?: boolean } = {},
): Stripe {
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is required but not set.");
  }
  if (!opts.allowLiveMode) {
    assertTestModeKey(secretKey);
  }
  return new Stripe(secretKey);
}
