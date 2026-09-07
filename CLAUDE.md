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
| Authorization policy | [packages/auth/src/permissions.ts](packages/auth/src/permissions.ts) | The role→permission matrix; pure, exhaustive, no inheritance chain |
| Order lifecycle | [packages/orders/src/order-state.ts](packages/orders/src/order-state.ts) | Explicit transition table; terminal is terminal, no skipping, location bound to the order |
| Password policy | [packages/auth/src/password-policy.ts](packages/auth/src/password-policy.ts) | NIST SP 800-63B: length + breach checking, deliberately NO composition rules |
| Host → tenant classification | [packages/auth/src/tenant-host.ts](packages/auth/src/tenant-host.ts) | One normalisation, so every surface agrees what "same host" means |

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
- **A cleanup pattern is a destructive query.** A sweep of `email LIKE '%.test'` was run
  to remove test fixtures and it matched `workers@demo.test` — a REAL account, whose
  deletion cascaded away its membership and orphaned a tenant with a live paid
  subscription. Recoverable only because tenants and subscriptions do not cascade from
  users. Scope every sweep by something the tests OWN (a per-run domain, a marker
  column), never by a pattern that could plausibly match real data. Count the rows and
  read them before deleting, not after.
- **A checkout with tax calculation off collects no tax at all.** Stripe rejects
  `automatic_tax` until the account has a head office address and registrations, so it
  cannot be hardcoded on — but defaulting it off forever means charging real customers
  nothing in sales tax or VAT, which is a compliance failure rather than a smaller
  feature. `STRIPE_AUTOMATIC_TAX` is opt-in AND the app hard-refuses to run a live key
  while it is off.
- **Native form controls ignore your CSS theme.** A `<select>` popup is painted by the
  browser, so on a dark page without `color-scheme` it renders OS-default light and is
  unreadable. Declare `color-scheme` on `:root` for both themes.
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
| **Tenant isolation** | **BUILT** — [phast/tenant-isolation.spec.ts](phast/tenant-isolation.spec.ts). Verified to catch a planted leak, not merely to pass. |
| **Data-integrity-under-load** | **Applies.** Webhook idempotency, seat/entitlement invariants — most as deterministic unit tests (already begun), browser only where a concern is browser-only. |
| **Auth isolation** | **BUILT** — auth landed, so this is no longer deferred. Same spec: session bleed, cross-tenant refusal, anonymous refusal, cache-control on identity. |
| **Realtime DOM reactivity** | **Deliberately not built.** No live map exists; a spec would assert against nothing and read as coverage (the I caveat). |
| **Render stability** | **Deliberately not built.** No dashboard exists yet. There is also no `phast:headed` script, because with no UI a headed run would imply a browser pillar we have not built. |

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

