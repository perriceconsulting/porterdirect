/**
 * Request a password-reset link.
 *
 * The confirmation is identical whether or not an account exists, so this page cannot be
 * used to discover who has one. That matters more here than on sign-in: probing this
 * form needs no password at all.
 */
import { SiteHeader } from "../_components/site-header";
import { requestResetAction } from "../actions";

export const metadata = { title: "Reset your password — PorterDirect" };

export default async function Forgot({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href="/signin">
          Sign in
        </a>
      </SiteHeader>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Reset your password</h1>

          {params.sent ? (
            <>
              <p className="notice" role="status">
                If that address has an account, a reset link is on its way. It works once
                and expires in an hour.
              </p>
              <p className="sub">
                Nothing arrived? Check spam, then <a href="/forgot">try again</a>.
              </p>
              <p className="alt">
                <a href="/signin">Back to sign in</a>
              </p>
            </>
          ) : (
            <>
              <p className="sub">
                Enter your work email and we will send a link to set a new password.
              </p>

              {params.error === "missing-fields" ? (
                <p className="error" role="alert">
                  Enter your email address.
                </p>
              ) : null}

              <form action={requestResetAction}>
                <div className="field">
                  <label htmlFor="email">Work email</label>
                  <input id="email" name="email" type="email" autoComplete="email" required />
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Send reset link
                  </button>
                </div>
              </form>

              <p className="alt">
                Remembered it? <a href="/signin">Sign in</a>
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
