"use server";

/**
 * Customer booking.
 *
 * This is the action that makes "a new job comes in from a customer" true. Everything
 * before it was an operator typing a job in on the customer's behalf.
 *
 * IT PRICES WHAT IT CAN AND REFUSES TO GUESS THE REST. `quoteJob` is called with the
 * operator's rate card and whatever distance could be measured; today no distance
 * provider is wired, so it returns `needs_review` and the job reaches the board
 * **unpriced**, showing "Needs pricing". That is a working product, not a stub: an
 * operator prices it and it proceeds exactly like a phone booking. When the routing and
 * fuel adapters land, the same call starts returning a number and nothing else changes.
 *
 * The customer NEVER sets the price. The form has no price field and this action reads
 * none — a booking that carried its own amount would let anyone name what they pay.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "@porterdirect/auth";
import { quoteJob } from "@porterdirect/pricing";
import type { Address, CountryCode } from "@porterdirect/contact";
import type { OrderType } from "@porterdirect/orders";
import { ORDER_TYPES } from "@porterdirect/orders";
import { OrderValidationError, createOrder } from "../../../lib/orders";
import { loadRateCard } from "../../../lib/rate-cards";
import { requirePortal } from "../../../lib/portal";

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function addressFrom(data: FormData, prefix: string, country: string): Address {
  return {
    line1: field(data, `${prefix}Line1`),
    line2: field(data, `${prefix}Line2`) || null,
    city: field(data, `${prefix}City`),
    region: field(data, `${prefix}Region`) || null,
    postalCode: field(data, `${prefix}PostalCode`) || null,
    country: field(data, `${prefix}Country`) || country,
  };
}

export async function bookDeliveryAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/portal");

  // Re-resolved, never inherited from the page that rendered the form. A form post
  // arrives on its own carrying whatever the client chose to send.
  const { db, account, tenant } = await requirePortal(tenantId);
  const base = `/portal/${tenantId}`;

  const typeRaw = field(data, "type");
  // Checked against the domain list rather than a copy, so a type this product no longer
  // supports cannot be posted in.
  const type: OrderType = (ORDER_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as OrderType)
    : "fixed_pickup";

  const scheduledRaw = field(data, "scheduledFor");
  const scheduledFor = scheduledRaw ? new Date(scheduledRaw) : null;
  if (scheduledFor && !Number.isFinite(scheduledFor.getTime())) {
    redirect(`${base}?error=${encodeURIComponent("That date and time could not be read.")}`);
  }

  const country = tenant.defaultCountry;
  const pickup = addressFrom(data, "pickup", country);
  const dropoff = addressFrom(data, "dropoff", country);

  try {
    // Priced from the OPERATOR's rate card, never from anything the customer sent.
    // With no distance provider wired this returns `needs_review`, which is a real
    // outcome rather than a failure — the operator prices it by hand.
    const card = await loadRateCard(db, tenantId);
    const quote = quoteJob({ card, type, distanceMeters: null });

    await createOrder(db, {
      tenantId,
      // The customer is the ACTOR here. Their own account id is what makes this job
      // theirs in the portal afterwards, and it is taken from the session rather than
      // the form for the same reason a driver's claim ignores any posted user id.
      actorUserId: account.userId,
      bookedByCustomerId: account.id,
      type,
      customerFirstName: field(data, "recipientFirstName"),
      customerLastName: field(data, "recipientLastName"),
      customerPhone: field(data, "recipientPhone") || undefined,
      customerEmail: field(data, "recipientEmail") || undefined,
      country: country as CountryCode,
      pickup,
      dropoff,
      notes: field(data, "notes") || undefined,
      priceCents: quote.kind === "quoted" ? quote.priceCents : null,
      driverPayCents: quote.kind === "quoted" ? quote.driverPayCents : undefined,
      quotedDistanceMeters: quote.kind === "quoted" ? quote.distanceMeters : undefined,
      scheduledFor,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError) {
      // The domain's own message, which names the missing address parts in the local
      // vocabulary rather than saying "invalid".
      redirect(`${base}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(base);
  redirect(`${base}?booked=1`);
}