- **2026-09-07 — Identity, tenant membership, and the authorization matrix.**
  - Chose **Better Auth** for identity. Deliberately did NOT use its organization plugin:
    that would add an `organization` table sitting beside the canonical `tenants`, giving
    two answers to "what is a tenant". Better Auth owns identity only; membership is ours.
  - Schema: `user`, `session`, `account`, `verification` (Better Auth's shape) plus
    **`tenant_members`** — a real foreign key on both sides, unique on (tenant, user) so
    one person cannot hold two roles in one tenant and leave "what may they do" undefined.
    Identity is global and membership is scoped, because a contractor may drive for two
    firms and an agency operator may run two brands. `role` is a Postgres ENUM, not text:
    it is the column an authorization check reads, so a typo must fail on write.
  - **`packages/auth`** carries the policy as pure functions. The matrix is written out per
    role rather than derived by inheritance — "ops = dispatcher + extras" means widening a
    parent silently widens every child, which is how a driver quietly gains fleet
    visibility. Two properties are asserted directly: a **driver** holds only
    `orders:read:assigned` and `orders:update:assigned` (no fleet, no roster, no other
    drivers' orders — the location-privacy promise is enforceable only if this holds), and
    **billing/membership are owner-only**.
  - `authorize()` checks the TENANT before the ROLE. An owner is maximally privileged, so
    evaluating privilege first would mask a session belonging to a different tenant
    entirely. Cross-tenant refusal is tested for every role, not just the weak ones.
  - Host classification refuses to guess: an unknown host resolves to nothing and 404s.
    There is deliberately no default tenant, because a fallback would serve one licensee's
    data on another licensee's domain. Nested subdomains (`evil.app.porterdirect.com`) are
    tenant hosts, never platform surfaces — only a first-level reserved subdomain counts.
  - Ratchets: tests = **112** (was 64); lint errors = 0; client components = 0.
  - Left alone (with reason): the Better Auth runtime instance and its route handler are
    not wired yet. The policy and the schema it reads are the parts worth getting right
    first, and they are testable without a server.

- **2026-09-07 — Auth runtime wired; session and host both resolve to a tenant.**
  - `createAuth` takes config as ARGUMENTS. The lint rule banning `process.env` inside
    `packages/**/src` forced this shape and it is the right one: a library that reads the
    environment cannot be tested without one, and it hides which surface owns a secret.
    It also refuses a `BETTER_AUTH_SECRET` under 32 chars — a short secret still signs
    successfully, so that would otherwise be a silent weakness rather than a failure.
  - **The tenant is resolved from the HOST, never from the request.** A tenant id in a
    query string or body is attacker-controlled; trusting it turns every endpoint into a
    cross-tenant read. `getRequestContext()` classifies the host, looks the tenant up, and
    only then resolves this user's membership in THAT tenant.
  - `findMembership` scopes by tenant AND user in one predicate. Looking up by user and
    filtering the tenant in application code is the shape that leaks: a forgotten filter
    returns a membership for the wrong tenant, and every downstream check then refuses or
    permits honestly against the wrong scope — indistinguishable from working.
  - Verified against the live database, not asserted: a user belonging to tenant A gets
    `null` for tenant B; a dispatcher authorizes for `orders:assign` and is refused
    `billing:manage`; an unclaimed host resolves to nothing rather than a default tenant.
  - Exercised the real endpoints: sign-up returns an HttpOnly SameSite=Lax cookie, the
    session resolves, and the user, session and account rows land in OUR Postgres with the
    password hashed — confirming the Drizzle adapter binds to our schema rather than
    keeping identity in a vendor.
  - Ratchets: tests = **121** (was 112); lint errors = 0; client components = 0.
  - Left alone (with reason): no sign-in UI yet — the endpoints exist and are exercised by
    HTTP, and a form is presentation over a contract that already works. Tenant-isolation
    PHAST spec is the next item and is now genuinely buildable.

- **2026-09-07 — PHAST: tenant + auth isolation, and proof the spec can fail.**
  - `npm run phast` runs concurrent assertions against the running app; `phast:serial`
    pins one worker for debugging. Suite timeout is raised per-describe because several
    contexts signing in and fanning out blows Playwright's 30s default, and the resulting
    "Test ended" reads like a product failure while being a harness limit.
  - Added `GET /api/me` — a genuinely needed endpoint (every client needs "who am I, in
    which tenant, as what"), not test scaffolding. Its status codes carry meaning: 404 for
    a host no tenant claims, 401 for no session, **403 for signed-in-but-not-a-member**.
    That last distinction matters: "you are nobody here" is a different fact from "you are
    nobody", and collapsing them hides cross-tenant attempts.
  - Six assertions: concurrent per-actor isolation; a sustained interleaved burst; a valid
    session on another tenant's host refused with no tenant id in the body; an unclaimed
    host 404; anonymous 401; and `cache-control: private, no-store` on identity responses.
  - **The spec was verified to FAIL.** Planting the classic bug — memoising the resolved
    request context at module scope — produced exactly the expected signature
    (`acme saw <globex tenant> expected <acme tenant>`). Worth recording precisely which
    test caught it: the all-at-once test **passed**, because all three actors fired before
    the cache populated; only the **sustained burst** failed. A leak from a lazily-warmed
    cache is invisible on the first round, which is the whole reason the repeated-rounds
    test exists.
  - Ratchets: tests = 121 unit/integration + **6 PHAST**; lint errors = 0.

- **2026-09-07 — First real UI: the licensee-facing marketing and pricing surface.**
  - Every price renders from the canonical catalogue at request time and is never typed
    into the page. A hardcoded number here would be a THIRD copy — beside the catalogue
    and the Stripe Prices that already mirror it — and the one customers read.
  - `formatUsdCents` is the single money formatter: integer cents in, string out, never
    routed through a float, and it **throws** on a non-integer rather than rounding.
    A fractional amount reaching it means a float leaked in upstream, and rounding would
    hide that at the exact moment it becomes a wrong price.
  - Entirely **server components** — the client-component ratchet stays at 0. A marketing
    page that ships JavaScript to render static prices is shipping work nobody asked for.
  - **Mobile-first is structural, not a breakpoint trick.** Every base rule is the phone
    rule and the file scales up: **2 `@media (min-width)` queries, 0 `@media (max-width)`**.
    Buttons are `inline-flex` with `min-height: var(--tap)` (44px) — an `<a>` styled as a
    button takes height from its text and silently ignores vertical padding, so it looks
    big and taps small. Adjacent actions sit ≥ 8px apart.
  - Method note worth keeping: the first ratchet measurement was WRONG — grepping
    `max-width:` counted CSS properties (`max-width: 52ch`) as media queries and reported
    the file as desktop-first. Count `@media (max-width`, not `max-width:`. A ratchet
    measured loosely is worse than none, because it reports confidently.
  - Ratchets: tests = **133** (was 121) + 6 PHAST; client components = **0**; lint = 0;
    min-width:max-width media queries = **2:0**.

- **2026-09-07 — The funnel: signup → tenant → Stripe Checkout.**
  - Sign-in, sign-up and post-checkout pages, all **server components** behind plain
    `<form>` posts to server actions. Errors travel back as an enumerated `?error=` code
    mapped to copy on the page, so the flows work with JavaScript disabled and no raw
    error message ever reaches the URL bar, browser history or a referrer header.
    Sign-in returns ONE message for both "no such account" and "wrong password" — telling
    them apart is a free account-enumeration oracle.
  - **Provisioning order is load-bearing** and documented as such: tenant → owner
    membership → Stripe customer (id written back) → checkout. The subscription webhook
    resolves to a tenant *through* `stripe_customer_id`, so starting checkout before that
    id exists means the first `customer.subscription.created` arrives for a customer we
    have never heard of and retries until it gives up. neon-http has no transactions, so
    the membership step rolls the tenant back on failure rather than pretending atomicity.
  - `assignableTenantHost` is the check between self-service signup and someone
    registering `app.porterdirect.com` as their own tenant host. It defers to
    `classifyHost` rather than re-deriving the rule — two implementations of "is this
    ours" is how a reserved host eventually becomes assignable on one path.
  - Verified end to end against live Stripe and Postgres: sign-up 200, tenant created,
    owner membership written, customer id stored **before** checkout, session created at
    checkout.stripe.com, reserved host refused, duplicate host refused, all cleaned up.
  - `/welcome` reads the DATABASE, not the checkout redirect. Stripe returns the browser
    before the webhook necessarily lands, so a page reporting "active" from the URL would
    assert something it had not verified. It shows "Confirming" until the row exists.
  - Two UI defects the user caught that no test would have: the plan `<select>` popup
    rendered OS-default light on the dark page (no `color-scheme` declared), and the
    longest option clipped under the chevron in a `1fr 1fr` row. Fixed by declaring
    `color-scheme` for both themes and giving the plan its own full-width row — the
    arithmetic showed even `2fr` left it ~1rem short, and guessing at widths is how
    clipping returns.
  - Ratchets: tests = **151** (was 133) + 6 PHAST; client components = **0**; lint = 0.

- **2026-09-07 — Browser e2e, and the bug that proved it was needed.**
  - A wrong password rendered an unhandled runtime error page while **169 tests passed**.
    Cause: `err instanceof APIError` returns false inside a Next server action, because
    the bundler gives the same class two identities. Auth errors are now classified by
    SHAPE (`classifyAuthError`), which survives bundling, duplicate installs and version
    skew. `isRedirectError` is checked first in every catch — `redirect()` signals by
    throwing, and swallowing it hangs the request.
  - **Nothing below the browser exercised the submit path**, so nothing could see it. New
    `e2e` Playwright project (real Chromium) covering: wrong-password message, email
    retained, identical copy for unknown-account vs wrong-password, reserved-host refusal,
    plan select width, tier prices, no horizontal scroll at 375px, and every `.btn` being
    a true 44px target. Kept separate from `phast` because they answer different questions
    — phast asks whether isolation holds under concurrency, e2e asks whether it works at all.
  - **Three wrong detectors before a right one**, worth recording: `getByRole("alert")`
    also matched Next's route announcer; `nextjs-portal` is present on every healthy page;
    `[data-nextjs-dialog]` did not appear even on a deliberately thrown error. The
    version-proof signal is the **HTTP status** — a server component or action that throws
    returns 5xx regardless of what the overlay is called this release. Guessing at a
    framework's private DOM is how a test quietly stops testing.
  - DRY: the site header had been copy-pasted into four pages. Extracted; stickiness is
    now opt-in, because Next skips (and warns about) auto-scroll when the element it would
    focus is sticky — worth it on the long marketing page, pure noise on a short form.
  - Ratchets: tests = **169** + 6 PHAST + **11 e2e**; client components = 0; lint = 0.

- **2026-09-07 — Password reveal, reset flow, structured names, password policy.**
  - **Password policy follows NIST SP 800-63B**, and the shape of that is a decision worth
    defending: minimum 12 (well above the NIST floor of 8), generous 128 maximum, spaces
    and Unicode allowed, and **deliberately NO required character classes** — composition
    rules produce `Password1!` and push people toward reuse. What NIST does require and we
    were missing is **breach checking**, now done via HIBP k-anonymity: only the first five
    characters of the SHA-1 hash ever leave the process. It **fails open**, because
    blocking all signup over a third-party outage is the worse failure. Also refused:
    passwords containing the account's own email local part or the product name. Length is
    counted in CODE POINTS — `.length` would let six emoji pass as twelve characters.
  - **Forgot-password** implemented; **"forgot email" was not**, and will not be. Any form
    that confirms an address has an account is an enumeration oracle, and this one needs no
    password to probe. Recovering an email is a support process with identity
    verification, not a page. The reset confirmation is byte-identical for known and
    unknown addresses, asserted in e2e.
  - **A swallowed error hid a real bug.** The reset request called `forgetPassword`, which
    does not exist in Better Auth 1.7 (`requestPasswordReset` does). The TypeError was
    caught by the anti-enumeration catch and the page cheerfully reported "check your
    inbox" while nothing was sent. Unrecognised errors are now RETHROWN in development,
    where they are a defect rather than a privacy concern. Any catch that exists for
    security reasons needs this escape hatch.
  - Email has no provider yet: development prints the reset link to the server console and
    **production throws**. A sender that silently succeeds is worse than an outage, because
    nobody investigates it.
  - **First client component** (`PasswordField`), because nothing in CSS can change an
    input's `type`. Ratchet moves 0 → 1 for a real capability, scoped to one field. Without
    JS the field still works and the toggle simply does nothing.
  - **Structured names.** `first_name`/`last_name` captured at signup with `name` derived
    from them — a single free-text name cannot distinguish two people called John at one
    operator, cannot sort by surname, and cannot address anyone correctly.
  - Cross-suite interference found and fixed: the e2e cleanup deleted every
    `%@example.test` user, which is also what the membership integration tests use — one
    suite deleting another's fixtures mid-run against the shared database. It surfaced once
    as an unreproducible failure. Cleanup is now scoped to a per-run domain.
  - The auth instance is cached on `globalThis` with a contract version, and it needed
    bumping TWICE here — a config change alone leaves the cached instance serving the old
    config, and a newly-enabled endpoint 404s with no clue why. Bump on config changes,
    not only shape changes.
  - Ratchets: tests = **189** + 6 PHAST + **25 e2e**; client components = **1** (was 0,
    with reason); lint = 0.

- **2026-09-07 — Password complexity: separated from password security.**
  - Pushed on "what about complexity?", and the honest answer was that I had conflated two
    questions. **What is SECURE** is NIST SP 800-63B: length and breach checking, no
    composition rules. **What is REQUIRED** is a different matter — PCI DSS 4.0 §8.3.6
    mandates 12+ characters AND both numeric and alphabetic, and an auditor reading that
    checklist is not persuaded by a citation. Composition is now **configurable**
    (`PASSWORD_POLICY=nist|pci`), defaulting to NIST. Entering PCI scope becomes a config
    change, not a rewrite. The policy is data, not an opinion baked into code.
  - **A real hole, found by probing my own work:** `aaaaaaaaaaaa`, `abcdefghijkl` and
    `qwertyuiopas` all passed. NIST names repetitive and sequential strings explicitly, so
    this was a gap in the implementation, not a philosophy difference. Now rejected by
    distinct-character count, run length, ascending/descending runs and keyboard rows —
    with the threshold at five, because a shorter one fails real passphrases.
  - Two existing tests then failed, correctly: they used `"a".repeat(12)` and the literal
    alphabet as fixtures for length and composition. **The tests were asserting that
    terrible passwords are acceptable.** Fixtures replaced. A boundary test needs an input
    that is only interesting for the property under test.
  - e2e was creating a real tenant AND a real Stripe customer on every run of the
    "accepts a passphrase" test — four of each had leaked before it was noticed. It now
    uses a reserved host so the request fails at provisioning, AFTER the password check;
    seeing the host error is positive proof the password passed policy.
  - Ratchets: tests = **205** + 6 PHAST + 25 e2e; client components = 1; lint = 0.

- **2026-09-07 — The operator console: something to land on after paying.**
  - A tenant paid and landed on a status card. The PRD names a "back-office dashboard
    (web, consumes fleet, on-shift, audited)" — but that is the OPERATING surface and
    presumes orders, drivers and shifts. The surface between *paid* and *operating* is
    not in the PRD at all, and that gap is what a new customer falls into.
  - `/dashboard` picks a tenant (redirecting straight through when there is only one);
    `/dashboard/[tenantId]` is the console: a real setup checklist driven by queries, the
    subscription with seats and renewal date, the team roster, and Stripe's billing portal
    for card, seats, invoices and cancellation — which we deliberately do not rebuild,
    since it would mean owning PCI-adjacent flows and a second mirror of the subscription.
  - **The tenant comes from the URL here, which looks like it contradicts the host rule.**
    It does not: the request PROPOSES a tenant and `resolveConsoleMembership` LOOKS UP
    whether this user belongs to it, scoped by both ids, so a forged or malformed id
    returns null. Verified live: foreign tenant, forged UUID and malformed id all refuse
    identically — refusing differently would confirm which tenants exist.
  - Actions re-authorize rather than inheriting permission from the page that rendered the
    button; a form post arrives on its own, carrying whatever the client chose to send.
  - The unbuilt dispatch surface is labelled as unbuilt rather than mocked. An empty widget
    called "Live map" implies a feature; saying it does not exist is more useful.
  - Ratchets: tests = **208** + 6 PHAST + 25 e2e; client components = 1; lint = 0.

- **2026-09-07 — Orders: the first real domain.**
  - `@porterdirect/orders` holds the lifecycle as an explicit TRANSITION TABLE rather
    than scattered `if (status === …)` checks, so every legal move is visible in one place
    and an illegal one fails at the boundary. Two rules there are not conveniences:
    **terminal is terminal** (reopening a delivered order would re-dispatch, re-bill and
    resurrect a tracking session for a driver who may be off shift), and **no skipping**
    (a jump to `delivered` bypasses proof of delivery, which is the evidence the premium
    tier is sold on; a shopping job skipping the till never captures a true total).
  - `isLocationVisible` is part of the state machine, not the UI. Location is scoped to an
    ORDER, never to a person, and ends the moment the order does — asserted for every
    terminal status.
  - `nextStatuses` is the same table `canTransition` guards with, so the console cannot
    offer a move the server would refuse. Tested: every offered move is a legal one.
  - Persistence keeps `tenant_id` **inside the WHERE clause**, never as an
    application-side filter afterwards. `findOrder` is scoped by both ids in one
    predicate — fetching by order id and comparing the tenant later is the shape that
    leaks, because the row is already in memory when the check is missed.
  - The status update is scoped by the status it READ, so two concurrent transitions
    cannot both succeed — the same atomic-claim shape as the webhook ledger, applied to a
    different problem.
  - `order_events` is append-only by convention: who moved the job, when, and from what.
    An editable audit log is not an audit log.
  - Order references are unique **per tenant**, not globally: two operators may both have
    an "ORD-1042", and a global index would leak the platform's total order count through
    collisions. The alphabet omits vowels and 0/O/1/I so a reference cannot spell anything
    unfortunate and survives being read down a phone.
  - Verified against the live database: illegal skips refused with the reason, terminal
    states unreopenable, a shopping job unable to bypass the till, cross-tenant reads
    returning null, and the full audit trail recorded.
  - Ratchets: tests = **235** + 6 PHAST + 25 e2e; client components = 1; lint = 0.
