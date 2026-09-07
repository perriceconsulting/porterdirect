# PorterDirect — project standards

Instantiates the global `~/.claude/CLAUDE.md` (DOSI, mobile-first, PHAST, sandbox
hygiene, SEO). This file carries the concrete tables; it does not restate the standard.

## Stack

Multi-tenant, white-label logistics SaaS: **npm-workspaces monorepo** — TypeScript
everywhere, Next.js (App Router) web surfaces, Neon Postgres via Drizzle ORM, Stripe
Billing (licensee subscriptions) + Stripe Connect (driver payouts, later), React Native
driver app (later). Sold to operator-tenants (courier firms, freight dispatchers,
agencies) who run the physical work under their own brand + domain.

## Single Source — concern → canonical origin

| Concern | Canonical origin | Notes |
|---|---|---|
| Plan/pricing catalog | [packages/billing/src/plans.ts](packages/billing/src/plans.ts) | Amounts authoritative; Stripe Prices mirror it |
| Billing domain types | [packages/billing/src/types.ts](packages/billing/src/types.ts) | `SubscriptionStatus`, snapshots, `TenantSubscription` |
| Subscription/seat/entitlement logic | [packages/billing/src/subscription-state.ts](packages/billing/src/subscription-state.ts) | Pure; one entitlement rule (`isEntitled`) |
| Webhook handling (verify + idempotent dispatch) | [packages/billing/src/webhook.ts](packages/billing/src/webhook.ts) | Stripe status is SSOT; DB mirrors via webhooks |
| Persisted shapes / schema | [packages/db/src/schema.ts](packages/db/src/schema.ts) | Drizzle; types derived via `$inferSelect` |
| Stripe client + test-mode guard | [packages/billing/src/stripe-env.ts](packages/billing/src/stripe-env.ts) | Mirrors [scripts/guard-stripe-env.sh](scripts/guard-stripe-env.sh) |
| Stripe dev-setup procedure | [docs/stripe-dev-setup.md](docs/stripe-dev-setup.md) + [scripts/stripe-doctor.sh](scripts/stripe-doctor.sh) | Instantiates global "Third-party sandboxes" checklist |
| Env contract | [.env.example](.env.example) | Copy to `.env.local` (gitignored), test-mode only |
| DB client / connection | [packages/db/src/client.ts](packages/db/src/client.ts) | neon-http driver; no transactions, so the webhook path uses single atomic statements |
| DB migrations | [packages/db/drizzle/](packages/db/drizzle/) | GENERATED from `schema.ts` via `npm run db:generate` — never hand-write DDL |
| Env file reading | [scripts/lib/load-env.sh](scripts/lib/load-env.sh) | The only place a secrets file is read; parses as data, never sourced |

Local copies that must **reconcile back** (DOSI-S caveat): the `subscriptions` DB row
mirrors the Stripe Subscription (reconciled by `webhook.ts`); `STRIPE_PRICE_*` env vars
mirror the catalog's `stripePriceEnv` ids (per-account, do not transfer between accounts).
`npm run verify:catalog` checks catalog invariants today; the Stripe-API reconciler
(assert env Price amounts match the catalog) lands once a test key is provided.

## Domain landmines — the things that fail *silently*

- **Tenant data bleed.** Every tenant-owned row carries `tenant_id`; a query that forgets
  it leaks one licensee's data to another. Passes unit tests, only shows under concurrent
  multi-tenant load, and is existential for a trust-sold brand. → tenant-isolation PHAST.
- **Wrong Stripe account returns 200.** Test/live keys differ by four chars; a mismatched
  key "works" against the wrong account. Guard is mechanical ([scripts/guard-stripe-env.sh](scripts/guard-stripe-env.sh)
  + `assertTestModeKey`). Webhook signing secret is **per account** — re-derive, never carry over.
- **Webhook double-apply.** Stripe re-delivers events; without idempotency a retry applies
  twice. `processed_webhook_events` + `handleStripeEvent` make it exactly-once.
- **Money as float.** All amounts are integer cents. Never introduce floating-point money.
- **Stripe relocates fields between API versions.** `current_period_end` moved off the
  Subscription onto each subscription ITEM; on 2026-08-26.dahlia the subscription-level
  field is simply absent. Reading the old place yields `undefined`, and
  `new Date(undefined * 1000)` is an Invalid Date that survives until the persistence
  layer and surfaces as "Invalid time value" — far from the cause. Extractors read the
  item first and fall back to the subscription, and `toTenantSubscription` rejects a
  non-finite timestamp by name. Hand-written fixtures will NOT catch this class of bug:
  it was found by a real subscription, not by 53 passing tests.
