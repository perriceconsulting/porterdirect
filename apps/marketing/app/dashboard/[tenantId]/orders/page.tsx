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
import {
  ORDER_TYPES,
  STATUS_LABELS,
  TYPE_LABELS,
  isTerminal,
  statusTone,
  type OrderStatus,
  type OrderType,
} from "@porterdirect/orders";
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

/**
 * Every order type is creatable today. Derived rather than listed so the form cannot
 * silently stop offering a type that the domain still supports — if the two ever need to
 * differ, that is a product decision worth writing down here, not a list that drifted.
 */
const CREATABLE_TYPES: readonly OrderType[] = ORDER_TYPES;

/** Tone comes from the domain, never from this file — see `statusTone`. */
function statusClass(status: OrderStatus): string {
  const tone = statusTone(status);
  return tone === "neutral" ? "pill" : `pill ${tone}`;
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
  // A driver's board is their own work only, narrowed IN THE QUERY. Filtering after the
  // fetch meant taking the most recent 50 rows and then discarding other drivers' — so on
  // a busy tenant a driver whose job was not among the newest saw an empty board, and it
  // read as "no work today" rather than as a bug.
  const visible = await listOrders(db, tenantId, {
    assignedTo: seesEverything ? undefined : userId,
  });

  const live = visible.filter((o) => !isTerminal(o.status));
  const done = visible.filter((o) => isTerminal(o.status));

  return (
    <>
      <SiteHeader>
        {/* An owner or dispatcher may also be driving today. Without this the driver
            surface is reachable only by typing a URL, which is how a built feature stays
            unused. */}
        <a className="btn btn-quiet" href={`/drive/${tenantId}`}>
          Drive
        </a>
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
