"use server";

/**
 * Driver actions.
 *
 * Separate from the console's actions for one reason: where they send the person
 * afterwards. The alternative — a `returnTo` field on the shared action — is a
 * client-supplied redirect target, and validating one of those correctly is a
 * well-trodden way to ship an open redirect. The destination is decided HERE, from
 * constants, so there is nothing to validate.
 *
 * Everything else is identical to the console path on purpose: the same `transitionOrder`
 * and `recordProof`, re-authorized here rather than inherited from whatever rendered the
 * button. A form post arrives on its own carrying whatever the client chose to send, and
 * the surface it came from is not a permission.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "@porterdirect/auth";
import { IllegalTransitionError, ORDER_STATUSES, type OrderStatus } from "@porterdirect/orders";
import { completeDelivery } from "../../lib/complete-delivery";
import { requireConsole } from "../../lib/console";
import { OrderValidationError, transitionOrder } from "../../lib/orders";

function field(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Move a job forward from the driver surface. */
export async function driveTransitionAction(formData: FormData): Promise<void> {
  const tenantId = field(formData, "tenantId");
  const orderId = field(formData, "orderId");
  const base = `/drive/${tenantId}/${orderId}`;

  try {
    const { db, userId } = await requireConsole(tenantId, "orders:update:assigned");

    const to = field(formData, "to") as OrderStatus;
    if (!ORDER_STATUSES.includes(to)) redirect(`/drive/${tenantId}`);

    await transitionOrder(db, { tenantId, orderId, to, actorUserId: userId });

    revalidatePath(base);
    // Delivered means done — send them back to the list, which is the next thing they
    // need. Any other move keeps them on the job.
    redirect(to === "delivered" ? `/drive/${tenantId}` : base);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError || err instanceof IllegalTransitionError) {
      redirect(`${base}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

/**
 * Record proof, then complete the job.
 *
 * Same order as the console's: evidence first. A failed transition must never discard a
 * signature the recipient has already given, because it cannot be collected again once
 * the driver has walked away.
 */
export async function driveProofAction(formData: FormData): Promise<void> {
  const tenantId = field(formData, "tenantId");
  const orderId = field(formData, "orderId");
  const base = `/drive/${tenantId}/${orderId}`;

  try {
    const { db, tenant, subscription, userId } = await requireConsole(
      tenantId,
      "orders:update:assigned",
    );

    const accuracyRaw = field(formData, "accuracyM");
    const accuracy = accuracyRaw ? Number.parseInt(accuracyRaw, 10) : NaN;

    const { notice } = await completeDelivery(db, {
      tenantId,
      orderId,
      actorUserId: userId,
      operatorName: tenant.name,
      subscription,
      origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
      recipientName: field(formData, "recipientName") || null,
      photoKey: field(formData, "photoKey") || null,
      signatureKey: field(formData, "signatureKey") || null,
      lat: field(formData, "lat") || null,
      lng: field(formData, "lng") || null,
      accuracyM: Number.isFinite(accuracy) ? accuracy : null,
    });

    if (notice) redirect(`${base}?error=${encodeURIComponent(notice)}`);

    revalidatePath(`/drive/${tenantId}`);
    redirect(`/drive/${tenantId}`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof OrderValidationError || err instanceof IllegalTransitionError) {
      redirect(`${base}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
