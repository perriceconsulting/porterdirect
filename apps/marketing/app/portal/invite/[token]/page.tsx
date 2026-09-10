/**
 * A customer's invitation to open an account with an operator.
 *
 * Says as little as possible before anyone has proved they hold the invited mailbox: one
 * message for "no such token", "expired" and "already used", and the invited address is
 * never displayed. The link is a bearer credential, and confirming which address it
 * belongs to would tell whoever holds a forwarded one something they did not have.
 */
import { headers } from "next/headers";
import { createDbClient } from "@porterdirect/db";
import { PasswordField } from "../../../_components/password-field";
import { getAuth } from "../../../../lib/auth";
import { findCustomerInvitationByToken } from "../../../../lib/customers";
import {
  acceptCustomerInviteAction,
  acceptCustomerInviteWithNewAccountAction,
  signOutAndReturnToCustomerInviteAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invitation", robots: { index: false, follow: false } };

export default async function CustomerInvite({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const session = await getAuth().api.getSession({ headers: await headers() });
  const db = createDbClient(process.env.DATABASE_URL);
  const invitation = await findCustomerInvitationByToken(db, token);

  const usable =
    Boolean(invitation) &&
    !invitation!.acceptedAt &&
    invitation!.expiresAt.getTime() >= Date.now();
  const matches =
    session?.user && invitation
      ? session.user.email.trim().toLowerCase() === invitation.email
      : false;

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>Invitation</h1>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {!usable ? (
          <p className="sub">
            This invitation link is not valid. It may have expired, already been used, or
            been withdrawn. Ask the company that sent it for a new one.
          </p>
        ) : !session?.user ? (
          <>
            {/*
              Creating an account is the PRIMARY action, not signing in. Almost everyone
              opening one of these has never used the product — the team invite shipped
              the other way round and was a dead end for every driver.
            */}
            <p className="sub">
              You have been invited to book deliveries online. Create your account with the
              address the invitation was sent to.
            </p>

            <form action={acceptCustomerInviteWithNewAccountAction} className="auth-form">
              <input type="hidden" name="token" value={token} />
              <div className="row-2">
                <div className="field">
                  <label htmlFor="firstName">First name</label>
                  <input id="firstName" name="firstName" autoComplete="given-name" required />
                </div>
                <div className="field">
                  <label htmlFor="lastName">Last name</label>
                  <input id="lastName" name="lastName" autoComplete="family-name" required />
                </div>
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                {/* Typed, never pre-filled: the page names nobody. */}
                <input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <PasswordField
                name="password"
                label="Password"
                autoComplete="new-password"
                hint="At least 12 characters. A short phrase you can remember works well."
              />
              <div className="form-actions">
                <button className="btn btn-primary" type="submit">
                  Create account and continue
                </button>
              </div>
            </form>

            <p className="alt">
              Already have an account?{" "}
              <a href={`/signin?next=${encodeURIComponent(`/portal/invite/${token}`)}`}>
                Sign in to accept
              </a>
            </p>
          </>
        ) : !matches ? (
          <>
            <p className="error" role="alert">
              This invitation was sent to a different address than the account you are
              signed in as.
            </p>
            <p className="sub">
              Sign out and continue as the invited account. If it has no account yet, you
              will be able to create one.
            </p>
            {/* A way to act on what the sentence asks, that keeps the invitation. */}
            <form action={signOutAndReturnToCustomerInviteAction}>
              <input type="hidden" name="token" value={token} />
              <div className="form-actions">
                <button className="btn btn-primary" type="submit">
                  Sign out and continue
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <p className="sub">You have been invited to book deliveries online.</p>
            <form action={acceptCustomerInviteAction}>
              <input type="hidden" name="token" value={token} />
              <div className="form-actions">
                <button className="btn btn-primary" type="submit">
                  Accept invitation
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