- **Stripe `tax_behavior` is immutable, and Prices cannot be deleted.** Once a Price is
  created `inclusive` or `exclusive`, that choice is permanent; changing it means
  creating new Prices and re-pointing every `STRIPE_PRICE_*` env var. Catalog amounts
  are **tax-exclusive** list prices and Stripe Tax adds tax at invoice time — we never
  compute tax ourselves. `computeMonthlyTotalCents` is a PRE-TAX subtotal, so it will
  legitimately differ from a Stripe invoice total; a surface showing them side by side
  has a display bug, not a math bug.
- **Check-then-act idempotency.** Any "have we handled this?" followed by "mark handled"
  is a race: two concurrent deliveries both pass. Claim atomically (INSERT against a
  unique key) and release on a failed apply. Verified live — a check-then-act store
  double-applied under two concurrent listeners. Applies to every at-least-once feed we
  add, not just Stripe webhooks.
- **`KEY= value` in a `.env` file is executable.** A space after `=` makes a sourcing
  shell assign empty and run the value as a command, printing secrets into logs and
  transcripts. Never `source`/`.` a secrets file — use `scripts/lib/load-env.sh`, which
  parses env files as data. It already cost one key roll.
- **Entitlement drift.** Entitlement is derived in one place (`isEntitled`); do not re-derive
  "is this tenant active?" ad hoc anywhere else.
- **Off-shift / post-delivery tracking** (driver app, later): location visibility is wired to
  shift/order status; continuing to track after off-shift is a legal liability, not a bug.
- **Optimistic/offline updates that never reconcile** (driver app, later): every optimistic or
  offline-queued action must reconcile to the server and surface sync failures to the driver.

## PHAST pillars

| Pillar | Status |
|---|---|
| **Tenant isolation** | **Applies — mandatory.** Multi-tenant/white-label; build the stress spec alongside the first tenant-scoped query. |
| **Data-integrity-under-load** | **Applies.** Webhook idempotency, seat/entitlement invariants — most as deterministic unit tests (already begun), browser only where a concern is browser-only. |
| **Auth isolation** | Applies once tenant auth exists (roles: ops/dispatcher/driver). Deferred until auth lands. |
| **Realtime DOM reactivity** | Applies to the live tracking map (later). |
| **Render stability** | Applies to dashboards (later). |

Money/seat/entitlement invariants are unit tests, not browser tests (they are data
invariants). Browser stress is reserved for tenant isolation, session/cache bleed, and
live-map reactivity.

## DOSI ledger

- **2026-09-07 — Repo bootstrap + billing slice (licensee subscriptions).**
  - Added: npm-workspaces monorepo; `@porterdirect/db` (Drizzle schema: `tenants`,
    `subscriptions`, `processed_webhook_events`, all tenant-scoped where owned);
    `@porterdirect/billing` (canonical plan catalog, pure subscription/seat/entitlement
    logic, Stripe test-mode guard, verify+idempotent webhook dispatch). 27 unit tests
    green; `tsc -b` clean.
  - **S:** plan catalog is the single pricing source; Stripe/DB are declared mirrors that
    reconcile back. **O:** npm workspaces over pnpm+turbo — no tooling we can't yet justify.
    **I:** narrow boundary type (`StripeSubscriptionSnapshot`) so pure logic never touches
    the full Stripe type; names mirror the billing domain.
  - Left alone (with reason): Stripe-API price reconciler is scaffolded in intent but inert
    without a test key (correct — can't assert against an account we don't have). Seat model
    assumes a graduated per-seat Stripe Price (documented in `webhook.ts`); revisit when the
    Stripe Prices are actually created. DB-backed `WebhookEventStore`/`SubscriptionSink`
    implementations are ports only — wired at the Next.js app layer (not built yet).
  - Ratchets: client components = 0 (no web app yet); lint = not yet configured; unit tests
    = 27 (never lower to pass a build).

- **2026-09-07 — Stripe dev-setup instantiation.**
  - Added: [docs/stripe-dev-setup.md](docs/stripe-dev-setup.md) (project-specific version of
    the global "Third-party sandboxes" checklist) and [scripts/stripe-doctor.sh](scripts/stripe-doctor.sh)
    (`npm run stripe:doctor` — verifies the credential set is test-mode + one account, then
    asserts the account via whoami; prints the `acct_…` id but never key material).
  - **S/consistency fix:** removed the stray `STRIPE_PRICE_EXTRA_SEAT` price. Two seat models
    (base+overage vs graduated) were in conflict; standardized on the **graduated per-seat
    Price** that the tested webhook extraction and `computeMonthlyTotalCents` already assume,
    so catalog, Stripe Price shape, and our math are one model. Documented in `plans.ts`.
  - Left alone (with reason): steps 5–6 of the checklist (CLI pin, one real call) activate
    only when a test key + the app webhook route exist — the doctor runs and reports honestly
    without them (whoami skipped when no key).

