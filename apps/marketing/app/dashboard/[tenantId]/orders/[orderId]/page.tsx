/**
 * One job: its details, the moves it can legally make, and its full history.
 *
 * The buttons come from `nextStatuses`, which is the same table `canTransition` guards
 * with — so the UI cannot offer a move the server would then refuse. Offering an action
 * that fails is worse than not offering it.
 */
import { notFound } from "next/navigation";
import { can } from "@porterdirect/auth";
import { formatUsdCents } from "@porterdirect/billing";
import { formatAddressLines, formatPhone, type CountryCode } from "@porterdirect/contact";
import {
  CLOSURE_REASON_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  isLocationVisible,
  isRedispatchable,
  isTerminal,
  nextStatuses,
  reasonsFor,
  statusTone,
  type ClosureReason,
} from "@porterdirect/orders";
import { SiteHeader } from "../../../../_components/site-header";
import { signOutAction } from "../../../../actions";
import { redispatchOrderAction, transitionOrderAction } from "../actions";
import { requireConsole } from "../../../../../lib/console";
import {
  dropoffAddressOf,
  findOrder,
  findRedispatch,
  findRedispatchOrigin,
  listOrderEvents,
  pickupAddressOf,
} from "../../../../../lib/orders";

export const dynamic = "force-dynamic";

