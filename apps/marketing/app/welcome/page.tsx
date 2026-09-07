/**
 * Post-checkout landing.
 *
 * This page reads the DATABASE, not the Stripe Checkout session. The subscription row
 * is written by the webhook, and Stripe redirects the browser back before that webhook
 * necessarily lands — so a page that reported "active" from the redirect would be
 * asserting something it has not verified. Showing "confirming" until the row exists is
 * the honest state, and it is also the true one: entitlement derives from our mirror of
 * Stripe, never from a URL the browser was handed.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { createDbClient, subscriptions, tenants } from "@porterdirect/db";
import { isEntitled, type SubscriptionStatus } from "@porterdirect/billing";
import { listMembershipsForUser } from "@porterdirect/auth";
import { getAuth } from "../../lib/auth";
import { signOutAction } from "../actions";

export const metadata = { title: "Your account — PorterDirect" };
export const dynamic = "force-dynamic";

interface TenantRow {
  id: string;
  name: string;
  host: string | null;
  role: string;
  status: SubscriptionStatus | null;
  seats: number | null;
}

export default async function Welcome({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/signin");

  const db = createDbClient(process.env.DATABASE_URL);
  const memberships = await listMembershipsForUser(db, session.user.id);

  const rows: TenantRow[] = [];
  for (const membership of memberships) {
    const [tenant] = await db
      .select({ id: tenants.id, name: tenants.name, host: tenants.primaryHost })
      .from(tenants)
      .where(eq(tenants.id, membership.tenantId))
      .limit(1);
    if (!tenant) continue;

    const [sub] = await db
      .select({ status: subscriptions.status, seats: subscriptions.seatCount })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenant.id))
      .limit(1);

    rows.push({
      ...tenant,
      role: membership.role,
      status: (sub?.status as SubscriptionStatus | undefined) ?? null,
      seats: sub?.seats ?? null,
    });
  }

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="wordmark" href="/">
            Porter<span>Direct</span>
          </a>
          <nav className="header-nav" aria-label="Main">
            <form action={signOutAction}>
              <button className="btn btn-quiet" type="submit">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Welcome, {session.user.name || session.user.email}</h1>
          <p className="sub">Your operator accounts.</p>

          {params.error === "checkout-failed" ? (
            <p className="error" role="alert">
              Your account was created, but we could not start checkout. Nothing has been
              charged — pick your plan again to continue.
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p className="sub">
              No operator account yet. <a href="/signup">Start a subscription</a>.
            </p>
          ) : (
            rows.map((row) => (
              <section key={row.id} style={{ marginTop: "1.5rem" }}>
                <h2 style={{ fontSize: "1.15rem", margin: "0 0 0.25rem" }}>{row.name}</h2>
                <ul className="status-list">
                  <li>
                    <span className="k">Dispatch domain</span>
                    <span className="v">{row.host ?? "—"}</span>
                  </li>
                  <li>
                    <span className="k">Your role</span>
                    <span className="v">{row.role}</span>
                  </li>
                  <li>
                    <span className="k">Subscription</span>
                    <span>
                      {row.status === null ? (
                        <span className="pill warn">Confirming</span>
                      ) : (
                        <span className={isEntitled(row.status) ? "pill" : "pill warn"}>
                          {row.status}
                        </span>
                      )}
                    </span>
                  </li>
                  {row.seats !== null ? (
                    <li>
                      <span className="k">Seats</span>
                      <span className="v">{row.seats}</span>
                    </li>
                  ) : null}
                </ul>
                {row.status === null ? (
                  <p className="sub" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                    Payment confirmations arrive from Stripe a moment after checkout.
                    Refresh in a few seconds.
                  </p>
                ) : null}
              </section>
            ))
          )}
        </div>
      </main>
    </>
  );
}
