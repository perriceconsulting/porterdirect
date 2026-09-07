"use server";

/**
 * Sign-in, sign-up and provisioning, as server actions behind plain <form> posts.
 *
 * Errors travel back as a redirect with an `?error=` code, rendered server-side, rather
 * than through client state. That keeps these flows working with JavaScript disabled and
 * keeps the client-component ratchet at zero — a sign-in form is the last place that
 * needs a hydration boundary.
 *
 * Codes are opaque and enumerated; the page maps them to copy. A raw error message must
 * never reach the URL bar: it would leak internals into browser history, logs and
 * referrers.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { getAuth } from "../lib/auth";
import { createCheckoutSession, provisionTenant } from "../lib/provisioning";

export type FormErrorCode =
  | "missing-fields"
  | "bad-credentials"
  | "email-taken"
  | "weak-password"
  | "invalid-host"
  | "host-taken"
  | "invalid-name"
  | "unknown-plan"
  | "checkout-failed"
  | "unknown";

function back(path: string, code: FormErrorCode, keep?: Record<string, string>): never {
  const params = new URLSearchParams({ error: code, ...keep });
  redirect(`${path}?${params.toString()}`);
}

function str(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function signInAction(data: FormData): Promise<void> {
  const email = str(data, "email");
  const password = str(data, "password");
  if (!email || !password) back("/signin", "missing-fields");

  try {
    await getAuth().api.signInEmail({
      body: { email, password },
      headers: await headers(),
    });
  } catch (err) {
    // Deliberately one code for both "no such user" and "wrong password". Telling them
    // apart hands an attacker a free account-enumeration oracle.
    if (err instanceof APIError) back("/signin", "bad-credentials", { email });
    throw err;
  }

  redirect("/welcome");
}

export async function signOutAction(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/");
}

/**
 * Create the account, provision the tenant, and hand off to Stripe Checkout.
 *
 * Each step must complete before the next: the tenant needs the user, the Stripe
 * customer needs the tenant, and checkout needs the customer — because the subscription
 * webhook resolves back to the tenant through that customer id (see provisioning.ts).
 */
export async function signUpAction(data: FormData): Promise<void> {
  const name = str(data, "name");
  const email = str(data, "email");
  const password = str(data, "password");
  const company = str(data, "company");
  const host = str(data, "host");
  const planId = str(data, "plan");
  const seatsRaw = str(data, "seats");

  const keep = { email, company, host, plan: planId, seats: seatsRaw };
  if (!name || !email || !password || !company || !host || !planId) {
    back("/signup", "missing-fields", keep);
  }

  const seats = Number.parseInt(seatsRaw || "1", 10);
  if (!Number.isInteger(seats) || seats < 1) back("/signup", "missing-fields", keep);

  let userId: string;
  try {
    const result = await getAuth().api.signUpEmail({
      body: { email, password, name },
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (err) {
    if (err instanceof APIError) {
      const message = String(err.message ?? "").toLowerCase();
      if (message.includes("password")) back("/signup", "weak-password", keep);
      back("/signup", "email-taken", keep);
    }
    throw err;
  }

  const provisioned = await provisionTenant({
    name: company,
    host,
    ownerUserId: userId,
    ownerEmail: email,
    planId,
  });

  if (!provisioned.ok) {
    const { failure } = provisioned;
    back("/signup", failure.kind === "invalid-host" ? "invalid-host" : failure.kind, keep);
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${h.get("host") ?? "localhost:3000"}`;

  let checkoutUrl: string;
  try {
    checkoutUrl = await createCheckoutSession({
      tenantId: provisioned.tenantId,
      stripeCustomerId: provisioned.stripeCustomerId,
      planId,
      seats,
      origin,
    });
  } catch (err) {
    // The tenant and the account both exist at this point, so this is recoverable: the
    // owner can retry checkout rather than being told to sign up again.
    console.error("[signup] checkout failed:", err instanceof Error ? err.message : err);
    back("/welcome", "checkout-failed");
  }

  redirect(checkoutUrl);
}
