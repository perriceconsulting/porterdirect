/**
 * The dispatch board: this tenant's jobs, and the form to add one.
 *
 * What a viewer sees depends on their role. A dispatcher sees the whole board; a DRIVER
 * sees only their own assigned work, because location and job visibility are scoped to
 * the order rather than to the fleet — that scoping is what makes the privacy promise
 * enforceable rather than aspirational.
 */
import { can } from "@porterdirect/auth";
import { formatUsdCents } from "@porterdirect/billing";
import { STATUS_LABELS, TYPE_LABELS, isTerminal, type OrderStatus, type OrderType } from "@porterdirect/orders";
import { SiteHeader } from "../../../_components/site-header";
import { signOutAction } from "../../../actions";
import { createOrderAction } from "./actions";
import { requireConsole } from "../../../../lib/console";
import { listOrders } from "../../../../lib/orders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dispatch — PorterDirect" };

const CREATABLE_TYPES: OrderType[] = ["fixed_pickup", "scheduled_courier", "shop_in_store", "errand"];

function statusClass(status: OrderStatus): string {
  if (status === "delivered") return "pill";
  if (status === "cancelled" || status === "failed") return "pill warn";
  return "pill neutral";
}

export default async function OrdersBoard({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId } = await params;
  const { error } = await searchParams;

  const ctx = await requireConsole(tenantId, "orders:read:assigned");
  const { db, tenant, membership, userId } = ctx;

  const seesEverything = can(membership.role, "orders:read:all");
  const all = await listOrders(db, tenantId);
  // A driver's board is their own work only. Filtered here rather than in the query so
  // the tenant scoping stays the single WHERE clause everything else relies on.
  const visible = seesEverything ? all : all.filter((o) => o.assignedUserId === userId);

  const live = visible.filter((o) => !isTerminal(o.status));
  const done = visible.filter((o) => isTerminal(o.status));

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href={`/dashboard/${tenantId}`}>
          Console
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
              <h1 className="console-title">Dispatch</h1>
            </div>
          </div>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}

          <section className="panel">
            <h2 className="panel-title">
              Live jobs{live.length ? ` — ${live.length}` : ""}
            </h2>
            {live.length === 0 ? (
              <p className="sub">
                {seesEverything
                  ? "Nothing on the board. Create a job below."
                  : "You have no assigned jobs right now."}
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Type</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <a href={`/dashboard/${tenantId}/orders/${o.id}`} className="ref-link">
                            {o.reference}
                          </a>
                        </td>
                        <td>
                          {o.customerFirstName} {o.customerLastName}
                          <br />
                          <span className="hint">{o.dropoffAddress}</span>
                        </td>
                        <td>{TYPE_LABELS[o.type]}</td>
                        <td>
                          <span className={statusClass(o.status)}>
                            {STATUS_LABELS[o.status]}
                          </span>
                        </td>
                        <td className="num">{formatUsdCents(o.priceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {done.length > 0 ? (
            <section className="panel">
              <h2 className="panel-title">Closed — {done.length}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Outcome</th>
                      <th scope="col" className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {done.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <a href={`/dashboard/${tenantId}/orders/${o.id}`} className="ref-link">
                            {o.reference}
                          </a>
                        </td>
                        <td>
                          {o.customerFirstName} {o.customerLastName}
                        </td>
                        <td>
                          <span className={statusClass(o.status)}>
                            {STATUS_LABELS[o.status]}
                          </span>
                        </td>
                        <td className="num">{formatUsdCents(o.priceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {can(membership.role, "orders:create") ? (
            <section className="panel">
              <h2 className="panel-title">New job</h2>
              <form action={createOrderAction}>
                <input type="hidden" name="tenantId" value={tenantId} />

                {/* First and last separately: one free-text name cannot tell two
                    customers called John Smith apart. Deliberately NOT unique — two
                    customers genuinely can share a name, and the phone is what
                    identifies them (and what masked calling will key off). */}
                <div className="row-2">
                  <div className="field">
                    <label htmlFor="customerFirstName">Customer first name</label>
                    <input id="customerFirstName" name="customerFirstName" required />
                  </div>
                  <div className="field">
                    <label htmlFor="customerLastName">Customer last name</label>
                    <input id="customerLastName" name="customerLastName" required />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="customerPhone">Customer phone</label>
                  <input id="customerPhone" name="customerPhone" type="tel" inputMode="tel" />
                  <span className="hint">
                    How this customer is identified — two people can share a name.
                  </span>
                </div>

                <div className="field">
                  <label htmlFor="pickupAddress">Pick up from</label>
                  <input id="pickupAddress" name="pickupAddress" required />
                </div>

                <div className="field">
                  <label htmlFor="dropoffAddress">Deliver to</label>
                  <input id="dropoffAddress" name="dropoffAddress" required />
                </div>

                <div className="row-2">
                  <div className="field">
                    <label htmlFor="type">Job type</label>
                    <select id="type" name="type" defaultValue="fixed_pickup">
                      {CREATABLE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="price">Price</label>
                    <input
                      id="price"
                      name="price"
                      inputMode="decimal"
                      placeholder="49.50"
                      defaultValue="0"
                    />
                    <span className="hint">In dollars. Stored as whole cents.</span>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="scheduledFor">Scheduled for</label>
                  <input id="scheduledFor" name="scheduledFor" type="datetime-local" />
                  <span className="hint">
                    Required for a scheduled courier run — the exact time window is the
                    product for that type.
                  </span>
                </div>

                <div className="field">
                  <label htmlFor="notes">Notes for the driver</label>
                  <input id="notes" name="notes" />
                </div>

                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Create job
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
