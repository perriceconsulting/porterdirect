"use server";

/**
 * Console actions.
 *
 * Every one re-resolves the tenant and re-authorizes. The page having rendered is not
 * permission to act: a form post arrives on its own, from whatever the client chose to
 * send, so the tenant id in the body proposes and the database decides — same rule as
 * the page itself.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createStripeClient } from "@porterdirect/billing";
import { isRedirectError } from "@porterdirect/auth";
import { requireConsole } from "../../../lib/console";

/**
 * Open Stripe's billing portal for this tenant.
 *
 * The portal is where a customer changes their card, updates seats, downloads invoices
 * and cancels. Building those screens ourselves would mean re-implementing PCI-adjacent
 * flows we deliberately do not want to own — and Stripe's portal already reflects the
 * subscription exactly, with no mirror to drift.
 */
export async function openBillingPortalAction(data: FormData): Promise<void> {
  // FormData values are string | File. Coercing a File with String() yields
  // "[object Object]", which would then be looked up as a tenant id — narrow the
  // type instead of stringifying whatever arrived.
  const raw = data.get("tenantId");
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  if (!tenantId) redirect("/dashboard");

  // Re-authorized here, not inherited from the page that rendered the button.
  const { tenant } = await requireConsole(tenantId, "billing:manage");

  if (!tenant.stripeCustomerId) {
    redirect(`/dashboard/${tenantId}?error=no-customer`);
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${h.get("host") ?? "localhost:3000"}`;

  let url: string;
  try {
    const session = await createStripeClient(process.env.STRIPE_SECRET_KEY).billingPortal.sessions.create(
      {
        customer: tenant.stripeCustomerId,
        return_url: `${origin}/dashboard/${tenantId}`,
      },
    );
    url = session.url;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    // The portal needs configuring once per Stripe account; until then this is the most
    // common failure and the message must say so rather than "something went wrong".
    console.error("[billing-portal]", err instanceof Error ? err.message : err);
    redirect(`/dashboard/${tenantId}?error=portal-unavailable`);
  }

  redirect(url);
}
