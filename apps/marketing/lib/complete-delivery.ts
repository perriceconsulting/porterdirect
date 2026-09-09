/**
 * Completing a delivery: record proof, move the job, send the receipt.
 *
 * One function rather than the same three steps written twice, because the console and
 * the driver surface both do this and they had already begun to diverge. The ORDER is the
 * part that matters and it is the same on both:
 *
 *   1. Evidence first. A failed transition must never discard a signature the recipient
 *      has already given — it cannot be collected again once the driver has walked away.
 *   2. Then the status.
 *   3. Then the receipt, which is a courtesy and never allowed to cost a delivery.
 */
import type { Db } from "@porterdirect/db";
import { IllegalTransitionError } from "@porterdirect/orders";
import { OrderValidationError, findOrder, recordProof, transitionOrder } from "./orders";
import { describeReceipt, sendDeliveryReceipt, type ReceiptOutcome } from "./delivery-receipt";
import type { ConsoleSubscription } from "./console";

export interface CompleteDeliveryInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly actorUserId: string;
  readonly operatorName: string;
  readonly subscription: ConsoleSubscription | null;
  /** Absolute base URL, so the emailed link works outside the app. */
  readonly origin: string;
  readonly recipientName: string | null;
  readonly photoKey: string | null;
  readonly signatureKey: string | null;
  readonly lat: string | null;
  readonly lng: string | null;
  readonly accuracyM: number | null;
}

export interface CompleteDeliveryResult {
  /** Non-null when something needs saying to the operator. */
  readonly notice: string | null;
  readonly receipt: ReceiptOutcome;
}

export async function completeDelivery(
  db: Db,
  input: CompleteDeliveryInput,
): Promise<CompleteDeliveryResult> {
  // 1. Evidence. Throws on an empty proof or a second one, and the caller surfaces that.
  await recordProof(db, {
    tenantId: input.tenantId,
    orderId: input.orderId,
    capturedByUserId: input.actorUserId,
    recipientName: input.recipientName,
    photoKey: input.photoKey,
    signatureKey: input.signatureKey,
    lat: input.lat,
    lng: input.lng,
    accuracyM: input.accuracyM,
  });

  // 2. Status. If this fails the evidence still stands — the job may already have been
  // closed by someone in the office — so the caller is told rather than the capture lost.
  let transitionProblem: string | null = null;
  try {
    await transitionOrder(db, {
      tenantId: input.tenantId,
      orderId: input.orderId,
      to: "delivered",
      actorUserId: input.actorUserId,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError || err instanceof OrderValidationError) {
      transitionProblem = `Proof saved, but the job could not be marked delivered: ${err.message}`;
    } else {
      throw err;
    }
  }

  // 3. Receipt. Read the order back AFTER the writes so the address and reference are the
  // stored ones, not whatever the form happened to carry.
  const order = await findOrder(db, input.tenantId, input.orderId);
  const receipt = await sendDeliveryReceipt({
    to: order?.customerEmail ?? null,
    operatorName: input.operatorName,
    reference: order?.reference ?? "",
    // The TRACKING link, not the console route. The console route requires a session, so
    // the receipt previously emailed customers a page they could not open — a receipt
    // only its sender can read is not a receipt.
    certificateUrl: order?.publicToken
      ? `${input.origin}/t/${order.publicToken}`
      : `${input.origin}/dashboard/${input.tenantId}/orders/${input.orderId}/proof.pdf`,
    subscription: input.subscription,
  });

  // A transition problem outranks a receipt one: it is about the JOB, not a courtesy.
  return {
    notice: transitionProblem ?? describeReceipt(receipt, input.operatorName),
    receipt,
  };
}
