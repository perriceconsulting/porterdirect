"use server";

/**
 * Order actions.
 *
 * Each re-resolves the tenant and re-authorizes. The page having rendered a button is
 * not permission to press it: a form post arrives on its own carrying whatever the
 * client chose to send.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "@porterdirect/auth";
import {
  IllegalTransitionError,
  ORDER_STATUSES,
  ORDER_TYPES,
  type OrderStatus,
  type OrderType,
} from "@porterdirect/orders";
import { parseUsdToCents } from "@porterdirect/billing";
import type { Address, CountryCode } from "@porterdirect/contact";
import { requireConsole } from "../../../../lib/console";
import {
  OrderValidationError,
  createOrder,
  recordProof,
  redispatchOrder,
  transitionOrder,
} from "../../../../lib/orders";

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Read one address out of the form.
 *
 * Country falls back to the TENANT's, so an operator entering local jobs never has to
 * state it — while a cross-border freight run can still override it per address.
 */
function addressFrom(data: FormData, prefix: string, tenantCountry: string): Address {
  return {
    line1: field(data, `${prefix}Line1`),
    line2: field(data, `${prefix}Line2`) || null,
    city: field(data, `${prefix}City`),
    region: field(data, `${prefix}Region`) || null,
    postalCode: field(data, `${prefix}PostalCode`) || null,
    country: field(data, `${prefix}Country`) || tenantCountry,
  };
}

export async function createOrderAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  const { db, userId, tenant } = await requireConsole(tenantId, "orders:create");
  const base = `/dashboard/${tenantId}/orders`;

  const type = field(data, "type") as OrderType;
  if (!ORDER_TYPES.includes(type)) redirect(`${base}?error=Choose a job type.`);

  const priceCents = parseUsdToCents(field(data, "price") || "0");
  if (priceCents === null) {
    redirect(`${base}?error=${encodeURIComponent("Enter a price like 49.50.")}`);
  }

  // datetime-local arrives as "2026-09-08T14:30" with no zone, so it is read in the
  // server's zone. A real deployment needs the TENANT's zone, which is not stored yet —
  // recorded here rather than silently assumed correct.
  const scheduledRaw = field(data, "scheduledFor");
  const scheduledFor = scheduledRaw ? new Date(scheduledRaw) : null;
  if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
    redirect(base + "?error=" + encodeURIComponent("That date and time could not be read."));
  }

  try {
    await createOrder(db, {
      tenantId,
      actorUserId: userId,
      type,
      customerFirstName: field(data, "customerFirstName"),
      customerLastName: field(data, "customerLastName"),
      customerPhone: field(data, "customerPhone"),
      country: tenant.defaultCountry as CountryCode,
      pickup: addressFrom(data, "pickup", tenant.defaultCountry),
      dropoff: addressFrom(data, "dropoff", tenant.defaultCountry),
      notes: field(data, "notes"),
      priceCents,
      scheduledFor,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError) {
      redirect(`${base}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(base);
  redirect(base);
}

export async function transitionOrderAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  const orderId = field(data, "orderId");
  const to = field(data, "to") as OrderStatus;
  if (!tenantId || !orderId) redirect("/dashboard");
  if (!ORDER_STATUSES.includes(to)) redirect(`/dashboard/${tenantId}/orders`);

  // Moving a job is a dispatch action, not a driver one — except for the states a driver
  // owns on their own assigned work, which `orders:update:assigned` covers.
  const permission = to === "assigned" ? "orders:assign" : "orders:update:assigned";
  const { db, userId } = await requireConsole(tenantId, permission);
  const detail = `/dashboard/${tenantId}/orders/${orderId}`;

  try {
    await transitionOrder(db, {
      tenantId,
      orderId,
      to,
      actorUserId: userId,
      note: field(data, "note"),
      // Only meaningful when closing; the service refuses a close without one.
      reason: field(data, "reason") || undefined,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof IllegalTransitionError || err instanceof OrderValidationError) {
      // The state machine's message says exactly why, which beats "something went wrong"
      // for someone staring at a job that will not move.
      redirect(`${detail}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(detail);
  redirect(detail);
}

/**
 * Raise a fresh attempt at a failed job.
 *
 * Requires `orders:create`, not `orders:update:assigned`: re-dispatching commits the
 * operator to doing the work again, which is a dispatch decision rather than a driver
 * one.
 */
export async function redispatchOrderAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  const orderId = field(data, "orderId");
  if (!tenantId || !orderId) redirect("/dashboard");

  const { db, userId } = await requireConsole(tenantId, "orders:create");
  const detail = `/dashboard/${tenantId}/orders/${orderId}`;

  let created;
  try {
    created = await redispatchOrder(db, { tenantId, orderId, actorUserId: userId });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError) {
      redirect(`${detail}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(`/dashboard/${tenantId}/orders`);
  redirect(`/dashboard/${tenantId}/orders/${created.id}`);
}

/**
 * Record proof of delivery, then move the job to delivered.
 *
 * In that order, and the order is the point. The signature and photo are already in
 * storage by the time this runs — the client uploaded them direct — so what remains is
 * writing the row and transitioning. If the transition were first and the row failed,
 * a job would read "delivered" with no evidence behind it, which is precisely the claim
 * the premium tier is sold on.
 *
 * The transition is attempted but NOT required to succeed for the proof to stand. A job
 * already marked delivered by a dispatcher still gets its evidence recorded rather than
 * the driver being told to go away.
 */
export async function recordProofAction(formData: FormData): Promise<void> {
  const tenantId = field(formData, "tenantId");
  const orderId = field(formData, "orderId");
  const base = `/dashboard/${tenantId}/orders/${orderId}`;

  try {
    // Re-authorized here, not inherited from whatever rendered the form.
    const { db, membership, userId } = await requireConsole(tenantId, "orders:update:assigned");

    const accuracyRaw = field(formData, "accuracyM");
    const accuracy = accuracyRaw ? Number.parseInt(accuracyRaw, 10) : NaN;

    await recordProof(db, {
      tenantId,
      orderId,
      capturedByUserId: userId,
      recipientName: field(formData, "recipientName") || null,
      photoKey: field(formData, "photoKey") || null,
      signatureKey: field(formData, "signatureKey") || null,
      lat: field(formData, "lat") || null,
      lng: field(formData, "lng") || null,
      accuracyM: Number.isFinite(accuracy) ? accuracy : null,
    });

    try {
      await transitionOrder(db, { tenantId, orderId, to: "delivered", actorUserId: userId });
    } catch (err) {
      if (isRedirectError(err)) throw err;
      // The evidence is saved. An illegal transition here means the job was already
      // closed by someone else — worth surfacing, but not worth discarding proof over.
      if (!(err instanceof IllegalTransitionError) && !(err instanceof OrderValidationError)) {
        throw err;
      }
      void membership;
      redirect(`${base}?error=${encodeURIComponent(`Proof saved, but the job could not be marked delivered: ${err.message}`)}`);
    }

    revalidatePath(base);
    redirect(base);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError || err instanceof IllegalTransitionError) {
      redirect(`${base}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
