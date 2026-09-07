/**
 * Sign up: create the account, provision the tenant, hand off to Stripe Checkout.
 *
 * The plan list and every price shown are read from the canonical catalogue, so this
 * form can never offer a plan or an amount that Stripe would not honour.
 */
import { PLANS, formatUsdCents } from "@porterdirect/billing";
import { signUpAction } from "../actions";
import type { FormErrorCode } from "../actions";
import { SiteHeader } from "../_components/site-header";

export const metadata = { title: "Start a subscription — PorterDirect" };

const MESSAGES: Partial<Record<FormErrorCode, string>> = {
  "missing-fields": "Fill in every field to continue.",
  "email-taken": "An account already exists for that email. Sign in instead.",
  "weak-password": "Choose a password of at least 12 characters.",
  "invalid-host":
    "That domain cannot be used. Enter a domain you control, such as dispatch.yourcompany.com.",
  "host-taken": "That domain is already connected to another account.",
  "invalid-name": "Enter your company name.",
  "unknown-plan": "Choose a plan to continue.",
  "rate-limited": "Too many attempts. Wait a moment and try again.",
  unknown: "Something went wrong. Please try again.",
};

export default async function SignUp({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const message = MESSAGES[params.error as FormErrorCode];
  const selectedPlan = params.plan ?? PLANS[0]!.id;

  return (
    <>
      <SiteHeader>
        <a className="btn btn-quiet" href="/signin">
          Sign in
        </a>
      </SiteHeader>

      <main className="auth-wrap">
        <div className="auth-card">
          <h1>Start a subscription</h1>
          <p className="sub">
            Create your operator account and connect your domain. You will confirm payment
            on the next screen.
          </p>

          {message ? (
            <p className="error" role="alert">
              {message}
            </p>
          ) : null}

          <form action={signUpAction}>
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" autoComplete="name" required />
            </div>

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
                autoComplete="new-password"
                minLength={12}
                required
              />
              <span className="hint">At least 12 characters.</span>
            </div>

            <div className="field">
              <label htmlFor="company">Company name</label>
              <input
                id="company"
                name="company"
                required
                defaultValue={params.company ?? ""}
              />
              <span className="hint">Shown to your customers on tracking pages.</span>
            </div>

            <div className="field">
              <label htmlFor="host">Your dispatch domain</label>
              <input
                id="host"
                name="host"
                placeholder="dispatch.yourcompany.com"
                required
                defaultValue={params.host ?? ""}
              />
              <span className="hint">
                A domain you control, pointed at us with a CNAME. Your customers never see
                ours.
              </span>
            </div>

            {/* Plan gets its own row. Sharing one with the seat count meant the
                longest option ("White-Label Agency — $999/mo") clipped under the
                select's chevron — and a plan picker that hides the plan name is the
                one control on this form that must not be guessed at. */}
            <div className="field">
              <label htmlFor="plan">Plan</label>
              <select id="plan" name="plan" defaultValue={selectedPlan}>
                {PLANS.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} — {formatUsdCents(plan.monthlyBasePriceCents)}/mo
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="seats">Active drivers</label>
              <input
                id="seats"
                name="seats"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                defaultValue={params.seats ?? "5"}
                required
              />
              <span className="hint">
                Seats included in your plan are covered; extra seats bill at the per-seat
                rate. Change this any time.
              </span>
            </div>

            <div className="form-actions">
              <button className="btn btn-primary" type="submit">
                Continue to payment
              </button>
            </div>
          </form>

          <p className="alt">
            Already have an account? <a href="/signin">Sign in</a>
          </p>
        </div>
      </main>
    </>
  );
}