- **2026-09-07 — Webhook HTTP surface, atomic idempotency, env-loading hardening.**
  - Added: `apps/marketing` (Next.js App Router; porterdirect.com is where licensees
    subscribe, so the Stripe Billing webhook lives there) with
    `app/api/stripe/webhook/route.ts` — raw-body read, signature verification before
    any trust, and retry-correct status codes (400 forged/unsigned = never retried;
    500 failed apply = retried; 200 processed/duplicate/ignored). `price-map.ts`
    resolves a Stripe Price id back to a catalog plan, deriving env var NAMES from the
    catalog so a new plan cannot silently skip its Price.
  - **Fixed a real defect found in live traffic:** `handleStripeEvent` used
    `hasProcessed` + `markProcessed`, a check-then-act pair. Under two concurrent
    `stripe listen` forwarders, six events were each handled twice — both passing the
    guard. Sequential redelivery was caught; concurrent was not, and Stripe retrying
    over a slow attempt (or two app instances) makes concurrency normal. The
    `WebhookEventStore` port is now a single atomic `claimEvent` (an INSERT relying on
    the `processed_webhook_events` primary key) plus `releaseEvent` on a failed apply,
    so a failure stays retryable instead of trading a double-apply for a lost update.
    Re-validated against two concurrent listeners: 13 duplicate deliveries, 0 double
    applies. This is the **webhook double-apply** landmine; it was live.
  - **S:** closed an orphan — `STRIPE_PRICE_SETUP_FEE_AGENCY` existed in `.env.example`
    but no catalog entry declared it, so nothing could validate it. `Plan` now carries
    `setupFeePriceEnv`, and a test reconciles catalog-declared vars against the real
    `.env.example` (not a fixture, which would drift the same way).
  - **Security:** a `KEY= value` line (space after `=`) in `.env.local` made the shell
    execute the value, printing a restricted key into the transcript — key rolled. Root
    cause was this repo's own template. `scripts/lib/load-env.sh` is now the one place
    env files are read; it parses them as data (nothing can execute), strips unquoted
    trailing comments (`KEY= # note` previously parsed as the literal `"# note"` — an
    empty setting reporting itself as SET), and both scripts plus the guard use it.
    `npm run guard:stripe` also loads `.env.local` — it previously always reported
    "not set" standalone, a green that checked nothing.
  - **Ops:** app + CLI were on DIFFERENT Stripe accounts (`acct_1UCxu…` vs
    `acct_1U4Gfp…`); the first derived `whsec_` belonged to the wrong one and would
    have failed verification as unread 400s. `scripts/stripe-listen.sh` pins
    `--api-key` per invocation so the CLI cannot drift. App runs on a **restricted**
    `rk_test_` key (least privilege); both guards already accepted `rk_`.
  - `drizzle-orm` 0.36 → 0.45.2 for a SQL-injection advisory — directly relevant to the
    tenant-isolation landmine.
  - Left alone (with reason): webhook store/sink are **in-memory** and clearly marked
    non-shippable — there is still no `DATABASE_URL`, and the standing rule is not to
    build an adapter we cannot assert against real infrastructure. The 6 Stripe Prices
    are still uncreated (irreversible write, awaiting explicit go). Next.js carries 2
    postcss advisories fixable only by a v16 major — deferred deliberately, not missed.
  - Ratchets: unit tests = **53** (was 27); client components = 0; lint = still not
    configured. Never lower to pass a build.

