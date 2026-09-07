/**
 * The operator console.
 *
 * The PRD's "back-office dashboard" is the FLEET surface — a live map, on-shift drivers,
 * an audit trail of who viewed whom. That surface presumes orders, drivers and shifts,
 * none of which exist yet, and pretending otherwise with a fake map would be worse than
 * an honest gap.
 *
 * What a tenant needs the moment they pay is the surface the PRD never names: connect
 * your domain, get your team in, see what you are being charged. That is this page. It
 * shows the real state of the account and is explicit about what is not built, because
 * an empty widget labelled "Live map" would imply a feature that does not exist.
 */
import { formatUsdCents, getPlan, computeMonthlyTotalCents, isEntitled } from "@porterdirect/billing";
import { can } from "@porterdirect/auth";
import { SiteHeader } from "../../_components/site-header";
import { signOutAction } from "../../actions";
import { openBillingPortalAction } from "./actions";
import { listTeam, requireConsole } from "../../../lib/console";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  try {
    const { tenant } = await requireConsole(tenantId, "orders:read:assigned");
    return { title: `${tenant.name} — PorterDirect` };
  } catch {
    return { title: "Console — PorterDirect" };
  }
}

export default async function Console({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  // The lowest permission every role holds — this page is the console's front door, and
  // what it SHOWS is gated per-section below rather than by locking the whole page.
  const ctx = await requireConsole(tenantId, "orders:read:assigned");
  const { tenant, membership, subscription, db, userId } = ctx;

  const team = can(membership.role, "members:read") ? await listTeam(db, tenantId, userId) : [];
  const plan = subscription ? getPlan(subscription.planId) : null;
  const monthly =
    subscription && plan ? computeMonthlyTotalCents(plan.id, subscription.seatCount) : null;

  const domainConnected = Boolean(tenant.host);
  const teamInvited = team.length > 1;
  const billingActive = subscription ? isEntitled(subscription.status) : false;

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href="/dashboard">
          Accounts
        </a>
        <form action={signOutAction}>
          <button className="btn btn-quiet" type="submit">
            Sign out
          </button>
        </form>
      </SiteHeader>

      <main className="console">
        <div className="shell">
          <div className="console-head">
            <div>
              <p className="eyebrow">Operator console</p>
              <h1 className="console-title">{tenant.name}</h1>
            </div>
            <span className={billingActive ? "pill" : "pill warn"}>
              {subscription?.status ?? "no subscription"}
            </span>
          </div>

          {/* Setup checklist. Real state, not decoration — each row reflects a query. */}
          <section className="panel">
            <h2 className="panel-title">Get set up</h2>
            <ol className="checklist">
              <li className={billingActive ? "done" : ""}>
                <span className="tick" aria-hidden="true">
                  {billingActive ? "✓" : "1"}
                </span>
                <div>
                  <strong>Subscription active</strong>
                  <p>
                    {subscription && plan
                      ? `${plan.name}, ${subscription.seatCount} seat${subscription.seatCount === 1 ? "" : "s"}.`
                      : "Waiting for payment confirmation from Stripe."}
                  </p>
                </div>
              </li>
              <li className={domainConnected ? "done" : ""}>
                <span className="tick" aria-hidden="true">
                  {domainConnected ? "✓" : "2"}
                </span>
                <div>
                  <strong>Point your domain at us</strong>
                  <p>
                    {domainConnected ? (
                      <>
                        Add a CNAME for <code>{tenant.host}</code> pointing to{" "}
                        <code>cname.porterdirect.com</code>. We cannot verify DNS yet, so
                        this step is not ticked automatically.
                      </>
                    ) : (
                      "No dispatch domain set for this account."
                    )}
                  </p>
                </div>
              </li>
              <li className={teamInvited ? "done" : ""}>
                <span className="tick" aria-hidden="true">
                  {teamInvited ? "✓" : "3"}
                </span>
                <div>
                  <strong>Invite your dispatchers</strong>
                  <p>
                    {teamInvited
                      ? `${team.length} people on this account.`
                      : "You are the only person on this account. Invites are not built yet."}
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <div className="console-grid">
            <section className="panel">
              <h2 className="panel-title">Subscription</h2>
              {subscription && plan ? (
                <ul className="status-list">
                  <li>
                    <span className="k">Plan</span>
                    <span className="v">{plan.name}</span>
                  </li>
                  <li>
                    <span className="k">Seats</span>
                    <span className="v">
                      {subscription.seatCount} of {plan.includedSeats} included
                    </span>
                  </li>
                  <li>
                    <span className="k">Monthly</span>
                    <span className="v">{monthly === null ? "—" : formatUsdCents(monthly)}</span>
                  </li>
                  <li>
                    <span className="k">
                      {subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}
                    </span>
                    <span className="v">
                      {subscription.currentPeriodEnd
                        ? subscription.currentPeriodEnd.toISOString().slice(0, 10)
                        : "—"}
                    </span>
                  </li>
                </ul>
              ) : (
                <p className="sub">
                  No subscription recorded yet. Payment confirmations arrive from Stripe a
                  moment after checkout.
                </p>
              )}

              {can(membership.role, "billing:manage") ? (
                <form action={openBillingPortalAction} className="form-actions">
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <button className="btn btn-quiet" type="submit">
                    Manage billing
                  </button>
                </form>
              ) : (
                <p className="hint">Only an owner can manage billing.</p>
              )}
            </section>

            <section className="panel">
              <h2 className="panel-title">Team</h2>
              {can(membership.role, "members:read") ? (
                <ul className="status-list">
                  {team.map((m) => (
                    <li key={m.userId}>
                      <span className="k">
                        {m.name}
                        {m.isYou ? " (you)" : ""}
                        <br />
                        <span className="hint">{m.email}</span>
                      </span>
                      <span className="pill">{m.role}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sub">Your role does not include seeing the roster.</p>
              )}
            </section>
          </div>

          <section className="panel">
            <h2 className="panel-title">Dispatch</h2>
            <p className="sub">
              Create and move jobs, and see the full chain-of-custody trail for each one.
            </p>
            <p className="form-actions">
              <a className="btn btn-primary" href={`/dashboard/${tenantId}/orders`}>
                Open the dispatch board
              </a>
            </p>
          </section>

          {/*
            Still named honestly. An empty widget labelled "Live map" would imply a
            feature that exists; saying plainly that it does not is more useful.
          */}
          <section className="panel muted">
            <h2 className="panel-title">Live fleet map</h2>
            <p className="sub">
              Driver apps, shifts and the live map are not built yet. Location is already
              modelled as visible only while an order is live — see any job's detail page —
              but nothing is reporting positions into it.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
