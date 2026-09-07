# Stripe dev setup (PorterDirect)

This instantiates the global `~/.claude/CLAUDE.md` **"Third-party sandboxes and client
accounts"** checklist for this repo. That section is the standard; this file is the
concrete, project-specific procedure. **Test mode only in dev.** Never print or commit a
secret value.

## One-time: create the Prices in the Stripe account

Every amount derives from the canonical catalog — [packages/billing/src/plans.ts](../packages/billing/src/plans.ts).
Do not invent prices here; read them from the catalog. Each tier is a **graduated
per-seat recurring Price** (flat first tier, then $25/seat), billed on the subscription
item's `quantity` = total active seats.

| Env var | Kind | From catalog |
|---|---|---|
| `STRIPE_PRICE_DIRECT_COURIER` | recurring, graduated | $199 up to 5 seats, then $25/seat |
| `STRIPE_PRICE_FLEET_FREIGHT` | recurring, graduated | $499 up to 15 seats, then $25/seat |
| `STRIPE_PRICE_WHITE_LABEL_AGENCY` | recurring, graduated | $999 up to 50 seats, then $25/seat |
| `STRIPE_PRICE_SETUP_FEE_AGENCY` | one-time | $1,500 agency onboarding |
| `STRIPE_PRICE_APP_STORE_DEPLOY` | one-time | $499 add-on |
| `STRIPE_PRICE_SMS_METERED` | metered usage | pass-through + 20% |

Graduated tier config for a plan Price (example, Direct Courier): first tier `up_to: 5`,
`flat_amount: 19900`; second tier `up_to: inf`, `unit_amount: 2500`; recurring monthly, USD.

## The checklist (per the global standard)

1. **Keys as a set, one account.** Copy [.env.example](../.env.example) → `.env.local`
   (gitignored). Paste the **secret** and **publishable** keys — both from the *same* test
   account.
2. **Re-derive the webhook signing secret for THIS account.** From `stripe listen` output
   (below) or the Dashboard endpoint. Never carry a `whsec_` over from another account — a
   carried-over secret fails signature verification as unread 400s, not a visible break.
3. **Assert the account.** Run the doctor; confirm the `acct_…` it prints is the intended
   PorterDirect account. A key that "works" only proves *some* account accepted it.

   ```bash
   npm run stripe:doctor
   ```

4. **Update provenance comments** beside the keys you just set. A comment describing the
   old key is a lie about the new one — fix it in the same edit as the swap.
5. **Point the CLI at this account** (the CLI stores its own auth, independent of
   `.env.local`). Pin the account per invocation:

   ```bash
   stripe listen --api-key "$STRIPE_SECRET_KEY" \
     --forward-to localhost:3000/api/stripe/webhook
   ```

   The `whsec_` it prints on start is this account's signing secret for step 2.
6. **Exercise one real call through the app** — create a test subscription via the app's
   checkout, not the Stripe Dashboard. Confirm the webhook lands and reconciles a
   `subscriptions` row. (App webhook route is not built yet — this step activates once the
   Next.js layer exists.)

## Guards that run without asking you to remember

- `npm run guard:stripe` — mechanical refusal of any non-`sk_test_` secret key.
- `npm run stripe:doctor` — the full set check + account assertion above.
- `npm run verify:catalog` — catalog invariants (prices, tiers, uniqueness).

## Landmines (from the global standard, made concrete)

- **`.env*.local` ≠ `.env.local.bak`.** A `.bak` sidecar is untracked but *not* ignored —
  it rides in on the next `git add -A`. Don't create one; if a swap needs it, delete it
  before the task ends. (`.gitignore` blocks `*.env.bak`, but do not rely on that for a
  differently-named sidecar.)
- **Never print a secret.** Read back names, lengths, short prefixes — never values. The
  doctor prints the `acct_…` id (an identifier, safe) but no key material.