export default async function OrderDetail({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; orderId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId, orderId } = await params;
  const { error } = await searchParams;

  const { db, tenant, membership, userId } = await requireConsole(tenantId, "orders:read:assigned");
  const order = await findOrder(db, tenantId, orderId);
  if (!order) notFound();

  // A driver may only open their own work, even inside their own tenant.
  const mayView = can(membership.role, "orders:read:all") || order.assignedUserId === userId;
  if (!mayView) notFound();

  const events = await listOrderEvents(db, tenantId, orderId);
  const redispatch = await findRedispatch(db, tenantId, orderId);
  const origin = await findRedispatchOrigin(db, tenantId, order);
  const status = order.status;
  const type = order.type;
  const moves = can(membership.role, "orders:update:assigned") ? nextStatuses(type, status) : [];
  // Split, because closing a job needs a reason and moving it forward does not.
  const closers = moves.filter((m): m is "cancelled" | "failed" => m === "cancelled" || m === "failed");
  const forward = moves.filter((m) => m !== "cancelled" && m !== "failed");
  const tracking = isLocationVisible(status);

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href={`/dashboard/${tenantId}/orders`}>
          Dispatch
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
              <p className="eyebrow">{tenant.name}</p>
              <h1 className="console-title">{order.reference}</h1>
            </div>
            {/* Tone by OUTCOME, from the domain. This branched on `isTerminal`, which is
                also true of a failed job — so a job that never arrived wore the success
                green. Nothing below the browser could see it. */}
            <span className={statusTone(status) === "neutral" ? "pill" : `pill ${statusTone(status)}`}>
              {STATUS_LABELS[status]}
            </span>
          </div>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="console-grid">
            <section className="panel">
              <h2 className="panel-title">Job</h2>
              <ul className="status-list">
                <li>
                  <span className="k">Type</span>
                  <span className="v">{TYPE_LABELS[type]}</span>
                </li>
                <li>
                  <span className="k">Customer</span>
                  <span className="v">
                    {order.customerFirstName} {order.customerLastName}
                  </span>
                </li>
                {order.customerPhone ? (
                  <li>
                    <span className="k">Phone</span>
                    <span className="v">
                      {formatPhone(order.customerPhone, tenant.defaultCountry as CountryCode)}
                    </span>
                  </li>
                ) : null}
                <li>
                  <span className="k">Pick up</span>
                  {/* Rendered line by line, in the order that country writes them — a
                      label read off a parcel has to look native to whoever reads it. */}
                  <span className="v addr">
                    {formatAddressLines(pickupAddressOf(order)).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                </li>
                <li>
                  <span className="k">Deliver to</span>
                  <span className="v addr">
                    {formatAddressLines(dropoffAddressOf(order)).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                </li>
                {order.scheduledFor ? (
                  <li>
                    <span className="k">Scheduled for</span>
                    <span className="v">
                      {order.scheduledFor.toISOString().replace("T", " ").slice(0, 16)}
                    </span>
                  </li>
                ) : null}
                <li>
                  <span className="k">Price</span>
                  <span className="v">{formatUsdCents(order.priceCents)}</span>
                </li>
                {order.closureReason ? (
                  <li>
                    <span className="k">Why it ended</span>
                    <span className="v">
                      {CLOSURE_REASON_LABELS[order.closureReason as ClosureReason]}
                      {order.closureNote ? ` — ${order.closureNote}` : ""}
                    </span>
                  </li>
                ) : null}
                {origin ? (
                  <li>
                    <span className="k">Re-attempt of</span>
                    <span className="v">
                      <a href={`/dashboard/${tenantId}/orders/${origin.id}`}>{origin.reference}</a>
                    </span>
                  </li>
                ) : null}
                {redispatch ? (
                  <li>
                    <span className="k">Re-dispatched as</span>
                    <span className="v">
                      <a href={`/dashboard/${tenantId}/orders/${redispatch.id}`}>
                        {redispatch.reference}
                      </a>
                    </span>
                  </li>
                ) : null}
                {order.notes ? (
                  <li>
                    <span className="k">Notes</span>
                    <span className="v">{order.notes}</span>
                  </li>
                ) : null}
              </ul>

              {/*
                Stated explicitly because it is a legal position, not a UI detail: driver
                location is tied to THIS order's status, and ends when the order does.
              */}
              <p className="hint" style={{ marginTop: "0.9rem" }}>
                {tracking
                  ? "Driver location is visible for this job while it is live, and stops the moment it closes."
                  : "Driver location is not visible: this job is not live."}
              </p>
            </section>

            <section className="panel">
              <h2 className="panel-title">Move this job</h2>
              {moves.length === 0 ? (
                <>
                  <p className="sub">
                    {isTerminal(status)
                      ? `This job is ${STATUS_LABELS[status].toLowerCase()}. Terminal states cannot be reopened.`
                      : "Your role cannot move this job."}
                  </p>

                  {/* A failed job is re-attempted as a NEW order, never by reopening
                      this one — reopening would rewrite the first attempt's history and
                      erase its failure from the operator's numbers. */}
                  {status === "failed" &&
                  can(membership.role, "orders:create") &&
                  !redispatch &&
                  (!order.closureReason ||
                    isRedispatchable(order.closureReason as ClosureReason)) ? (
                    <form action={redispatchOrderAction} className="form-actions">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="orderId" value={orderId} />
                      <button className="btn btn-primary" type="submit">
                        Try again — raise a new job
                      </button>
                    </form>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="moves">
                    {forward.map((to) => (
                      <form action={transitionOrderAction} key={to}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="orderId" value={orderId} />
                        <input type="hidden" name="to" value={to} />
                        <button className="btn btn-primary" type="submit">
                          {STATUS_LABELS[to]}
                        </button>
                      </form>
                    ))}
                  </div>

                  {/* Closing a job is not one click. It has to say WHY, because "nobody
                      home" typed forty ways cannot be counted — and counting is the only
                      way dispatch gets better. */}
                  {closers.map((to) => (
                    <form action={transitionOrderAction} key={to} className="close-form">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="orderId" value={orderId} />
                      <input type="hidden" name="to" value={to} />
                      <div className="field">
                        <label htmlFor={`reason-${to}`}>
                          {to === "cancelled" ? "Cancel this job" : "Mark it failed"}
                        </label>
                        <select id={`reason-${to}`} name="reason" defaultValue="">
                          <option value="" disabled>
                            Choose a reason…
                          </option>
                          {reasonsFor(to).map((r) => (
                            <option key={r} value={r}>
                              {CLOSURE_REASON_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`note-${to}`}>Note (optional)</label>
                        <input id={`note-${to}`} name="note" />
                      </div>
                      <div className="form-actions">
                        <button className="btn btn-quiet" type="submit">
                          {to === "cancelled" ? "Cancel job" : "Mark failed"}
                        </button>
                      </div>
                    </form>
                  ))}
                </>
              )}
            </section>
          </div>

          <section className="panel">
            <h2 className="panel-title">History</h2>
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={i}>
                  <span className="when">{e.createdAt.toISOString().replace("T", " ").slice(0, 16)}</span>
                  <span className="what">
                    <strong>{STATUS_LABELS[e.toStatus]}</strong>
                    {e.fromStatus ? ` — from ${STATUS_LABELS[e.fromStatus]}` : ""}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                  <span className="who">{e.actorName ?? "system"}</span>
                </li>
              ))}
            </ol>
            <p className="hint">
              Append-only. This is the chain-of-custody trail — who moved the job, when,
              and from what.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
