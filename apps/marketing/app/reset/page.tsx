/**
 * Set a new password using the token from the emailed link.
 *
 * The token arrives in the query string because that is how an emailed link works, but
 * it is carried forward through a hidden field on submit rather than re-read from the
 * address bar — so a failed attempt does not depend on the URL surviving a redirect.
 */
import { SiteHeader } from "../_components/site-header";
import { PasswordField } from "../_components/password-field";
import { resetPasswordAction } from "../actions";

export const metadata = { title: "Set a new password — PorterDirect" };

const MESSAGES: Record<string, string> = {
  "invalid-token":
    "That reset link has expired or has already been used. Request a new one to continue.",
  "password-mismatch": "Those passwords do not match.",
  "weak-password": "Choose a password of at least 12 characters.",
  "missing-fields": "Enter and confirm your new password.",
};

export default async function Reset({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; detail?: string }>;
}) {
  const params = await searchParams;
  const token = params.token ?? "";
  const message =
    params.error === "password-policy"
      ? (params.detail ?? "Choose a stronger password.")
      : params.error
        ? MESSAGES[params.error]
        : undefined;

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href="/signin">
          Sign in
        </a>
      </SiteHeader>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Set a new password</h1>

          {message ? (
            <p className="error" role="alert">
              {message}
            </p>
          ) : null}

          {token ? (
            <>
              <p className="sub">Choose something you have not used elsewhere.</p>
              <form action={resetPasswordAction}>
                <input type="hidden" name="token" value={token} />
                <PasswordField
                  name="password"
                  label="New password"
                  autoComplete="new-password"
                  minLength={12}
                  hint="At least 12 characters."
                />
                <PasswordField
                  name="confirm"
                  label="Confirm new password"
                  autoComplete="new-password"
                  minLength={12}
                />
                <div className="form-actions">
                  <button className="btn btn-primary" type="submit">
                    Set new password
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <p className="sub">
                This page needs a reset link. Request one and open it from your email.
              </p>
              <p className="alt">
                <a href="/forgot">Request a reset link</a>
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
