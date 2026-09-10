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
import { invitableRoles } from "@porterdirect/auth";
import { listTeam, requireConsole } from "../../../lib/console";
import { listPendingInvitations } from "../../../lib/invitations";
import { inviteMemberAction, revokeInvitationAction } from "./team-actions";
import { ORDER_TYPES, TYPE_LABELS } from "@porterdirect/orders";
import { loadRateCard, metresToMiles } from "../../../lib/rate-cards";
import { saveRateCardAction, setCustomerSignupAction } from "./pricing-actions";
import {
  inviteCustomerAction,
  revokeCustomerInvitationAction,
  setCustomerStatusAction,
} from "./customer-actions";
import { listCustomers, listPendingCustomerInvitations } from "../../../lib/customers";

/**
 * Cents back to the dollars an operator typed, for a form default.
 *
 * NOT `formatUsdCents`: that produces "$8" for display, and a currency symbol in a text
 * input is then re-parsed on the next save. This is the input's own round trip, so it
 * must give back exactly what was typed — and it drops nothing, because "8" and "8.00"
 * both parse to 800 but only one of them reads as a rate.
 */
function dollars(cents: number | undefined): string {
  if (cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

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
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{
    error?: string;
    invited?: string;
    customerError?: string;
    customerInvited?: string;
    priceError?: string;
    priced?: string;
    signup?: string;
  }>;
}) {
  const { tenantId } = await params;
  const notice = await searchParams;
  // The lowest permission every role holds — this page is the console's front door, and
  // what it SHOWS is gated per-section below rather than by locking the whole page.
  const ctx = await requireConsole(tenantId, "orders:read:assigned");
  const { tenant, membership, subscription, db, userId } = ctx;

  const team = can(membership.role, "members:read") ? await listTeam(db, tenantId, userId) : [];
  const mayManage = can(membership.role, "members:manage");
  const pending = mayManage ? await listPendingInvitations(db, tenantId) : [];
  const grantable = invitableRoles(membership.role);
  // Pricing is a settings decision, not a dispatch one — a dispatcher moves work, they
  // do not set what the firm charges. Same permission the action re-checks.
  const maySetPricing = can(membership.role, "tenant:settings");
  // The same permission the export route re-checks: a fleet-wide read of customer data,
  // so a driver confined to their own work cannot download the whole company's history.
  const seesEverything = can(membership.role, "orders:read:all");
  const rateCard = maySetPricing ? await loadRateCard(db, tenantId) : null;
  const customers = maySetPricing ? await listCustomers(db, tenantId) : [];
  const pendingCustomers = maySetPricing ? await listPendingCustomerInvitations(db, tenantId) : [];
  const plan = subscription ? getPlan(subscription.planId) : null;
  const monthly =
    subscription && plan ? computeMonthlyTotalCents(plan.id, subscription.seatCount) : null;

  // Default the export to the last full month, which is the period a client actually
  // asks about. Computed here rather than in the form so both inputs agree.
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const monthAgo = new Date(today.getTime());
  monthAgo.setUTCMonth(monthAgo.getUTCMonth() - 1);
  const defaultFrom = monthAgo.toISOString().slice(0, 10);

  const domainConnected = Boolean(tenant.host);
  const teamInvited = team.length > 1 || pending.length > 0;
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
            <span className={billingActive ? "pill good" : "pill warn"}>
              {subscription?.status ?? "no subscription"}
            </span>
          </div>

          {notice.error ? (
            <p className="error" role="alert">
              {notice.error}
            </p>
          ) : null}
          {notice.invited ? (
            <p className="notice" role="status">
              Invitation sent to {notice.invited}.
            </p>
          ) : null}
          {notice.customerInvited ? (
            <p className="notice" role="status">
              Customer invitation sent to {notice.customerInvited}.
            </p>
          ) : null}
          {notice.customerError ? (
            <p className="error" role="alert">
              {notice.customerError}
            </p>
          ) : null}

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
                      ? `${team.length} on the team${pending.length ? `, ${pending.length} invite${pending.length === 1 ? "" : "s"} pending` : ""}.`
                      : "You are the only person on this account. Invite your dispatchers and drivers below."}
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
                  {pending.map((inv) => (
                    <li key={inv.id}>
                      <span className="k">
                        {inv.email}
                        <br />
                        <span className="hint">
                          invited · expires {inv.expiresAt.toISOString().slice(0, 10)}
                        </span>
                      </span>
                      <span className="invite-row">
                        <span className="pill warn">{inv.role}</span>
                        <form action={revokeInvitationAction}>
                          <input type="hidden" name="tenantId" value={tenantId} />
                          <input type="hidden" name="invitationId" value={inv.id} />
                          <button className="btn btn-quiet btn-small" type="submit">
                            Withdraw
                          </button>
                        </form>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sub">Your role does not include seeing the roster.</p>
              )}

              {mayManage && grantable.length > 0 ? (
                <form action={inviteMemberAction} style={{ marginTop: "1.1rem" }}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <div className="field">
                    <label htmlFor="inviteEmail">Invite by email</label>
                    <input id="inviteEmail" name="email" type="email" required />
                  </div>
                  <div className="field">
                    <label htmlFor="inviteRole">Role</label>
                    <select id="inviteRole" name="role" defaultValue={grantable[grantable.length - 1]}>
                      {grantable.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <span className="hint">
                      A driver sees only their own assigned jobs — never the fleet.
                    </span>
                  </div>
                  <div className="form-actions">
                    <button className="btn btn-quiet" type="submit">
                      Send invitation
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          </div>

          {maySetPricing ? (
            <section className="panel">
              <h2 className="panel-title">Pricing</h2>
              <p className="sub">
                What you charge, so a customer booking their own job can be quoted. Leave
                this unset and every booking simply arrives unpriced for you to price by
                hand — nothing breaks, you just do it yourself.
              </p>

              {notice.priceError ? (
                <p className="error" role="alert">
                  {notice.priceError}
                </p>
              ) : null}
              {notice.priced ? (
                <p className="notice" role="status">
                  Rate card saved.
                </p>
              ) : null}

              <form action={saveRateCardAction} className="entry-form">
                <input type="hidden" name="tenantId" value={tenantId} />

                {ORDER_TYPES.map((type) => (
                  <fieldset className="field-group" key={type}>
                    <legend>{TYPE_LABELS[type]}</legend>
                    <div className="row-2">
                      <div className="field">
                        <label htmlFor={`${type}_base`}>Base fare</label>
                        <input
                          id={`${type}_base`}
                          name={`${type}_base`}
                          inputMode="decimal"
                          placeholder="8.00"
                          defaultValue={dollars(rateCard?.rates[type].baseCents)}
                        />
                        <span className="hint">Charged before a single mile.</span>
                      </div>
                      <div className="field">
                        <label htmlFor={`${type}_perMile`}>Per mile</label>
                        <input
                          id={`${type}_perMile`}
                          name={`${type}_perMile`}
                          inputMode="decimal"
                          placeholder="2.50"
                          defaultValue={dollars(rateCard?.rates[type].perMileCents)}
                        />
                      </div>
                    </div>
                    <div className="row-2">
                      <div className="field">
                        <label htmlFor={`${type}_minimum`}>Minimum charge</label>
                        <input
                          id={`${type}_minimum`}
                          name={`${type}_minimum`}
                          inputMode="decimal"
                          placeholder="15.00"
                          defaultValue={dollars(rateCard?.rates[type].minimumCents)}
                        />
                        <span className="hint">
                          The floor. A two-block run still costs you a driver and a van.
                        </span>
                      </div>
                    </div>
                  </fieldset>
                ))}

                <fieldset className="field-group">
                  <legend>Limits</legend>
                  <div className="row-2">
                    <div className="field">
                      <label htmlFor="driverPayPercent">Driver share</label>
                      <input
                        id="driverPayPercent"
                        name="driverPayPercent"
                        inputMode="numeric"
                        placeholder="65"
                        defaultValue={rateCard?.driverPayPercent ?? ""}
                      />
                      {/* Not optional. A job on the offer board with no pay cannot be
                          accepted at all, so a quoted booking must arrive with one. */}
                      <span className="hint">
                        Whole percent of the price paid to the driver. This becomes the
                        amount on their offer.
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor="maxQuotableMiles">Quote up to</label>
                      <input
                        id="maxQuotableMiles"
                        name="maxQuotableMiles"
                        inputMode="decimal"
                        placeholder="50"
                        defaultValue={
                          rateCard?.maxQuotableMeters ? metresToMiles(rateCard.maxQuotableMeters) : ""
                        }
                      />
                      <span className="hint">
                        Miles. Past this, a booking comes to you unpriced instead of being
                        quoted — an automatic price is one you are bound to. Blank for no
                        limit.
                      </span>
                    </div>
                  </div>
                </fieldset>

                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Save rate card
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {maySetPricing ? (
            <section className="panel">
              <h2 className="panel-title">Customer accounts</h2>
              <p className="sub">
                Customers with an account book their own jobs and watch them without
                phoning you.
              </p>
              <form action={setCustomerSignupAction} className="entry-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <div className="field">
                  <label htmlFor="mode">Who may open an account</label>
                  <select id="mode" name="mode" defaultValue={tenant.customerSignup}>
                    <option value="invite_only">Only firms I invite</option>
                    <option value="open">Anyone who signs up</option>
                  </select>
                  <span className="hint">
                    {tenant.customerSignup === "open"
                      ? "Anyone can register and create real work on your board."
                      : "Strangers cannot register. You invite the firms you already deal with."}
                  </span>
                </div>
                <div className="form-actions">
                  <button className="btn" type="submit">
                    Save
                  </button>
                </div>
              </form>

              {customers.length > 0 ? (
                <ul className="team-list">
                  {customers.map((c) => (
                    <li key={c.id}>
                      <div>
                        <strong>{c.companyName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()}</strong>
                        <p className="hint">{c.email}</p>
                      </div>
                      <span className={c.status === "active" ? "pill" : "pill warn"}>{c.status}</span>
                      {/* Blocked rather than deleted: the row carries the provenance of
                          every job they booked. */}
                      <form action={setCustomerStatusAction}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="customerId" value={c.id} />
                        <input
                          type="hidden"
                          name="status"
                          value={c.status === "active" ? "blocked" : "active"}
                        />
                        <button className="btn btn-quiet" type="submit">
                          {c.status === "active" ? "Block" : "Unblock"}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : null}

              {pendingCustomers.length > 0 ? (
                <ul className="team-list">
                  {pendingCustomers.map((i) => (
                    <li key={i.id}>
                      <div>
                        <strong>{i.email}</strong>
                        <p className="hint">
                          invited · expires {i.expiresAt.toISOString().slice(0, 10)}
                        </p>
                      </div>
                      <form action={revokeCustomerInvitationAction}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="invitationId" value={i.id} />
                        <button className="btn btn-quiet" type="submit">
                          Withdraw
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The half that was missing: the panel had a setting and no way to invite
                  anybody, which is a control for a feature with no door. */}
              <form action={inviteCustomerAction} className="entry-form">
                <input type="hidden" name="tenantId" value={tenantId} />
                <div className="row-2">
                  <div className="field">
                    <label htmlFor="customerEmail">Invite by email</label>
                    <input id="customerEmail" name="email" type="email" required />
                  </div>
                  <div className="field">
                    <label htmlFor="customerCompany">Their company (optional)</label>
                    <input id="customerCompany" name="companyName" />
                  </div>
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Send invitation
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {seesEverything ? (
            <section className="panel">
              <h2 className="panel-title">Evidence pack</h2>
              <p className="sub">
                What you hand a client. Three files: the deliveries you ran for them, the
                chain of custody for each one, and who has opened the evidence since.
              </p>
              {/*
                A plain GET form, so each button is a normal download with no JavaScript.
                The route re-authorizes and records the download as an access in its own
                right — taking a period's records out is the largest read the product
                offers, and an audit log that could not see it would be a strange thing to
                sell.
              */}
              <form method="get" action={`/dashboard/${tenantId}/exports`} className="entry-form">
                <fieldset className="field-group">
                  <legend>Period</legend>
                  <div className="row-2">
                    <div className="field">
                      <label htmlFor="from">From</label>
                      <input id="from" name="from" type="date" defaultValue={defaultFrom} required />
                    </div>
                    <div className="field">
                      <label htmlFor="to">To</label>
                      <input id="to" name="to" type="date" defaultValue={defaultTo} required />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="kind">Document</label>
                    <select id="kind" name="kind" defaultValue="deliveries">
                      <option value="deliveries">Deliveries — what you carried, and when</option>
                      <option value="custody">Chain of custody — who held it, and when</option>
                      <option value="access">Access log — who has opened the evidence</option>
                    </select>
                    <span className="hint">
                      Opens in a spreadsheet. The access log names your own staff, so send
                      it deliberately rather than with every invoice.
                    </span>
                  </div>
                </fieldset>
                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Download
                  </button>
                </div>
              </form>
            </section>
          ) : null}

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
