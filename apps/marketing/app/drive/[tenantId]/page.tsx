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
import { dropoffAddressOf, listClaimableOrders, listOrders } from "../../../lib/orders";
import { claimOrderAction } from "../actions";

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
  const claimable = can(membership.role, "orders:claim")
    ? await listClaimableOrders(db, tenantId)
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
            {claimable.length > 0
              ? "Nothing assigned to you yet — take one of the jobs below."
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

        {claimable.length > 0 ? (
          <>
            <h2 className="drive-subhead">
              Available {claimable.length > 1 ? `— ${claimable.length} jobs` : ""}
            </h2>
            <ul className="drive-list">
              {claimable.map((o) => (
                <li key={o.id}>
                  <form action={claimOrderAction} className="drive-claim">
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="orderId" value={o.id} />
                    <span className="drive-card-main">
                      {formatAddressInline(dropoffAddressOf(o))}
                    </span>
                    <span className="drive-card-meta">
                      <span className="mono">{o.reference}</span>
                    </span>
                    {/* A submit rather than a link: taking a job is a WRITE, and the
                        claim resolves in the database so two drivers cannot both win. */}
                    <button className="btn btn-primary drive-btn" type="submit">
                      Take this job
                    </button>
                  </form>
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
