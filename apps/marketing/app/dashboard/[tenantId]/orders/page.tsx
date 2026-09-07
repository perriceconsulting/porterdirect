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
import { formatAddressLines, formatPhone, type CountryCode } from "@porterdirect/contact";
import { SiteHeader } from "../../../_components/site-header";
import { PhoneField } from "../../../_components/phone-field";
import { AddressFields } from "../../../_components/address-fields";
import { signOutAction } from "../../../actions";
import { createOrderAction } from "./actions";
import { requireConsole } from "../../../../lib/console";
import { dropoffAddressOf, listOrders } from "../../../../lib/orders";

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
                      {/* Where it is going is the first thing a dispatcher scans for,
                          and it had no column at all — the address only appeared when a
                          job happened to have no phone number. */}
                      <th scope="col">Deliver to</th>
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
                          {o.customerPhone ? (
                            <>
                              <br />
                              <span className="hint">
                                {formatPhone(o.customerPhone, tenant.defaultCountry as CountryCode)}
                              </span>
                            </>
                          ) : null}
                        </td>
                        <td>
                          {/* Through the formatter, not hand-joined. Joining the parts
                              with ", " here produced "Washington, DC, 20500" — the extra
                              comma before the ZIP is precisely what formatAddressLines
                              exists to get right, and bypassing it reintroduced the bug. */}
                          {formatAddressLines(dropoffAddressOf(o)).map((line, i) => (
                            <span key={line} className={i === 0 ? undefined : "hint"}>
                              {line}
                              <br />
                            </span>
                          ))}
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
                      <th scope="col">Deliver to</th>
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
                        <td className="hint">
                          {[o.dropoffCity, o.dropoffRegion].filter(Boolean).join(", ")}
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
              <form action={createOrderAction} className="entry-form">
                <input type="hidden" name="tenantId" value={tenantId} />

                {/* Grouped into the three things an operator is actually entering: who
                    it is for, where it goes, and what the job is. A flat run of seven
                    fields reads as one undifferentiated list. */}
                <fieldset className="field-group group-customer">
                  <legend>Customer</legend>

                  {/* First and last separately: one free-text name cannot tell two
                      customers called John Smith apart. Deliberately NOT unique — two
                      customers genuinely can share a name, and the phone is what
                      identifies them (and what masked calling will key off). */}
                  <div className="row-2">
                    <div className="field">
                      <label htmlFor="customerFirstName">First name</label>
                      <input id="customerFirstName" name="customerFirstName" required />
                    </div>
                    <div className="field">
                      <label htmlFor="customerLastName">Last name</label>
                      <input id="customerLastName" name="customerLastName" required />
                    </div>
                  </div>

                  <PhoneField
                    name="customerPhone"
                    label="Phone"
                    country={tenant.defaultCountry as CountryCode}
                    hint="How this customer is identified — two people can share a name."
                  />
                </fieldset>

                <AddressFields
                  prefix="pickup"
                  legend="Pick up from"
                  country={tenant.defaultCountry}
                />

                <AddressFields
                  prefix="dropoff"
                  legend="Deliver to"
                  country={tenant.defaultCountry}
                />

                <fieldset className="field-group group-job">
                  <legend>Job</legend>

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
                      <input id="price" name="price" inputMode="decimal" placeholder="49.50" />
                      <span className="hint">In dollars, e.g. 49.50.</span>
                    </div>
                  </div>

                  {/* Paired so the Job group keeps the same field measure as the two
                      groups above it. Spanning both columns made these stretch to the
                      full panel width, which is the problem the measure cap solved. */}
                  <div className="row-2">
                    <div className="field">
                      <label htmlFor="scheduledFor">Scheduled for</label>
                      <input id="scheduledFor" name="scheduledFor" type="datetime-local" />
                      <span className="hint">
                        Scheduled courier runs only — the exact time window is the product
                        for that type.
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor="notes">Notes for the driver</label>
                      <input id="notes" name="notes" />
                    </div>
                  </div>
                </fieldset>

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
