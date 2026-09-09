/**
 * The delivery receipt, and the promise the ENVELOPE cannot yet keep.
 *
 * The certificate is anonymous — proven elsewhere. Mail is not: it leaves from one shared
 * address, so a recipient who checks the sender sees us rather than the courier they
 * hired. For the lower tiers that is cosmetic. For an Agency tenant it is a line item
 * they pay for, so the send is withheld rather than quietly undone.
 *
 * These tests exist because that gate is the difference between a known limitation and a
 * broken promise, and nothing else in the suite would notice if it were removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeReceipt,
  looksLikeEmail,
  sendDeliveryReceipt,
  type ReceiptInput,
} from "../lib/delivery-receipt";

const sent: Array<{ to: string; subject: string; text: string }> = [];

vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(async (email: { to: string; subject: string; text: string }) => {
    if (email.to === "bounce@example.test") throw new Error("Email provider rejected the message");
    sent.push(email);
  }),
}));

const BASE: ReceiptInput = {
  to: "customer@example.test",
  operatorName: "Meridian White Glove",
  reference: "ORD-9GTFF6",
  certificateUrl: "https://porterdirect.com/dashboard/t/orders/o/proof.pdf",
  subscription: { planId: "direct_courier", status: "active" },
};

const send = (over: Partial<ReceiptInput> = {}) => sendDeliveryReceipt({ ...BASE, ...over });

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("email shape checking is deliberately permissive", () => {
  it("accepts the addresses people actually have", () => {
    // Plus-tags, subdomains and long TLDs are all real. Every "clever" regex in this
    // space is famous for rejecting somebody's genuine address.
    for (const ok of [
      "a@b.co",
      "marisol.vega@example.com",
      "j+receipts@mail.example.co.uk",
      "ops@dispatch.acmecouriers.london",
    ]) {
      expect(looksLikeEmail(ok), ok).toBe(true);
    }
  });

  it("catches the typo it exists for", () => {
    for (const bad of ["", "   ", "no-at-sign", "two@@at.com", "trailing@dot.", "@nolocal.com"]) {
      expect(looksLikeEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the anonymity gate", () => {
  it("WITHHOLDS the receipt for a tenant that bought platform anonymity", async () => {
    // The whole point. Sending would hand their customer our name at the exact moment the
    // operator most needs to look like a standalone business.
    const outcome = await send({
      subscription: { planId: "white_label_agency", status: "active" },
    });
    expect(outcome.status).toBe("withheld-anonymity");
    expect(sent).toHaveLength(0);
  });

  it("sends for tiers that do not sell anonymity", async () => {
    for (const planId of ["direct_courier", "fleet_freight"]) {
      sent.length = 0;
      const outcome = await send({ subscription: { planId, status: "active" } });
      expect(outcome.status, planId).toBe("sent");
      expect(sent, planId).toHaveLength(1);
    }
  });

  it("sends for a LAPSED agency tenant, because the capability lapses with the plan", async () => {
    // Follows `tenantAllows`, which requires the plan AND entitlement. Worth asserting:
    // it would be easy to key the gate on the plan alone and quietly keep withholding.
    const outcome = await send({
      subscription: { planId: "white_label_agency", status: "canceled" },
    });
    expect(outcome.status).toBe("sent");
  });

  it("explains the withholding in words an operator can act on", () => {
    const message = describeReceipt({ status: "withheld-anonymity" }, "Meridian White Glove");
    expect(message).toContain("Meridian White Glove");
    expect(message).toMatch(/send it from your own address/i);
  });
});

describe("a receipt never costs a delivery", () => {
  it("reports a provider failure instead of throwing", async () => {
    // The job is DONE. Failing the delivery because a courtesy email bounced would undo
    // real work over a message.
    const outcome = await send({ to: "bounce@example.test" });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toMatch(/rejected/i);
  });

  it("says nothing when no address was given", async () => {
    // Plenty of courier work is booked by phone. Silence is correct; a warning on every
    // such job is noise that trains people to ignore warnings.
    const outcome = await send({ to: null });
    expect(outcome.status).toBe("no-address");
    expect(describeReceipt(outcome, "Meridian White Glove")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("does not send to a malformed address", async () => {
    expect((await send({ to: "not-an-address" })).status).toBe("no-address");
    expect(sent).toHaveLength(0);
  });
});

describe("what the customer reads", () => {
  it("names the OPERATOR in the subject and the body", async () => {
    await send();
    const [message] = sent;
    expect(message!.subject).toContain("Meridian White Glove");
    expect(message!.subject).toContain("ORD-9GTFF6");
    expect(message!.text).toContain("Meridian White Glove");
    // The parts a person actually reads carry the operator's name, even while the
    // envelope address cannot yet.
    expect(message!.text).toMatch(/on behalf of Meridian White Glove/);
  });

  it("links the certificate rather than attaching a copy", async () => {
    // A link resolves to the CURRENT record; an attachment is a snapshot that keeps a
    // corrected recipient name wrong forever.
    await send();
    expect(sent[0]!.text).toContain("/proof.pdf");
  });
});
