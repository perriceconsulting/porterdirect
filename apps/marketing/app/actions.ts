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
import { classifyAuthError, isRedirectError, type AuthFailure } from "@porterdirect/auth";
import { getAuth } from "../lib/auth";
import { createCheckoutSession, provisionTenant } from "../lib/provisioning";
import { validatePassword } from "../lib/password";

export type FormErrorCode =
  | "missing-fields"
  | "bad-credentials"
  | "email-taken"
  | "weak-password"
  | "invalid-host"
  | "host-taken"
  | "invalid-name"
  | "unknown-plan"
  | "invalid-country"
  | "rate-limited"
  | "checkout-failed"
  | "invalid-token"
  | "password-mismatch"
  | "password-policy"
  | "unknown";

function back(path: string, code: FormErrorCode, keep?: Record<string, string>): never {
  const params = new URLSearchParams({ error: code, ...keep });
  redirect(`${path}?${params.toString()}`);
}

/**
 * Auth failures classified by SHAPE, never by `instanceof`.
 *
 * A bundler can hand the same error class to two modules as two different identities.
 * That is precisely what happened here: `err instanceof APIError` is true in plain Node
 * but false inside a Next server action, so a wrong password fell through to a rethrow
 * and rendered an unhandled runtime error page instead of a form message.
 */
const FAILURE_TO_CODE: Record<AuthFailure, FormErrorCode> = {
  "bad-credentials": "bad-credentials",
  "email-taken": "email-taken",
  "weak-password": "weak-password",
  "rate-limited": "rate-limited",
  unknown: "unknown",
};

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
    // A redirect signals navigation by throwing; swallowing it would hang the request.
    if (isRedirectError(err)) throw err;
    // One code for both "no such user" and "wrong password" — telling them apart hands
    // an attacker a free account-enumeration oracle.
    const failure = classifyAuthError(err);
    if (failure === "unknown") {
      console.error("[signin] unexpected failure:", err instanceof Error ? err.message : err);
    }
    back("/signin", FAILURE_TO_CODE[failure] ?? "bad-credentials", { email });
  }

  redirect("/welcome");
}

/**
 * Request a password-reset link.
 *
 * ALWAYS reports the same outcome, whether or not an account exists for that address.
 * A form that says "no account found" is the account-enumeration oracle we closed on
 * sign-in, reopened on a page that does not even require a password to probe.
 */
export async function requestResetAction(data: FormData): Promise<void> {
  const email = str(data, "email");
  if (!email) back("/forgot", "missing-fields");

  try {
    await getAuth().api.requestPasswordReset({
      body: { email, redirectTo: "/reset" },
      headers: await headers(),
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;

    // Swallowing is deliberate — surfacing this would leak whether the address exists,
    // or that delivery failed for that address specifically.
    //
    // But swallowing hides OUR bugs too, and it already did: this called a method name
    // that does not exist (`forgetPassword` vs `requestPasswordReset`), the TypeError
    // was swallowed here, and the page cheerfully reported "check your inbox" while
    // nothing was ever sent. So an error that is NOT a recognisable auth failure is
    // rethrown in development, where it is a defect rather than a privacy concern.
    console.error("[forgot] request failed:", err instanceof Error ? err.message : err);
    const recognised = classifyAuthError(err) !== "unknown";
    if (!recognised && process.env.NODE_ENV !== "production") throw err;
  }

  redirect("/forgot?sent=1");
}

/** Complete a reset using the token from the emailed link. */
export async function resetPasswordAction(data: FormData): Promise<void> {
  const password = str(data, "password");
  const confirm = str(data, "confirm");
  const token = str(data, "token");

  if (!token) back("/reset", "invalid-token");
  if (!password || !confirm) back("/reset", "missing-fields", { token });
  if (password !== confirm) back("/reset", "password-mismatch", { token });

  // The same policy as signup. A reset must not be a way to set a password that signup
  // would have refused.
  const passwordProblem = await validatePassword(password);
  if (passwordProblem) back("/reset", "password-policy", { token, detail: passwordProblem });

  try {
    await getAuth().api.resetPassword({
      body: { newPassword: password, token },
      headers: await headers(),
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (classifyAuthError(err) === "weak-password") {
      back("/reset", "weak-password", { token });
    }
    // Anything else here means the token is spent, expired or forged. Say so, rather
    // than "something went wrong" — the user needs to know to request a new link.
    console.error("[reset] failed:", err instanceof Error ? err.message : err);
    back("/reset", "invalid-token");
  }

  redirect("/signin?reset=1");
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
  const firstName = str(data, "firstName");
  const lastName = str(data, "lastName");
  // `name` stays DERIVED — one source of truth for the person's name, two structured
  // parts plus a display form composed from them.
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const email = str(data, "email");
  const password = str(data, "password");
  const company = str(data, "company");
  const host = str(data, "host");
  // US-first: not asked at signup, so the tenant takes the default. The field and the
  // per-country machinery remain, so serving a non-US operator is a form change rather
  // than a schema migration.
  const country = "US";
  const planId = str(data, "plan");
  const seatsRaw = str(data, "seats");

  const keep = { email, company, host, plan: planId, seats: seatsRaw, firstName, lastName, country };
  if (!firstName || !lastName || !email || !password || !company || !host || !planId) {
    back("/signup", "missing-fields", keep);
  }

  const seats = Number.parseInt(seatsRaw || "1", 10);
  if (!Number.isInteger(seats) || seats < 1) back("/signup", "missing-fields", keep);

  // Checked BEFORE the account is created, so a rejected password never leaves a
  // half-made user behind — and the message says what is actually wrong rather than a
  // generic "weak password".
  const passwordProblem = await validatePassword(password, { email });
  if (passwordProblem) {
    back("/signup", "password-policy", { ...keep, detail: passwordProblem });
  }

  let userId: string;
  try {
    const result = await getAuth().api.signUpEmail({
      body: { email, password, name, firstName, lastName },
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    const failure = classifyAuthError(err);
    if (failure === "unknown") {
      console.error("[signup] unexpected failure:", err instanceof Error ? err.message : err);
    }
    back("/signup", FAILURE_TO_CODE[failure] ?? "unknown", keep);
  }

  const provisioned = await provisionTenant({
    name: company,
    host,
    ownerUserId: userId,
    ownerEmail: email,
    planId,
    country,
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
    if (isRedirectError(err)) throw err;
    // The tenant and the account both exist at this point, so this is recoverable: the
    // owner can retry checkout rather than being told to sign up again.
    console.error("[signup] checkout failed:", err instanceof Error ? err.message : err);
    back("/welcome", "checkout-failed");
  }

  redirect(checkoutUrl);
}
