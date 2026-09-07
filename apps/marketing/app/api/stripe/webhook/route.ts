/**
 * POST /api/stripe/webhook — Stripe Billing webhook endpoint (licensee subscriptions).
 *
 * Compliance contract, in the order it matters:
 *  1. Read the RAW body. Signature verification hashes the exact bytes Stripe sent;
 *     parsing to JSON first (or letting a body parser touch it) breaks verification.
 *  2. Verify BEFORE trusting anything. An unverified payload is attacker-controlled.
 *  3. Reply fast. Stripe expects a response within seconds and retries otherwise.
 *  4. Status codes drive Stripe's retry behaviour:
 *       400 -> bad/missing signature. Stripe does NOT retry. Correct: a forged or
 *              wrong-secret payload will never become valid on redelivery.
 *       500 -> we accepted it but failed to apply it. Stripe DOES retry, and the
 *              idempotency ledger makes the retry safe.
 *       200 -> processed, duplicate, or deliberately ignored event type.
 *  5. Never log key material or a raw signature header.
 */
import { NextResponse } from "next/server";
import {
  createPlanIdResolver,
  createStripeClient,
  handleStripeEvent,
  verifyStripeEvent,
} from "@porterdirect/billing";
import { subscriptionSink, webhookEventStore } from "../../../../lib/webhook-adapters";

// Node runtime: Stripe's synchronous constructEvent needs Node crypto, not Edge.
export const runtime = "nodejs";
// Never cache a webhook route.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    // Configuration failure, not a client error. Say which var is missing — the NAME
    // is safe to log; the value never is.
    const missing = [
      !secretKey ? "STRIPE_SECRET_KEY" : null,
      !webhookSecret ? "STRIPE_WEBHOOK_SECRET" : null,
    ].filter(Boolean);
    console.error(`[stripe-webhook] not configured — missing: ${missing.join(", ")}`);
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Raw body, exactly as sent. Must precede any JSON parsing.
  const rawBody = await request.text();

  const stripe = createStripeClient(secretKey);

  let event;
  try {
    event = verifyStripeEvent(stripe, rawBody, signature, webhookSecret);
  } catch (err) {
    // Almost always a stale STRIPE_WEBHOOK_SECRET carried over from another account
    // (CLAUDE.md: re-derive per account) — which otherwise surfaces only as quiet 400s.
    console.error(
      `[stripe-webhook] signature verification FAILED: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "Signature verification failed" }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event, {
      store: webhookEventStore,
      sink: subscriptionSink,
      resolvePlanId: createPlanIdResolver(process.env),
    });
    console.log(`[stripe-webhook] ${event.type} ${event.id} -> ${result.status}`);
    return NextResponse.json({ received: true, ...result }, { status: 200 });
  } catch (err) {
    // 500 so Stripe retries; the idempotency ledger makes that retry safe.
    console.error(
      `[stripe-webhook] processing ${event.type} ${event.id} failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

/** A GET here is almost always a human checking the URL — say so, don't 405 silently. */
export function GET(): NextResponse {
  return NextResponse.json(
    { endpoint: "stripe-webhook", method: "POST only" },
    { status: 405 },
  );
}
