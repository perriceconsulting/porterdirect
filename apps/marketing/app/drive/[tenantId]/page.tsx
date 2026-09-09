/**
 * A driver's jobs.
 *
 * Deliberately NOT the dispatch board with things hidden. What a driver needs is a short
 * list of where to go next, in tap-sized pieces, with everything else absent rather than
 * merely collapsed.
 *
 * What is missing, and why each is missing:
 *   PRICE       — a driver does not collect it, and showing it invites a conversation at
 *                 the door that they have no authority to have.
 *   HISTORY     — the chain-of-custody trail is an office artefact. It answers disputes,
 *                 not "where am I going".
 *   OTHER JOBS  — the list is scoped to this person's own work regardless of role, because
 *                 this surface means "mine", not "everything I am permitted to see".
 */
import { notFound } from "next/navigation";
import { STATUS_LABELS, isTerminal, statusTone } from "@porterdirect/orders";
import { formatAddressInline } from "@porterdirect/contact";
import { SiteHeader } from "../../_components/site-header";
import { signOutAction } from "../../actions";
import { can } from "@porterdirect/auth";
import { requireConsole } from "../../../lib/console";
import { dropoffAddressOf, listOffersFor, listOrders } from "../../../lib/orders";
import { claimOrderAction, declineOrderAction } from "../actions";
import { formatUsdCents } from "@porterdirect/billing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Drive — PorterDirect" };

export default async function DriveBoard({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId } = await params;
  const { error } = await searchParams;
  // `orders:read:assigned` is held by every role, so this refuses only a non-member.
  const { db, tenant, membership, userId } = await requireConsole(tenantId, "orders:read:assigned");

  // Always narrowed to this person, in the query. Even an owner opening /drive is asking
  // "what am I carrying", not "what does my company have on".
  const mine = await listOrders(db, tenantId, { assignedTo: userId, limit: 100 });
  const live = mine.filter((o) => !isTerminal(o.status));
  // Two, not five. A driver mid-shift wants confirmation of what they just finished, not
  // a history — and on a phone every finished row pushes the actual work further away.
  const recentlyDone = mine.filter((o) => isTerminal(o.status)).slice(0, 2);

  // Work nobody has taken. Shown ABOVE their own jobs only when they have none: a driver
  // carrying a parcel should see the parcel first, not a list of other things to take on.
  const offers = can(membership.role, "orders:claim")
    ? await listOffersFor(db, tenantId, userId)
    : [];

  if (!tenant) notFound();

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href={`/dashboard/${tenantId}/orders`}>
          Office view
        </a>
        <form action={signOutAction}>
          <button className="btn btn-quiet" type="submit">
            Sign out
          </button>
        </form>
      </SiteHeader>

      <main className="drive">
        <p className="eyebrow">{tenant.name}</p>
        <h1 className="drive-title">
          {live.length === 0
            ? "Nothing assigned to you"
            : live.length === 1
              ? "1 job"
              : `${live.length} jobs`}
        </h1>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {live.length === 0 ? (
          <p className="sub">
            {offers.length > 0
              ? "Nothing assigned to you yet — there are offers below."
              : "When a dispatcher assigns you a job it appears here. Nothing to do right now."}
          </p>
        ) : (
          <ul className="drive-list">
            {live.map((o) => {
              const tone = statusTone(o.status);
              return (
                <li key={o.id}>
                  <a href={`/drive/${tenantId}/${o.id}`} className="drive-card">
                    {/* The destination is the headline. It is the one thing a driver is
                        looking for, so it is not competing with a reference number. */}
                    <span className="drive-card-main">
                      {formatAddressInline(dropoffAddressOf(o))}
                    </span>
                    <span className="drive-card-meta">
                      <span className={tone === "neutral" ? "pill" : `pill ${tone}`}>
                        {STATUS_LABELS[o.status]}
                      </span>
                      <span className="mono">{o.reference}</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        {offers.length > 0 ? (
          <>
            <h2 className="drive-subhead">
              Offers {offers.length > 1 ? `— ${offers.length}` : ""}
            </h2>
            <ul className="drive-list">
              {offers.map((o) => (
                <li key={o.id} className="drive-offer">
                  {/* The AMOUNT is the headline. A driver deciding whether to accept is
                      deciding on the money — burying it under an address would be asking
                      them to answer a question the screen has not asked.
                      This is DRIVER PAY, never the customer price: the margin between
                      them is the operator's business, and showing it to everyone who
                      declines would hand every driver their rate card. */}
                  <span className="drive-offer-pay">
                    {o.driverPayCents === null
                      ? "Not priced"
                      : formatUsdCents(o.driverPayCents)}
                  </span>
                  <span className="drive-card-main">
                    {formatAddressInline(dropoffAddressOf(o))}
                  </span>
                  <span className="drive-card-meta">
                    <span className="mono">{o.reference}</span>
                  </span>

                  <div className="drive-offer-actions">
                    {/* Submits, not links: accepting and refusing are both WRITES, and
                        the accept resolves in the database so two drivers cannot win. */}
                    <form action={claimOrderAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="orderId" value={o.id} />
                      <button
                        className="btn btn-primary drive-btn"
                        type="submit"
                        disabled={o.driverPayCents === null}
                      >
                        Accept
                      </button>
                    </form>
                    <form action={declineOrderAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="orderId" value={o.id} />
                      <button className="btn btn-quiet drive-btn" type="submit">
                        Decline
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {recentlyDone.length > 0 ? (
          <>
            <h2 className="drive-subhead">Just finished</h2>
            <ul className="drive-list drive-list-quiet">
              {recentlyDone.map((o) => (
                <li key={o.id}>
                  <a href={`/drive/${tenantId}/${o.id}`} className="drive-card">
                    <span className="drive-card-main">
                      {formatAddressInline(dropoffAddressOf(o))}
                    </span>
                    <span className="drive-card-meta">
                      <span
                        className={
                          statusTone(o.status) === "neutral"
                            ? "pill"
                            : `pill ${statusTone(o.status)}`
                        }
                      >
                        {STATUS_LABELS[o.status]}
                      </span>
                      <span className="mono">{o.reference}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </main>
    </>
  );
}
