/**
 * porterdirect.com — the licensee-facing surface.
 *
 * Every price on this page is read from the canonical catalogue at request time. It is
 * never typed here: the catalogue is the single source, the Stripe Prices already mirror
 * it, and a hardcoded number on a pricing page would be a third copy that silently
 * drifts from what the customer is actually charged.
 *
 * Deliberately a server component with no interactivity — the client-component ratchet
 * stays at zero. A marketing page that ships JavaScript to render static prices is
 * shipping work the reader never asked for.
 */
import { ADD_ONS, PLANS, formatUsdCents, type Plan } from "@porterdirect/billing";

/** The tier we lead with. Featuring one is a design decision, so it is named here. */
const FEATURED_PLAN_ID = "fleet_freight";

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M1.5 6.5 L4.5 9.5 L10.5 2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SeatLine({ plan }: { plan: Plan }) {
  return (
    <p className="seats">
      <strong>{plan.includedSeats} seats</strong> included, then{" "}
      <strong>{formatUsdCents(plan.extraSeatPriceCents)}</strong> per additional seat, per
      month.
    </p>
  );
}

function TierCard({ plan }: { plan: Plan }) {
  const featured = plan.id === FEATURED_PLAN_ID;
  return (
    <article className={featured ? "tier featured" : "tier"}>
      <h3 className="tier-name">
        {plan.name}
        {featured ? <span className="tier-badge">Most chosen</span> : null}
      </h3>

      <p className="price">
        <span className="amount">{formatUsdCents(plan.monthlyBasePriceCents)}</span>
        <span className="per">/month</span>
      </p>

      {plan.oneTimeSetupFeeCents > 0 ? (
        <p className="setup-fee">
          plus a one-time {formatUsdCents(plan.oneTimeSetupFeeCents)} onboarding fee
        </p>
      ) : null}

      <SeatLine plan={plan} />

      <ul className="features">
        {plan.features.map((feature) => (
          <li key={feature}>
            <Check />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <a className={featured ? "btn btn-primary" : "btn btn-quiet"} href="/signup">
        Start with {plan.name}
      </a>
    </article>
  );
}

export default function Home() {
  return (
    <>
      <header className="site-header">
        <div className="shell">
          <a className="wordmark" href="/">
            Porter<span>Direct</span>
          </a>
          <nav className="header-nav" aria-label="Main">
            <a className="btn btn-quiet" href="#pricing">
              Pricing
            </a>
            <a className="btn btn-primary" href="/signin">
              Sign in
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="shell">
            <p className="eyebrow">White-label logistics platform</p>
            <h1>Rent the software, not the fleet.</h1>
            <p className="lede">
              Dispatch, live tracking and proof of delivery — running under your brand, on
              your domain. You keep the customer relationship. We keep the platform
              running.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary" href="#pricing">
                See pricing
              </a>
              <a className="btn btn-quiet" href="/signup">
                Start a trial
              </a>
            </div>
          </div>
        </section>

        <section className="props" aria-label="Why operators choose PorterDirect">
          <div className="prop">
            <h3>Your brand, your domain</h3>
            <p>
              Map your own CNAME and every tracking link, notification and driver app your
              customers touch carries your name — not ours.
            </p>
          </div>
          <div className="prop">
            <h3>Zero per-delivery commission</h3>
            <p>
              A flat monthly subscription. Run ten jobs or ten thousand; the price does not
              move with your volume.
            </p>
          </div>
          <div className="prop">
            <h3>Chain of custody, kept</h3>
            <p>
              Signature and photo proof stored at full resolution, with a who-held-it-when
              trail for legal, medical and high-value work.
            </p>
          </div>
        </section>

        <section className="section" id="pricing">
          <div className="shell">
            <div className="section-head">
              <h2>Pricing</h2>
              <p>
                Every plan bills as a single graduated per-seat subscription. A seat is one
                active driver or power unit.
              </p>
            </div>

            <div className="tiers">
              {PLANS.map((plan) => (
                <TierCard key={plan.id} plan={plan} />
              ))}
            </div>

            <p className="note">
              Prices are exclusive of sales tax and VAT, which are calculated at invoice
              time based on your billing address. Seats are counted as active drivers or
              power units, and the subscription quantity follows them.
            </p>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }} id="add-ons">
          <div className="shell">
            <div className="section-head">
              <h2>Add-ons</h2>
              <p>Bolt on what you need, when you need it.</p>
            </div>
            <div className="addons">
              {ADD_ONS.map((addOn) => (
                <div className="addon" key={addOn.id}>
                  <span className="addon-name">{addOn.name}</span>
                  <span className="addon-price">
                    {addOn.priceCents === null
                      ? "Usage-based"
                      : `${formatUsdCents(addOn.priceCents)} one-time`}
                  </span>
                  {addOn.kind === "metered" ? (
                    <span className="addon-note">
                      Billed on what you send, passed through at cost plus 20%.
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="shell">
          <span>PorterDirect — white-label logistics infrastructure</span>
          <span>Pre-launch</span>
        </div>
      </footer>
    </>
  );
}
