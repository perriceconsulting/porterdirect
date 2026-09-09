/**
 * One job, as a driver sees it.
 *
 * The whole screen is the next action. Where it is going, how to get there, how to reach
 * the customer, and the one button that moves it on — in that order, because that is the
 * order a person standing outside a building needs them in.
 *
 * This is where two earlier decisions finally pay off:
 *   E.164 phone storage      -> a `tel:` link that dials correctly without the driver
 *                               retyping anything.
 *   STRUCTURED addresses     -> a maps query built from real parts, rather than a
 *                               free-text line guessed at by a geocoder.
 * Both were argued for on those grounds long before anything used them.
 */
import { notFound } from "next/navigation";
import { can } from "@porterdirect/auth";
import { formatAddressInline, formatAddressLines, formatPhone, type CountryCode } from "@porterdirect/contact";
import { STATUS_LABELS, isTerminal, nextStatuses, statusTone } from "@porterdirect/orders";
import { SiteHeader } from "../../../_components/site-header";
import { ProofCapture } from "../../../_components/proof-capture";
import { driveProofAction, driveTransitionAction } from "../../actions";
import { requireConsole } from "../../../../lib/console";
import {
  dropoffAddressOf,
  findOrder,
  findProof,
  pickupAddressOf,
} from "../../../../lib/orders";
import { isStorageConfigured, presignProofDownload } from "../../../../lib/storage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Job — PorterDirect" };

/** A maps link built from the parts, so the geocoder gets structure rather than prose. */
function mapsHref(address: ReturnType<typeof dropoffAddressOf>): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    formatAddressInline(address),
  )}`;
}

export default async function DriveJob({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; orderId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId, orderId } = await params;
  const { error } = await searchParams;

  const { db, membership, userId } = await requireConsole(tenantId, "orders:read:assigned");
  const order = await findOrder(db, tenantId, orderId);
  if (!order) notFound();

  // A driver may only open their own work, even inside their own tenant. An owner using
  // this surface can open anything they are permitted to — the LIST is "mine", but a
  // deep link is still governed by the same rule the console uses.
  const mayView = can(membership.role, "orders:read:all") || order.assignedUserId === userId;
  if (!mayView) notFound();

  const status = order.status;
  const dropoff = dropoffAddressOf(order);
  const pickup = pickupAddressOf(order);
  const proof = await findProof(db, tenantId, orderId);
  const mayUpdate = can(membership.role, "orders:update:assigned");

  const forward = mayUpdate
    ? nextStatuses(order.type, status).filter((m) => m !== "cancelled" && m !== "failed")
    : [];
  const mayCaptureProof = !proof && status === "en_route" && mayUpdate;
  const captureReplacesDelivered = mayCaptureProof && isStorageConfigured();
  const moves = captureReplacesDelivered ? forward.filter((m) => m !== "delivered") : forward;

  const photoUrl = proof?.photoKey ? await presignProofDownload(proof.photoKey) : null;
  const signatureUrl = proof?.signatureKey ? await presignProofDownload(proof.signatureKey) : null;

  // Before pickup the driver is going to the COLLECTION point; after it, to the customer.
  const heading = status === "pending" || status === "assigned" ? pickup : dropoff;
  const headingLabel = heading === pickup ? "Collect from" : "Deliver to";
  const tone = statusTone(status);

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href={`/drive/${tenantId}`}>
          All jobs
        </a>
      </SiteHeader>

      <main className="drive">
        <p className="eyebrow">
          <a href={`/drive/${tenantId}`}>← Back</a>
        </p>

        <div className="drive-head">
          <span className={tone === "neutral" ? "pill" : `pill ${tone}`}>
            {STATUS_LABELS[status]}
          </span>
          <span className="mono">{order.reference}</span>
        </div>

        <h1 className="drive-title">{headingLabel}</h1>
        <address className="drive-address">
          {formatAddressLines(heading).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </address>

        {/* The two things a driver reaches for, as full-width targets rather than links
            buried in a table. Navigation first: it is what they need before arriving. */}
        <div className="drive-actions">
          <a className="btn btn-primary drive-btn" href={mapsHref(heading)} target="_blank" rel="noopener">
            Navigate
          </a>
          {order.customerPhone ? (
            <a className="btn btn-quiet drive-btn" href={`tel:${order.customerPhone}`}>
              Call {order.customerFirstName}
            </a>
          ) : null}
        </div>

        <dl className="drive-facts">
          <div>
            <dt>Customer</dt>
            <dd>
              {order.customerFirstName} {order.customerLastName}
              {order.customerPhone ? (
                <>
                  {" "}
                  <span className="mono">
                    {formatPhone(order.customerPhone, order.dropoffCountry as CountryCode)}
                  </span>
                </>
              ) : null}
            </dd>
          </div>
          {heading === pickup ? (
            <div>
              <dt>Then deliver to</dt>
              <dd>{formatAddressInline(dropoff)}</dd>
            </div>
          ) : (
            <div>
              <dt>Collected from</dt>
              <dd>{formatAddressInline(pickup)}</dd>
            </div>
          )}
          {order.notes ? (
            <div>
              <dt>Notes</dt>
              <dd>{order.notes}</dd>
            </div>
          ) : null}
        </dl>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {/* THE action. One button, full width, at the bottom where a thumb is. */}
        {moves.length > 0 ? (
          <div className="drive-actions drive-actions-primary">
            {moves.map((to) => (
              <form action={driveTransitionAction} key={to}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="orderId" value={orderId} />
                <input type="hidden" name="to" value={to} />
                <button className="btn btn-primary drive-btn" type="submit">
                  {to === "en_route" ? "Picked up — on the way" : STATUS_LABELS[to]}
                </button>
              </form>
            ))}
          </div>
        ) : null}

        {mayCaptureProof ? (
          isStorageConfigured() ? (
            <section className="drive-proof">
              <h2 className="drive-subhead">Proof of delivery</h2>
              <ProofCapture tenantId={tenantId} orderId={orderId} action={driveProofAction} />
            </section>
          ) : (
            <p className="hint">Proof cannot be captured: storage is not configured.</p>
          )
        ) : null}

        {proof ? (
          <section className="drive-proof">
            <h2 className="drive-subhead">Delivered</h2>
            {proof.recipientName ? <p className="sub">Received by {proof.recipientName}</p> : null}
            <div className="proof-media">
              {signatureUrl ? (
                <figure>
                  <img src={signatureUrl} alt="Recipient signature" />
                  <figcaption>Signature</figcaption>
                </figure>
              ) : null}
              {photoUrl ? (
                <figure>
                  <img src={photoUrl} alt="Proof of delivery photograph" />
                  <figcaption>Photo</figcaption>
                </figure>
              ) : null}
            </div>
          </section>
        ) : null}

        {isTerminal(status) && !proof ? (
          <p className="hint">This job is {STATUS_LABELS[status].toLowerCase()}.</p>
        ) : null}

        {/* Closing a job as failed needs a reason, and that is a decision better made with
            the office than alone at a door — so it links back rather than being inlined. */}
        {!isTerminal(status) && mayUpdate ? (
          <p className="alt">
            <a href={`/dashboard/${tenantId}/orders/${orderId}`}>
              Something wrong? Report a problem with this job
            </a>
          </p>
        ) : null}
      </main>
    </>
  );
}
