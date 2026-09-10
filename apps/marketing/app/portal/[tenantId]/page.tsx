/**
 * The customer portal: book a delivery, and watch the ones you booked.
 *
 * WHITE-LABELLED, like the tracking page and for the same reason. This is a surface a
 * tenant's own client uses regularly, so the operator's name is the header and ours
 * appears nowhere — not in the title, not in the OpenGraph block, not in a footer. The
 * tracking page taught this the hard way: it looked anonymous while serving
 * `og:title = "PorterDirect — white-label logistics platform"` by inheritance.
 *
 * WHAT IT WITHHOLDS is the design, again. A customer sees the jobs THEY booked and
 * nothing else: not the operator's other work, not a driver's identity, not the driver's
 * pay. They see the price only once the operator has set one, because until then there
 * genuinely is not one.
 */
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { createDbClient, tenants } from "@porterdirect/db";
import { ORDER_TYPES, STATUS_LABELS, TYPE_LABELS, statusTone } from "@porterdirect/orders";
import { formatAddressLines, type CountryCode } from "@porterdirect/contact";
import { AddressFields } from "../../_components/address-fields";
import { PhoneField } from "../../_components/phone-field";
import { signOutAction } from "../../actions";
import { dropoffAddressOf, formatOrderPrice } from "../../../lib/orders";
import { listPortalOrders, requirePortal } from "../../../lib/portal";
import { bookDeliveryAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const db = createDbClient(process.env.DATABASE_URL);
  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const operator = tenant?.name ?? "Deliveries";
  // Every inherited field overridden, not just the title — the root layout's
  // `applicationName` and OpenGraph block would otherwise put our product name on a page
  // a customer bookmarks.
  return {
    title: `Book a delivery — ${operator}`,
    description: `Book and track deliveries with ${operator}.`,
    applicationName: operator,
    robots: { index: false, follow: false },
    openGraph: { type: "website", siteName: operator, title: `Deliveries — ${operator}`, images: [] },
    twitter: { card: "summary", title: `Deliveries — ${operator}` },
  };
}

export default async function CustomerPortal({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ error?: string; booked?: string }>;
}) {
  const { tenantId } = await params;
  const notice = await searchParams;
  await headers();

  const { db, account, tenant } = await requirePortal(tenantId);
  const mine = await listPortalOrders(db, tenantId, account.id);

  return (
    <main className="console">
      <div className="shell">
        <div className="console-head">
          <div>
            {/* The OPERATOR'S name is the masthead. There is no PorterDirect wordmark. */}
            <p className="eyebrow">{tenant.name}</p>
            <h1 className="console-title">Your deliveries</h1>
          </div>
          <form action={signOutAction}>
            <button className="btn btn-quiet" type="submit">
              Sign out
            </button>
          </form>
        </div>

        {notice.error ? (
          <p className="error" role="alert">
            {notice.error}
          </p>
        ) : null}
        {notice.booked ? (
          <p className="notice" role="status">
            Booked. {tenant.name} will confirm the price and assign a driver.
          </p>
        ) : null}

        <section className="panel">
          <h2 className="panel-title">
            Your bookings{mine.length ? ` — ${mine.length}` : ""}
          </h2>
          {mine.length === 0 ? (
            <p className="sub">Nothing booked yet. Use the form below to request a collection.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Deliver to</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Price</th>
                    <th scope="col">Track</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.reference}</td>
                      <td>
                        {formatAddressLines(dropoffAddressOf(o)).map((line, i) => (
                          <span key={line} className={i === 0 ? undefined : "hint"}>
                            {line}
                            <br />
                          </span>
                        ))}
                      </td>
                      <td>
                        <span
                          className={
                            statusTone(o.status) === "neutral" ? "pill" : `pill ${statusTone(o.status)}`
                          }
                        >
                          {STATUS_LABELS[o.status]}
                        </span>
                      </td>
                      {/* "Needs pricing" until the operator sets one. Showing $0.00 would
                          be a different and wrong claim. */}
                      <td className="num">{formatOrderPrice(o.priceCents)}</td>
                      <td>
                        {o.publicToken ? (
                          <a className="ref-link" href={`/t/${o.publicToken}`}>
                            Track
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Book a collection</h2>
          <p className="sub">
            Tell {tenant.name} where to collect from and where it goes. They confirm the
            price before a driver is assigned.
          </p>

          <form action={bookDeliveryAction} className="entry-form">
            <input type="hidden" name="tenantId" value={tenantId} />

            <fieldset className="field-group">
              <legend>Who is receiving it</legend>
              {/* The RECIPIENT, who is routinely not the person booking: a firm books a
                  delivery to a court, a lab books a collection from a clinic. */}
              <div className="row-2">
                <div className="field">
                  <label htmlFor="recipientFirstName">First name</label>
                  <input id="recipientFirstName" name="recipientFirstName" required />
                </div>
                <div className="field">
                  <label htmlFor="recipientLastName">Last name</label>
                  <input id="recipientLastName" name="recipientLastName" required />
                </div>
              </div>
              <PhoneField
                name="recipientPhone"
                label="Their phone"
                country={tenant.defaultCountry as CountryCode}
                hint="So the driver can reach them at the door."
              />
              <div className="field">
                <label htmlFor="recipientEmail">Their email (optional)</label>
                <input id="recipientEmail" name="recipientEmail" type="email" autoComplete="off" />
                <span className="hint">Where the delivery receipt goes.</span>
              </div>
            </fieldset>

            <AddressFields prefix="pickup" legend="Collect from" country={tenant.defaultCountry} />
            <AddressFields prefix="dropoff" legend="Deliver to" country={tenant.defaultCountry} />

            <fieldset className="field-group">
              <legend>The job</legend>
              <div className="row-2">
                <div className="field">
                  <label htmlFor="type">Type</label>
                  <select id="type" name="type" defaultValue="fixed_pickup">
                    {ORDER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="scheduledFor">Needed by</label>
                  <input id="scheduledFor" name="scheduledFor" type="datetime-local" />
                  <span className="hint">Required for a scheduled courier run.</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="notes">Anything the driver should know</label>
                <input id="notes" name="notes" />
              </div>
              {/*
                THERE IS NO PRICE FIELD, deliberately. What the job costs is the operator's
                decision, and a booking that carried its own amount would let anyone name
                what they pay.
              */}
            </fieldset>

            <div className="form-actions">
              <button className="btn btn-primary" type="submit">
                Request collection
              </button>
            </div>
          </form>
        </section>

        <footer className="track-foot">Deliveries by {tenant.name}</footer>
      </div>
    </main>
  );
}
