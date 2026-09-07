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
 * Parse a price entered in dollars into integer cents.
 *
 * Deliberately string-based. `Math.round(parseFloat("19.99") * 100)` is the classic way
 * money becomes 1998 — and `parseFloat` is banned repo-wide for exactly this reason.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = fraction.padEnd(2, "0");
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(cents, 10);
}

export async function createOrderAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  const { db, userId } = await requireConsole(tenantId, "orders:create");
  const base = `/dashboard/${tenantId}/orders`;

  const type = field(data, "type") as OrderType;
  if (!ORDER_TYPES.includes(type)) redirect(`${base}?error=Choose a job type.`);

  const priceCents = dollarsToCents(field(data, "price") || "0");
  if (priceCents === null) {
    redirect(`${base}?error=${encodeURIComponent("Enter a price like 49.50.")}`);
  }

  try {
    await createOrder(db, {
      tenantId,
      actorUserId: userId,
      type,
      customerName: field(data, "customerName"),
      customerPhone: field(data, "customerPhone"),
      pickupAddress: field(data, "pickupAddress"),
      dropoffAddress: field(data, "dropoffAddress"),
      notes: field(data, "notes"),
      priceCents,
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
