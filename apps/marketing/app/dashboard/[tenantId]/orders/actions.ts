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
import { IllegalTransitionError, type OrderStatus, type OrderType } from "@porterdirect/orders";
import { parseUsdToCents } from "@porterdirect/billing";
import type { Address, CountryCode } from "@porterdirect/contact";
import { requireConsole } from "../../../../lib/console";
import { OrderValidationError, createOrder, transitionOrder } from "../../../../lib/orders";

const ORDER_TYPES: readonly OrderType[] = [
  "fixed_pickup",
  "shop_in_store",
  "errand",
  "scheduled_courier",
];

const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending",
  "assigned",
  "shopping",
  "checkout",
  "en_route",
  "delivered",
  "cancelled",
  "failed",
];

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
    await transitionOrder(db, { tenantId, orderId, to, actorUserId: userId, note: field(data, "note") });
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
