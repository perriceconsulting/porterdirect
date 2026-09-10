/**
 * Which operator's portal?
 *
 * A person can hold an account with more than one courier — a law firm using two, a clinic
 * with a backup — because identity is global and the customer relationship is scoped per
 * tenant. That is the same reason `/dashboard` picks a tenant before showing a console.
 *
 * With exactly one account it redirects straight through, because a picker with one option
 * is a click that teaches nothing.
 *
 * NO OPERATOR BRANDING HERE, and that is the one place it would be wrong: this page spans
 * several operators, so wearing one of their names would misattribute the others. It says
 * as little as possible instead.
 */
import { redirect } from "next/navigation";
import { createDbClient } from "@porterdirect/db";
import { listCustomerAccountsForUser } from "../../lib/customers";
import { requirePortalUserId } from "../../lib/portal";
import { signOutAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your deliveries", robots: { index: false, follow: false } };

export default async function PortalPicker() {
  const userId = await requirePortalUserId();
  const db = createDbClient(process.env.DATABASE_URL);
  const accounts = await listCustomerAccountsForUser(db, userId);

  if (accounts.length === 1) redirect(`/portal/${accounts[0]!.tenantId}`);

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>Your deliveries</h1>

        {accounts.length === 0 ? (
          <>
            {/*
              Says nothing about who might have invited them, or whether an invitation
              exists. Someone who has landed here without an account learns only that they
              need one.
            */}
            <p className="sub">
              This account is not set up with any courier yet. If you were sent an
              invitation, open the link in that email to finish setting it up.
            </p>
            <p className="alt">
              <form action={signOutAction}>
                <button className="btn btn-quiet" type="submit">
                  Sign out
                </button>
              </form>
            </p>
          </>
        ) : (
          <>
            <p className="sub">You book deliveries with more than one company. Choose one.</p>
            <ul className="tenant-list">
              {accounts.map((a) => (
                <li key={a.tenantId}>
                  <a className="btn btn-primary" href={`/portal/${a.tenantId}`}>
                    {a.tenantName}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
