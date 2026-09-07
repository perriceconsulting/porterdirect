/**
 * Placeholder root. The licensee-facing marketing/pricing surface renders from the
 * canonical catalog (packages/billing/src/plans.ts) when it is built — never from
 * prices hardcoded here.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>PorterDirect</h1>
      <p>Platform surface scaffold. Stripe webhook: <code>/api/stripe/webhook</code></p>
    </main>
  );
}
