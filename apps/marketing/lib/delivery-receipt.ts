/**
 * Sending the delivery receipt to the customer.
 *
 * The certificate itself is anonymous — it carries the operator's name and nothing of
 * ours. **The envelope is not.** Mail leaves from a single shared address, so a recipient
 * who looks at the sender sees us rather than the courier they hired.
 *
 * For the $199 and $499 tiers that is a cosmetic gap: those plans do not sell anonymity.
 * For an Agency tenant it is a BROKEN PROMISE — "100% platform anonymity" is a line item
 * they pay for — so this refuses to send on their behalf rather than quietly undoing it,
 * and says why. An operator who is told "we did not send this, here is the certificate"
 * can act; one whose customer receives mail from their supplier's supplier cannot.
 *
 * The real fix is a verified sending domain per tenant, which is a provisioning job
 * rather than a code one. This is the honest interim, and it fails toward the promise.
 */
import { tenantAllows, type TenantSubscription } from "@porterdirect/billing";
import { sendEmail } from "./email";

export type ReceiptOutcome =
  | { readonly status: "sent" }
  | { readonly status: "no-address" }
  | { readonly status: "withheld-anonymity" }
  | { readonly status: "failed"; readonly reason: string };

export interface ReceiptInput {
  readonly to: string | null;
  readonly operatorName: string;
  readonly reference: string;
  readonly certificateUrl: string;
  readonly subscription: Pick<TenantSubscription, "planId" | "status"> | null;
}

/**
 * A shape check, not a validity check.
 *
 * Deliberately permissive: the only authority on whether an address exists is the server
 * that accepts it, and every "clever" regex in this space rejects real addresses. This
 * catches a typo like a missing `@`, and nothing more.
 */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
}

export async function sendDeliveryReceipt(input: ReceiptInput): Promise<ReceiptOutcome> {
  if (!input.to || !looksLikeEmail(input.to)) return { status: "no-address" };

  // The gate. An Agency tenant bought anonymity; sending from our shared address would
  // hand their customer our name at the exact moment the operator looks most like a
  // standalone business.
  if (tenantAllows(input.subscription, "platform_anonymity")) {
    return { status: "withheld-anonymity" };
  }

  try {
    await sendEmail({
      to: input.to,
      // The operator's name in the subject and body — the parts a person actually reads.
      subject: `Your delivery from ${input.operatorName} — ${input.reference}`,
      text:
        `Your delivery ${input.reference} has been completed by ${input.operatorName}.\n\n` +
        `A signed proof-of-delivery certificate is available here:\n` +
        `${input.certificateUrl}\n\n` +
        `This message was sent on behalf of ${input.operatorName}.\n`,
    });
    return { status: "sent" };
  } catch (err) {
    // Never fail the DELIVERY because the receipt bounced. The job is done; the email is
    // a courtesy, and an operator told "delivered, receipt not sent" can resend.
    return { status: "failed", reason: err instanceof Error ? err.message : "unknown" };
  }
}

/** What to tell the operator, in their words rather than a status code. */
export function describeReceipt(outcome: ReceiptOutcome, operatorName: string): string | null {
  switch (outcome.status) {
    case "sent":
      return null;
    case "no-address":
      return null; // Nothing was promised; saying so on every job would be noise.
    case "withheld-anonymity":
      return (
        `Receipt not sent automatically: ${operatorName} is on a plan that guarantees ` +
        `platform anonymity, and outbound mail would carry our sending address. ` +
        `Download the certificate and send it from your own address.`
      );
    case "failed":
      return "The job is delivered, but the receipt could not be emailed. Try sending the certificate manually.";
  }
}
