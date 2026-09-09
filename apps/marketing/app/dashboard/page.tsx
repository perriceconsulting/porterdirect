/**
 * Tenant picker.
 *
 * With exactly one operator account this redirects straight through — a chooser with one
 * option is a click that teaches nothing. It exists because a user genuinely can belong
 * to several tenants: an agency running two brands, a contractor driving for two firms.
 */
import { redirect } from "next/navigation";
import { createDbClient } from "@porterdirect/db";
import { SiteHeader } from "../_components/site-header";
import { signOutAction } from "../actions";
import type { TenantRole } from "@porterdirect/auth";
import { homePathForRole, listConsoleTenants, requireUserId } from "../../lib/console";

export const metadata = { title: "Your operator accounts — PorterDirect" };
export const dynamic = "force-dynamic";

export default async function DashboardIndex() {
  const userId = await requireUserId();
  const db = createDbClient(process.env.DATABASE_URL);
  const tenants = await listConsoleTenants(db, userId);

  // A member who can only drive has nothing to do in the console, so sending them there
  // is sending them to an empty room. Routed by role, in one place (`homePathForRole`).
  if (tenants.length === 1) {
    const only = tenants[0]!;
    redirect(homePathForRole(only.role as TenantRole, only.id));
  }

  return (
    <>
      <SiteHeader>
        <form action={signOutAction}>
          <button className="btn btn-quiet" type="submit">
            Sign out
          </button>
        </form>
      </SiteHeader>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Your operator accounts</h1>

          {tenants.length === 0 ? (
            <>
              <p className="sub">
                You are signed in, but not a member of any operator account yet.
              </p>
              <p className="alt">
                <a href="/signup">Start a subscription</a>
              </p>
            </>
          ) : (
            <>
              <p className="sub">Choose an account to open.</p>
              <ul className="status-list">
                {tenants.map((t) => (
                  <li key={t.id}>
                    <a href={homePathForRole(t.role as TenantRole, t.id)} className="tenant-link">
                      <span className="tenant-name">{t.name}</span>
                      <span className="k">{t.host ?? "no domain yet"}</span>
                    </a>
                    <span className="pill">{t.role}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>
    </>
  );
}
