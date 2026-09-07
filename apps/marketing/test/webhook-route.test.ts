/**
 * Integration test for the Stripe webhook ROUTE (not just the pure dispatcher).
 *
 * This exercises the compliance contract end-to-end with a real HMAC signature, so it
 * needs no Stripe account and no network: we sign a payload with a known secret exactly
 * the way Stripe does, then assert the route's status codes and idempotency.
 *
 * The status codes are the contract that drives Stripe's retry behaviour — getting them
 * wrong is a silent failure (a 200 on a failed apply means Stripe never retries and the
 * subscription silently drifts from the DB).
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEBHOOK_SECRET = "whsec_testsecretfortestingonly";
const SECRET_KEY = "sk_test_fakekeyfortestingonly";

/** Sign a payload the way Stripe signs it: HMAC-SHA256 over `${timestamp}.${payload}`. */
function stripeSignature(payload: string, secret: string, timestamp: number): string {
  const signed = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signed}`;
}

function subscriptionEvent(eventId: string, priceId: string, quantity: number) {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_test_123",
        customer: "cus_test_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1_800_000_000,
        items: { data: [{ quantity, price: { id: priceId } }] },
      },
    },
  };
}

function post(body: string, signature: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  return new Request("http://localhost:3000/api/stripe/webhook", {
    method: "POST",
    headers,
    body,
  });
}

/** Fresh module registry per test so the in-memory idempotency ledger starts empty. */
async function loadRoute() {
  vi.resetModules();
  return await import("../app/api/stripe/webhook/route.js");
}

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("STRIPE_SECRET_KEY", SECRET_KEY);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("STRIPE_PRICE_DIRECT_COURIER", "price_direct_courier_test");
    // Clear the hot-reload singletons so each test gets a clean ledger.
    delete (globalThis as Record<string, unknown>).__pdWebhookStore;
    delete (globalThis as Record<string, unknown>).__pdSubscriptionSink;
  });

  it("rejects a request with no stripe-signature header (400, no retry)", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("{}", null));
    expect(res.status).toBe(400);
  });

  it("rejects a forged signature (400 — a forgery never becomes valid on retry)", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify(subscriptionEvent("evt_forged", "price_direct_courier_test", 7));
    const res = await POST(post(body, "t=1,v1=deadbeef"));
    expect(res.status).toBe(400);
  });

  it("rejects a payload signed with the WRONG secret (the carried-over whsec_ landmine)", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify(subscriptionEvent("evt_wrongsecret", "price_direct_courier_test", 7));
    const sig = stripeSignature(body, "whsec_a_different_accounts_secret", Math.floor(Date.now() / 1000));
    const res = await POST(post(body, sig));
    expect(res.status).toBe(400);
  });

  it("rejects a tampered payload that reuses a valid signature", async () => {
    const { POST } = await loadRoute();
    const original = JSON.stringify(subscriptionEvent("evt_tamper", "price_direct_courier_test", 5));
    const sig = stripeSignature(original, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const tampered = JSON.stringify(subscriptionEvent("evt_tamper", "price_direct_courier_test", 500));
    const res = await POST(post(tampered, sig));
    expect(res.status).toBe(400);
  });

  it("accepts a correctly signed event and processes it (200)", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify(subscriptionEvent("evt_ok_1", "price_direct_courier_test", 7));
    const sig = stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const res = await POST(post(body, sig));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, status: "processed" });
  });

  it("is idempotent: a redelivered event is skipped, not double-applied", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify(subscriptionEvent("evt_dupe", "price_direct_courier_test", 7));
    const sig = stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const first = await POST(post(body, sig));
    expect(await first.json()).toMatchObject({ status: "processed" });

    const second = await POST(post(body, sig));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "skipped_duplicate" });
  });

  it("acknowledges an unrelated event type with 200 rather than erroring", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify({ id: "evt_other", type: "ping", data: { object: {} } });
    const sig = stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const res = await POST(post(body, sig));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
  });

  it("returns 500 (so Stripe retries) when the Price maps to no catalog plan", async () => {
    const { POST } = await loadRoute();
    const body = JSON.stringify(subscriptionEvent("evt_unknown_price", "price_not_in_catalog", 7));
    const sig = stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const res = await POST(post(body, sig));
    expect(res.status).toBe(500);
  });

  it("returns 500 when the webhook env is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const { POST } = await loadRoute();
    const res = await POST(post("{}", "t=1,v1=abc"));
    expect(res.status).toBe(500);
  });
});
