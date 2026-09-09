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
import { requireConsole } from "../../../lib/console";
import { dropoffAddressOf, listOrders } from "../../../lib/orders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Drive — PorterDirect" };

export default async function DriveBoard({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  // `orders:read:assigned` is held by every role, so this refuses only a non-member.
  const { db, tenant, userId } = await requireConsole(tenantId, "orders:read:assigned");

  // Always narrowed to this person, in the query. Even an owner opening /drive is asking
  // "what am I carrying", not "what does my company have on".
  const mine = await listOrders(db, tenantId, { assignedTo: userId, limit: 100 });
  const live = mine.filter((o) => !isTerminal(o.status));
  const doneToday = mine.filter((o) => isTerminal(o.status)).slice(0, 5);

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

        {live.length === 0 ? (
          <p className="sub">
            When a dispatcher assigns you a job it appears here. Nothing to do right now.
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

        {doneToday.length > 0 ? (
          <>
            <h2 className="drive-subhead">Finished</h2>
            <ul className="drive-list drive-list-quiet">
              {doneToday.map((o) => (
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