- **2026-09-07 — Neon wired; webhook persistence is real and atomic.**
  - Added: Neon project `porterdirect` (`withered-art-75776831`, pg17, us-east-2) under
    the Perrice IT org. `packages/db/src/client.ts` (neon-http driver), drizzle-kit
    migrations **generated from `schema.ts`** — the DB derives from the canonical
    schema rather than hand-written DDL that would drift from the types.
  - `DbWebhookEventStore.claimEvent` is `INSERT … ON CONFLICT DO NOTHING RETURNING`:
    one statement, with Postgres resolving the race in the primary key. Proven against
    the real database — ten concurrent claims, exactly one winner. This is the point at
    which the atomic-claim port stops being a promise and becomes an enforced property.
  - `DbSubscriptionSink` resolves the tenant from `stripe_customer_id` BEFORE writing
    and throws `UnknownTenantError` if there is none. An unscoped `subscriptions` row is
    the tenant-bleed landmine; a loud 500 that Stripe retries beats a quietly
    mis-attributed row.
  - The route now picks DB adapters when `DATABASE_URL` is present and falls back to
    in-memory with a loud warning otherwise, so the HTTP path stays exercisable offline
    while a deployed environment can never silently take the non-durable branch.
  - Ratchets: unit + integration tests = **59** (was 53); client components = 0; lint
    still not configured.
  - Left alone (with reason): the 6 Stripe Prices are STILL not created — the apply was
    blocked by the sandbox, and it is the one step that needs a human. `STRIPE_PRICE_SMS_METERED`
    is deliberately unset: the catalog carries no amount for it (pass-through metered),
    the product does not send SMS yet, and inventing a rate would be inventing pricing.
    Verified that leaving it unset breaks nothing.

- **2026-09-07 — Stripe Prices created; full path proven end to end.**
  - Created from the catalog via `npm run stripe:prices -- --apply`: 4 Products (all
    `tax_code=txcd_10103001`) and 5 Prices (all `tax_behavior=exclusive`), graduated
    tiers matching `plans.ts` exactly. Read back from Stripe and verified rather than
    trusting the create output. `STRIPE_PRICE_SMS_METERED` remains unset by design.
  - **Found and fixed a real bug that only live traffic could surface:** the first real
    subscription 500'd with "Invalid time value". Stripe had MOVED `current_period_end`
    from the Subscription onto the subscription item, so we read `undefined`. Every
    existing fixture hand-wrote the old shape, so 53 green tests said nothing. Extractor
    now prefers the item and falls back to the subscription; 5 regression tests cover
    both shapes, the neither-present case, and the non-finite guard.
  - **Checklist step 6 satisfied for real:** a live subscription on the Direct Courier
    Price → signature verified → resolved to `direct_courier` via the catalog price map
    → tenant-scoped row written to Neon with the correct `tenant_id` and `seat_count=7`.
  - **Reconciled our money math against Stripe:** `computeMonthlyTotalCents` and the
    Stripe invoice subtotal both give 24900 for 7 seats. The graduated Price and our
    arithmetic are one model, confirmed against the API rather than asserted.
  - Test data (3 customers, 3 tenants, subscriptions) deleted after verification.
  - Ratchets: tests = **64** (was 59); client components = 0; lint still not configured.

- **2026-09-07 — Enforcement: lint, conventions guard, CI.**
  - The standard says a rule a linter checks survives and a rule in prose erodes. This
    turns the day's prose rules into build failures.
  - **ESLint (flat config, type-aware).** `no-floating-promises` / `no-misused-promises`
    are the highest-value rules here: idempotency, persistence and Stripe calls are all
    async, and a dropped `await` on `claimEvent` or `upsert` fails silently and looks
    exactly like success. Also mechanical now: `parseFloat` is banned outright (money is
    integer cents), and `process.env` is banned inside `packages/**/src` so config comes
    in as an argument and library tests need no environment (DOSI-S). Type-aware rules
    are scoped to files that genuinely sit in a tsconfig project; package tests and
    standalone scripts get `disableTypeChecked` rather than contorting the build configs.
  - **`npm run verify:conventions`** covers what a linter cannot see because it lives in
    shell and dotfiles: no script may source a `.env` file; env files must be `KEY=value`
    with no space after `=` and no inline comment; `.env.local` and every sidecar
    spelling must be gitignored; no key material in tracked files. Each check traces to a
    defect this repo actually hit, and each was verified to FAIL on a planted violation —
    a guard nobody has seen fail is not known to work.
  - The key-material check separates real credentials from fixtures by ENTROPY (digits
    AND uppercase) rather than an allowlist that would rot. An earlier version embedded
    Python inside the shell script, broke on a quote, and still printed "ok"; it is now
    grep + awk with an explicit filter-failure branch, because a guard that errors must
    fail, never pass.
  - **CI** (`.github/workflows/ci.yml`) runs typecheck → lint → conventions → tests, each
    step with `if: '!cancelled()'` so one push surfaces every problem rather than only the
    first. Inert until a remote exists — added now because CI retrofitted later inherits
    whatever drifted meanwhile. DB integration tests skip without `DATABASE_URL`, so CI is
    green without a database and exercises them when the secret is set.
  - `npm run verify` runs the whole chain locally.
  - Ratchets: tests = **64**; lint errors = **0** across **26** linted files (previously
    "not configured" — this is the ratchet finally set); client components = 0.
