/**
 * Sign in. A plain form posting to a server action — no client component, so it works
 * with JavaScript disabled and the ratchet stays at zero.
 */
import { signInAction } from "../actions";
import type { FormErrorCode } from "../actions";

export const metadata = { title: "Sign in — PorterDirect" };

/**
 * Error codes are mapped to copy HERE, so nothing internal reaches the URL bar.
 * Note that both "no such account" and "wrong password" resolve to one message: telling
 * them apart hands an attacker a free account-enumeration oracle.
 */
const MESSAGES: Partial<Record<FormErrorCode, string>> = {
  "missing-fields": "Enter your email address and password.",
  "bad-credentials": "That email and password do not match an account.",
  unknown: "Something went wrong. Please try again.",
};

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; email?: string }>;
}) {
  const params = await searchParams;
  const message = MESSAGES[params.error as FormErrorCode];

  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="wordmark" href="/">
            Porter<span>Direct</span>
          </a>
          <nav className="header-nav" aria-label="Main">
            <a className="btn btn-quiet" href="/#pricing">
              Pricing
            </a>
          </nav>
        </div>
      </header>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Sign in</h1>
          <p className="sub">Operator access to your dispatch platform.</p>

          {message ? (
            <p className="error" role="alert">
              {message}
            </p>
          ) : null}

          <form action={signInAction}>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                defaultValue={params.email ?? ""}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            <div className="form-actions">
              <button className="btn btn-primary" type="submit">
                Sign in
              </button>
            </div>
          </form>

          <p className="alt">
            No account yet? <a href="/signup">Start a subscription</a>
          </p>
        </div>
      </main>
    </>
  );
}
