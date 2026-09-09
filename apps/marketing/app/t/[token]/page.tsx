/**
 * The customer's tracking page. `/t/<token>` — no login, no account, no app.
 *
 * The FIRST surface in this product a tenant's own customer ever sees, which makes two
 * things absolute:
 *
 *   ANONYMITY. This page carries the operator's name and nothing of ours. It is the
 *   white-label promise made concrete — everything else so far has been an internal tool
 *   or a PDF. If our name appears here, "run your fleet under your own brand" is a
 *   sentence on a pricing page rather than a product.
 *
 *   RESTRAINT. The token grants a stranger a view of one delivery, so this shows only
 *   what the recipient already knows or is entitled to: where it is going, what stage it
 *   is at, and — once delivered — the proof. Deliberately NOT here: the price (a business
 *   arrangement between the operator and whoever booked it), the customer's phone number,
 *   the driver's identity, and anything at all about the operator's other work.
 *
 * A wrong or expired token says the same thing as a well-formed one that matches nothing.
 * Distinguishing them would turn this into an oracle for guessing links.
 */
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { createDbClient, tenants } from "@porterdirect/db";
import { formatAddressLines } from "@porterdirect/contact";
import { STATUS_LABELS, isTerminal, statusTone } from "@porterdirect/orders";
import {
  dropoffAddressOf,
  findOrderByPublicToken,
  findProof,
} from "../../../lib/orders";
import { presignProofDownload } from "../../../lib/storage";

export const dynamic = "force-dynamic";

/** What a person waiting for a parcel wants said, in their words rather than ours. */
const CUSTOMER_STATUS: Record<string, { headline: string; detail: string }> = {
  pending: {
    headline: "Booked",
    detail: "Your delivery has been booked and is waiting to be assigned to a driver.",
  },
  assigned: {
    headline: "Driver assigned",
    detail: "A driver has your delivery and will collect it shortly.",
  },
  en_route: {
    headline: "On the way",
    detail: "Your delivery is with the driver and on its way to you.",
  },
  delivered: { headline: "Delivered", detail: "Your delivery has been completed." },
  cancelled: {
    headline: "Cancelled",
    detail: "This delivery was called off. Contact the sender if you were expecting it.",
  },
  failed: {
    headline: "Could not be delivered",
    detail: "The driver attempted this delivery and could not complete it.",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = createDbClient(process.env.DATABASE_URL);
  const order = await findOrderByPublicToken(db, token);
  if (!order) return { title: "Delivery" };
  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, order.tenantId))
    .limit(1);
  // The browser tab is part of the brand surface. Ours must not appear in it either.
  return {
    title: `${order.reference} — ${tenant?.name ?? "Delivery"}`,
    robots: { index: false, follow: false },
  };
}

export default async function TrackDelivery({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = createDbClient(process.env.DATABASE_URL);

  const order = await findOrderByPublicToken(db, token);
  // One answer for "no such token", "malformed" and "not yours". Anything else is a way
  // to probe which links exist.
  if (!order) notFound();

  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, order.tenantId))
    .limit(1);
  if (!tenant) notFound();

  const proof = await findProof(db, order.tenantId, order.id);
  const signatureUrl = proof?.signatureKey ? await presignProofDownload(proof.signatureKey) : null;
  const photoUrl = proof?.photoKey ? await presignProofDownload(proof.photoKey) : null;

  const copy = CUSTOMER_STATUS[order.status] ?? {
    headline: STATUS_LABELS[order.status],
    detail: "",
  };
  const tone = statusTone(order.status);

  return (
    <main className="track">
      {/* The operator's name IS the header. There is no PorterDirect wordmark on this
          page, and no link back to us. */}
      <header className="track-head">
        <p className="track-operator">{tenant.name}</p>
        <span className={tone === "neutral" ? "pill" : `pill ${tone}`}>
          {STATUS_LABELS[order.status]}
        </span>
      </header>

      <h1 className="track-headline">{copy.headline}</h1>
      {copy.detail ? <p className="track-detail">{copy.detail}</p> : null}

      <dl className="track-facts">
        <div>
          <dt>Reference</dt>
          <dd className="mono">{order.reference}</dd>
        </div>
        <div>
          <dt>Delivering to</dt>
          <dd>
            {formatAddressLines(dropoffAddressOf(order)).map((l) => (
              <span key={l}>{l}</span>
            ))}
          </dd>
        </div>
        {order.scheduledFor && !isTerminal(order.status) ? (
          <div>
            <dt>Scheduled for</dt>
            <dd>{order.scheduledFor.toISOString().replace("T", " ").slice(0, 16)} UTC</dd>
          </div>
        ) : null}
      </dl>

      {proof ? (
        <section className="track-proof">
          <h2 className="track-subhead">Proof of delivery</h2>
          {proof.recipientName ? <p className="track-detail">Received by {proof.recipientName}</p> : null}
          <p className="track-detail">
            {proof.capturedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
          </p>

          <div className="proof-media">
            {signatureUrl ? (
              <figure>
                <img src={signatureUrl} alt="Signature taken at delivery" />
                <figcaption>Signature</figcaption>
              </figure>
            ) : null}
            {photoUrl ? (
              <figure>
                <img src={photoUrl} alt="Photograph taken at delivery" />
                <figcaption>Photo</figcaption>
              </figure>
            ) : null}
          </div>

          <p className="track-actions">
            <a className="btn btn-primary" href={`/t/${token}/proof.pdf`}>
              Download certificate
            </a>
          </p>
        </section>
      ) : null}

      {/* Says who is responsible for the delivery — the operator. A customer with a
          question needs to know who to ask, and it is never us. */}
      <footer className="track-foot">Delivered by {tenant.name}</footer>
    </main>
  );
}
