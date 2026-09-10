/**
 * Accept an invitation.
 *
 * Deliberately says very little before the person is signed in. Confirming that a token
 * is valid, or naming the tenant it belongs to, tells whoever holds a forwarded link
 * that they have found something real — and the link is a bearer credential.
 */
import { headers } from "next/headers";
import { createDbClient } from "@porterdirect/db";
import { SiteHeader } from "../../_components/site-header";
import { getAuth } from "../../../lib/auth";
import { findInvitationByToken } from "../../../lib/invitations";
import { PasswordField } from "../../_components/password-field";
import { acceptInvitationAction, acceptInviteWithNewAccountAction } from "./actions";

export const metadata = { title: "Invitation — PorterDirect" };
export const dynamic = "force-dynamic";

export default async function AcceptInvite({
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
  const invitation = await findInvitationByToken(db, token);

  const expired = invitation ? invitation.expiresAt.getTime() < Date.now() : false;
  const used = Boolean(invitation?.acceptedAt);
  const usable = Boolean(invitation) && !expired && !used;
  const matches =
    session?.user && invitation
      ? session.user.email.trim().toLowerCase() === invitation.email
      : false;

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href="/">
          Home
        </a>
      </SiteHeader>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Invitation</h1>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}

          {!usable ? (
            <>
              {/*
                One message for "no such token", "expired" and "already used". Telling
                them apart would let someone probe which tokens exist.
              */}
              <p className="sub">
                This invitation link is not valid. It may have expired, already been used,
                or been withdrawn. Ask whoever invited you for a new one.
              </p>
              <p className="alt">
                <a href="/signin">Sign in</a>
              </p>
            </>
          ) : !session?.user ? (
            <>
              {/*
                CREATING an account is the primary action here, not signing in, and that
                ordering is the fix. Almost everyone who follows one of these links is a
                driver who has never used the product — the page used to offer only "sign
                in to accept", and the only other route off the sign-in page is "Start a
                subscription", which is the OPERATOR path and would have given them their
                own tenant and a Stripe checkout. The whole team-invite feature was
                therefore unusable by every driver.
              */}
              <p className="sub">
                Create your account to accept this invitation. Use the address it was sent
                to — it only works for that one.
              </p>

              <form action={acceptInviteWithNewAccountAction} className="auth-form">
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
                  {/*
                    Typed rather than pre-filled from the token. The invited address is NOT
                    displayed before anyone has proved they hold the mailbox — this page's
                    whole posture is to say as little as possible to whoever holds a
                    forwarded link, and the email that carried the link already tells the
                    legitimate person which address to use.
                  */}
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
                    Create account and accept
                  </button>
                </div>
              </form>

              <p className="alt">
                Already have an account?{" "}
                <a href={`/signin?next=${encodeURIComponent(`/invite/${token}`)}`}>
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
                Sign out and sign back in as the invited account to accept it.
              </p>
              <p className="alt">
                <a href="/dashboard">Go to your accounts</a>
              </p>
            </>
          ) : (
            <>
              <p className="sub">
                You have been invited to join as a <strong>{invitation!.role}</strong>.
              </p>
              <form action={acceptInvitationAction}>
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
    </>
  );
}
