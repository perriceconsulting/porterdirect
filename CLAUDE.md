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
| What a tier may DO | [packages/billing/src/plans.ts](packages/billing/src/plans.ts) | `capabilities` + `planAllows`/`tenantAllows`. Separate from `features`, which is display copy |
| Product requirements / positioning | [CLAUDE.prd.md](CLAUDE.prd.md) | The one PRD. Restates prices as a declared mirror, reconciled by `prd-reconciliation.test.ts` |
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
| Proof-of-delivery storage | [apps/marketing/lib/storage.ts](apps/marketing/lib/storage.ts) | Neon S3-compatible, private bucket. Presigned both ways; keys persisted, URLs never |
| Order lifecycle | [packages/orders/src/order-state.ts](packages/orders/src/order-state.ts) | Explicit transition table; terminal is terminal, no skipping, location bound to the order |
| Order type/status vocabulary | [packages/orders/src/order-state.ts](packages/orders/src/order-state.ts) | `ORDER_TYPES`/`ORDER_STATUSES`, derived from the label records. The Postgres enum, the action validators and the board all derive; reconciled by `order-vocabulary.test.ts` |
| Why a job ended | [packages/orders/src/closure.ts](packages/orders/src/closure.ts) | Closed reason sets; cancelled and failed are NOT the same list, and fault is three-valued |
| How a status PRESENTS | [packages/orders/src/order-state.ts](packages/orders/src/order-state.ts) | `STATUS_LABELS` + `statusTone`; the board and the order page both derive, neither decides |
| Phone handling | [packages/contact/src/phone.ts](packages/contact/src/phone.ts) | E.164 stored, formatted at point of use; libphonenumber metadata, never hand-rolled |
| Postal addresses | [packages/contact/src/address.ts](packages/contact/src/address.ts) | Stored in parts; labels, requirements and line order vary by country |
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
- **A locale that is only a column default is not detected, it is assumed.**
  `tenants.default_country` defaulted to `US` and nothing could set it, so every tenant
  silently got US phone rules and US address labels. A default nobody can change is a
  hardcoded value wearing a configuration costume.
- **An address stored as one line cannot be dispatched from.** "Which jobs are in this
  postcode", printing a label, geocoding for a router, checking a serviceable area —
  none survive splitting free text after the fact, and every attempt fails on the
  unusual addresses that matter. Store parts; name them `region`/`postal_code`, never
  `state`/`zip`, or every non-US operator puts a non-state into a column called state.
- **A phone number stored as typed is several customers.** "(213) 373-4253",
  "213-373-4253" and "2133734253" match nothing when a driver searches, and cannot be
  handed to a masked-calling provider. Store E.164, format at point of use, and REFUSE
  what will not parse — this is the field someone dials.
- **Fictional numbers look valid and are not.** US area code 555 and Ofcom's 07700
  900xxx block are reserved for drama; libphonenumber rejects both. Test fixtures using
  them assert that the validator accepts numbers nobody can call.
- **A layout class named for its STRUCTURE must not carry one caller's proportions.**
  `.row-2` was set to `2fr 1fr` to stop a plan dropdown clipping; the dropdown later
  moved to its own row and the ratio stayed, silently skewing every other pair — two
  name fields at different widths on two forms. Nothing failed, nothing logged; it was
  visible only in a screenshot. There is now an e2e test that MEASURES paired fields.
- **Stripping commas from a typed amount is a hundredfold bug.** `12,34` is decimal
  notation across most of Europe; treating the comma as a thousands separator turns
  $12.34 into $1,234 silently, on an invoice. `parseUsdToCents` accepts commas ONLY in
  exact thousands positions and refuses anything ambiguous, so a person can correct it.
- **Every export from a `"use server"` module must be async.** A synchronous helper
  exported alongside actions makes the whole route 500 with "Server Actions must be
  async functions" — which reads like a framework problem and is a stray export. Pure
  helpers belong in a package, not beside the actions that use them.
- **An invite link is a bearer credential.** Whoever holds it joins the tenant. Store
  the token HASHED (a database dump of raw tokens is a set of working keys), compare it
  in constant time (a plain compare leaks how many characters matched), bind it to the
  invited EMAIL (a forwarded link must not work for whoever received it), and make it
  single-use and time-bound. Generate it with crypto randomness, not a uuid — a uuid is
  an identifier, and identifiers end up in logs and referrers.
- **"May invite" and "may invite AS OWNER" are different questions.** Collapsing them
  lets an ops user invite themselves a second account as owner. `canInviteRole` is
  separate from `can(role, "members:manage")`, and no role may grant a role above its
  own — asserted as a general property, not left to the table being read carefully.
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
- **A wrapped driver error defeats message matching.** Drizzle wraps the driver error in
  a `DrizzleQueryError` whose message is the failed SQL; the SQLSTATE (`23505`) and the
  constraint NAME live on `.cause`. Two retry handlers here tested `err.message` for a
  constraint name and therefore never matched — one silently stopped retrying reference
  collisions, the other turned a refusal into a raw query error. Classify with
  `isUniqueViolation` (walks the cause chain), never with a regex over the message.
- **A retry loop must only retry what it knows how to fix.** `createOrder` caught any
  `/duplicate key/` and retried with a fresh reference. Once a SECOND unique constraint
  existed on the table, a collision on that one burned five attempts and then reported a
  reference-allocation failure — an error pointing at entirely the wrong problem.
- **A live third-party call inside a test path produces a MOVING failure.** The breach
  check hits `api.pwnedpasswords.com`, which rate-limits, and the signup-heavy e2e specs
  ran in parallel — so a DIFFERENT auth test failed on most full runs, reading like a
  product flake while being a quota. Fixed with `PASSWORD_BREACH_SOURCE=fixture`, which
  answers in HIBP's own wire format so the k-anonymity comparison is still exercised.
  Note the distinction from `PASSWORD_BREACH_CHECK=false`, which SKIPS the check: an
  off-switch would have made the e2e assertion "a breached password is refused" pass
  while testing nothing. A test seam must keep the assertion meaningful.
- **A test seam that weakens a security control must be unable to survive a deploy.**
  `PASSWORD_BREACH_SOURCE=fixture` THROWS when `NODE_ENV=production`, and the match is
  exact — "true"/"1"/"yes"/"FIXTURE" do not enable it. A breach check that quietly became
  a no-op in production would keep the signup form saying all the right things while
  accepting passwords from every public dump.
- **A boolean alias does not narrow a parameter's property.**
  `const closing = args.to === "cancelled" || args.to === "failed"` reads exactly like a
  narrowing check and is not one: TypeScript's aliased-condition narrowing does not reach
  a property of a function PARAMETER, so `args.to` stays wide at the call site. Use a type
  guard (`isClosingStatus`). This shipped to production because `npm run typecheck` only
  covered `packages/` — the Vercel build was the first thing that ever type-checked the app.
- **`tsc -b packages/*` is not "the typecheck".** A monorepo script that names packages
  silently excludes every app, and Next's build is then the first and only check on the
  largest body of code in the repo. `npm run typecheck` now covers `apps/marketing` too;
  adding it immediately surfaced three pre-existing errors, including a test file that
  passed under vitest and could never compile (Next types `process.env.NODE_ENV` readonly).
- **A serverless request body caps around 4.5MB, and a phone photo exceeds it.** Proxying
  proof-of-delivery uploads through a server action would fail on exactly the good
  cameras — the worst possible failure curve for evidence, and invisible until a customer
  disputes a delivery photographed on a decent phone. Uploads are PRESIGNED and go direct
  from the device.
- **Storing a URL instead of a key bakes in the bucket and the signing scheme.** Proof
  rows hold object KEYS; the URL is derived at read time and expires. A permanent public
  link to a delivery photo — which can show a doorway, a face, or a label with a
  patient's name — is the leak, so the bucket is private and nothing ever returns one.
- **`image/svg+xml` is an image to a person and a script host to a browser.** The upload
  content type is an allowlist (jpeg/png/webp), never a denylist, because this decides
  what can be written into a bucket the app serves back.
- **Check-then-act idempotency.** Any "have we handled this?" followed by "mark handled"
  is a race: two concurrent deliveries both pass. Claim atomically (INSERT against a
  unique key) and release on a failed apply. Verified live — a check-then-act store
  double-applied under two concurrent listeners. Applies to every at-least-once feed we
  add, not just Stripe webhooks.
- **`KEY= value` in a `.env` file is executable.** A space after `=` makes a sourcing
  shell assign empty and run the value as a command, printing secrets into logs and
  transcripts. Never `source`/`.` a secrets file — use `scripts/lib/load-env.sh`, which
  parses env files as data. It already cost one key roll.
- **A typed list can be INCOMPLETE and still compile.** `readonly OrderType[]` is
  satisfied by a list with a value missing, so a hand-maintained runtime validation array
  silently rejects a legitimate value at the form boundary while every type check passes.
  Order types and statuses existed in five copies — the union, the Postgres enum, the
  server action validator, the board's creatable types, and the tests — and cutting two
  values meant editing all five with nothing to catch a miss. They now derive from the
  label records, which `Record<OrderType, string>` already forces to be exhaustive.
- **Narrowing a Postgres enum fails on existing rows.** drizzle regenerates the type and
  casts with `USING col::new_type`, which errors on any row holding a removed value —
  and the migration is where you find out. Audit and clear the incompatible rows first,
  scoped by the property that dooms them, and prove zero remain before migrating.
- **Entitlement drift.** Entitlement is derived in one place (`isEntitled`); do not re-derive
  "is this tenant active?" ad hoc anywhere else.
- **A capability check keyed to marketing copy moves when the copy does.** `features` is
  display text and `capabilities` is the permission list; they are separate fields on
  purpose. Gating on a feature STRING means rewording "IFTA state fuel tracking" silently
  changes who can use it. Equally: checking the plan alone leaves a cancelled Agency
  tenant with working API access — `tenantAllows` requires the plan AND entitlement.
- **A PRD that restates prices is a second source of truth.** It is also the copy a human
  quotes in a sales call, so it drifts where it does the most damage.
  `prd-reconciliation.test.ts` reads the real `CLAUDE.prd.md` and fails when the table and
  the catalogue disagree — verified by planting `$459` and watching it fail.
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

- **2026-09-07 — Team invitations: the fleet becomes more than one person.**
  - `assigned` finally means something: an owner or ops user can invite dispatchers and
    drivers, and a driver's board shows only their own assigned work.
  - **Privilege escalation is the risk an invite system carries**, so the role-granting
    rule is separate from "may manage members" and strictly hierarchical: an owner may
    grant anything, ops may grant dispatcher or driver but never owner and **never
    another ops** (otherwise one ops user becomes many), and dispatchers and drivers may
    grant nothing. Tested as a general property — no role may grant above its own rank.
  - The token is 32 bytes of crypto randomness, **stored as SHA-256**, compared in
    constant time, bound to the invited email, single-use and expiring in seven days.
    Each of those closes a specific hole: a database dump of raw tokens is a set of
    working keys; a plain string compare leaks matched prefixes; an unbound link works
    for whoever it was forwarded to; an unexpiring link is a standing key in an inbox.
  - Acceptance CLAIMS the invite first, scoped by "still unaccepted", so two simultaneous
    accepts cannot both create a membership — the atomic-claim shape again.
  - The accept page says as little as possible before sign-in, and gives ONE message for
    "no such token", "expired" and "already used". Distinguishing them would let someone
    probe which tokens exist.
  - Caught while writing it: a withdraw button given `min-height: 36px` because it is a
    "secondary action". Secondary is not an exemption from the 44px minimum — a smaller
    target misfires identically, and this one withdraws an invitation.
  - Ratchets: tests = **243** + 6 PHAST + 25 e2e; client components = 1; lint = 0.

- **2026-09-07 — Order form audited against the PRD; customer names structured.**
  - **Structured customer name**, same reasoning as the user table: one free-text name
    cannot tell two customers called John Smith apart, sort by surname, or address anyone
    correctly. Unlike `users` there is deliberately **no derived `customer_name` column** —
    that one exists only because Better Auth demands it, and with no external constraint a
    display name stored beside its own two parts is a second source of truth.
  - **Pushed back on making the name unique.** Two customers genuinely can share a name,
    and a uniqueness constraint would refuse the second one a delivery. What identifies a
    customer is the PHONE — which is also what the PRD's masked calling keys off. Asserted
    by a test that creates two orders for the same name and expects both to succeed.
  - **PRD gap found and closed:** the brief defines `scheduled_courier` as an "exact-time-
    window white-glove run", and the form collected no time at all. `scheduledFor` is now
    required for that type — an unscheduled "scheduled" job is a contradiction the board
    cannot act on.
  - **PRD gaps found and NOT closed, recorded rather than quietly skipped:**
    `shop_in_store` and `errand` are variable-total types (pre-authorise an estimate plus
    buffer, capture the true total at the till), but the form asks for one fixed price.
    The columns exist (`authorized_cents`, `captured_cents`) and `captureTotal` enforces
    `captured <= authorized`; nothing writes them yet. `errand` also needs a "buy X" list
    the form does not capture. Both are real product gaps, not oversights.
  - Renaming a column with drizzle-kit needs a TTY (it asks rename-or-recreate). With no
    orders to preserve, it was done as two unambiguous migrations — drop, then add —
    rather than hand-writing SQL, so migrations stay generated from `schema.ts`.
  - Ratchets: tests = **264** + 6 PHAST + 25 e2e; client components = 1; lint = 0.

- **2026-09-07 — Dispatch form: looked at it, then fixed what was wrong.**
  - Asked whether the UI was right, the honest answer needed a screenshot rather than
    reasoning. Three defects only visible that way:
    - **Unequal name fields.** `.row-2` still carried `2fr 1fr` from a since-removed
      dropdown fix, so "first name" rendered twice the width of "last name" — on the
      dispatch form AND on signup. Now `1fr 1fr`, with an **e2e test that measures both
      boxes** rather than trusting the stylesheet.
    - **Fields a thousand pixels wide.** The measure argument for running text applies to
      inputs: a long address is hard to scan back along and hard to correct. Constrained.
    - **No grouping.** Seven fields in a flat run; now Customer / Route / Job, with a
      hairline above each group — without it the legends carried the same weight as the
      panel title and the grouping was present in the markup and invisible on the page.
  - Also: price no longer defaults to `0`. A job priced at zero is a plausible typo to
    leave in place, and a placeholder makes the operator state the number.
  - Method note: two of the three were invisible to every test in the suite and to the
    type checker. For anything a person looks at, **render it and look** — a screenshot is
    a cheap test that catches a class nothing else does.
  - Ratchets: tests = 264 + 6 PHAST + **27 e2e**; client components = 1; lint = 0.

- **2026-09-07 — Phone numbers: canonical storage, locale-aware display.**
  - A phone field that accepted forty `1`s with no formatting. Now: **E.164 stored,
    formatted at point of use** — six spellings of one number normalise to one row, which
    is what makes searching by phone and masked calling possible at all.
  - **Not hand-rolled.** Numbering plans are irregular in ways that only show up in the
    markets a white-label platform expands into, so `libphonenumber-js` (min metadata)
    carries the rules. Unparseable input is REFUSED rather than stored raw: this is the
    field a driver dials.
  - The country comes from the TENANT, not the browser. A dispatcher travelling, or a
    VPN, would otherwise silently change how their customers' numbers are read.
  - **Two things the library taught me that I had wrong:**
    - My first fixtures were `555-123-4567` and `07700 900123`, and every test failed.
      Both are RESERVED FICTION ranges. The library was right; the fixtures asserted that
      the validator accepts numbers nobody can call. Same class as the `"a".repeat(12)`
      password fixture.
    - `+44 7911` is attributed to **Guernsey**, not GB — several +44 mobile ranges belong
      to Crown Dependencies. That exposed a real bug: `formatPhone` compared COUNTRY, so
      it showed a neighbour's number in international form to a GB dispatcher who dials
      it exactly like a domestic one. It now compares CALLING CODE.
  - As-you-type formatting only fires when characters are ADDED. Formatting a deletion
    re-inserts the punctuation being removed, so backspace appears to do nothing — the
    most common way such a field becomes unusable. Verified in a real browser.
  - Ratchets: tests = **289** + 6 PHAST + 27 e2e; client components = **2** (the input
    genuinely cannot format between keystrokes without JS); lint = 0.

- **2026-09-07 — Phone field: capped by digits, and says when a number is unusable.**
  - Reported as "it starts to format then fails". That was libphonenumber behaving
    correctly — it reads a leading `1` as the US country code, then no plan matches the
    remaining digits, so it stops formatting and appends. Internally right, and it reads
    as broken.
  - Capped by **digit count**, not string length: E.164 allows 15 digits, and past that
    the formatter can only degrade. Refusing the extra digits keeps the field in a state
    the formatter can actually render.
  - Added live validity: `aria-invalid`, a coloured border, and a message in the hint
    slot. **Colour does not carry the meaning** — the wording says what is wrong. Nothing
    is said below 7 digits, because judging a half-typed number is nagging.
  - The message names the country properly via `Intl.DisplayNames` ("United States", not
    "US") and is phrased so the name works as a MODIFIER — "a valid United States
    number". After a preposition it would need an article that is right for "the United
    States" and wrong for "France".
  - Ratchets: tests = 289 + 6 PHAST + 27 e2e; client components = 2; lint = 0.

- **2026-09-07 — Structured addresses, and a locale that is actually chosen.**
  - Asked how the locale was detected, the honest answer was that it **was not**.
    `tenants.default_country` defaulted to `US` and nothing could change it, so both
    tenants read `US` because that is the column default — not because anything decided.
    A country picker now appears at signup, sourced from the phone metadata and sorted by
    DISPLAY NAME (nobody scans for "GB" under G expecting United Kingdom).
  - Addresses are stored in PARTS. Named `region` and `postal_code`, not `state` and
    `zip`: a column called `state` forces every non-US operator to put something that is
    not a state into it, and that vocabulary spreads into queries and exports.
  - Country is stored **per address**, not taken from the tenant — freight runs cross
    borders, and a pickup may not be in the operator's own country.
  - Labels, requirements and LINE ORDER vary by country: the US wants a State and ZIP and
    prints "Washington, DC 20500"; the UK does not require a county and prints the
    postcode alone on the last line. An unlisted country falls back to neutral wording
    rather than being shown American labels.
  - Postal code SHAPE is deliberately not validated. Formats change, and a regex that
    rejects a real new postcode blocks a real delivery. Presence is our business;
    correctness is the postal service's.
  - Two layout bugs, both found by measuring rather than looking: `nth-of-type` placement
    broke as soon as a group moved, and removing the stacked rule from only ONE of the
    paired address blocks left them 22px out of line. Positional selectors are fragile;
    a pair meant to read as one row must be styled identically.
  - Ratchets: tests = **310** + 6 PHAST + 27 e2e; client components = 2; lint = 0.

- **2026-09-07 — Scope decision: US-first.**
  - Focus narrowed to the US, which is more consistent with the PRD than the
    international work that preceded it: **IFTA is a US/Canada agreement and Rate Cons
    are US freight paperwork**, so the freight vertical was never going global first.
  - What changed: the country picker is gone from signup. Asking every operator to state
    a country in order to answer "US" is a field that earns nothing on a form that
    already has seven.
  - What deliberately did NOT change: `tenants.default_country`, `addressLabels()`,
    `supportedCountries()`, E.164 phone storage, and `region`/`postal_code` naming. Those
    are not "international features" — E.164 is what makes phone search work at all, and
    a column called `state` would force a non-US operator to put a non-state into it.
    Removing them would be work that reduces capability.
  - The picker COMPONENT was deleted rather than parked. An unused component kept "for
    later" is speculative structure; the data layer is what makes serving a non-US
    operator a form change rather than a migration, and the widget is forty lines to
    write again when an operator needs it.
  - Ratchets unchanged: tests = 310 + 6 PHAST + 27 e2e; client components = 2; lint = 0.

- **2026-09-07 — Seed script, and what a populated board revealed.**
  - `npm run seed:demo -- <owner email>` fills a tenant's board with seven jobs spanning
    every lifecycle state. It refuses to run with `NODE_ENV=production`, because a seed
    script that quietly runs against production is how demo data reaches a customer.
  - The data is **real-shaped on purpose**: dialable numbers, genuine street addresses,
    courier-sized prices. A board of "Test Customer / 123 Test St / $0" tells you nothing
    about whether the layout survives real content — and it would not have surfaced
    either bug below.
  - Jobs are walked through the real STATE MACHINE rather than written straight to a
    status, so the seeded board carries a genuine chain-of-custody trail and an illegal
    path in the seed file fails loudly instead of producing a row nothing can move.
  - **Populating it exposed a missing column.** There was no "Deliver to" — the
    destination only appeared when a job happened to have no phone number. Where a job is
    going is the first thing a dispatcher scans for; on an empty board that omission is
    invisible.
  - **And then I reintroduced a bug I had already fixed.** Hand-joining the address parts
    with `", "` rendered "Washington, DC, 20500" — the extra comma before the ZIP is
    exactly what `formatAddressLines` exists to prevent. Having a formatter is not the
    same as using it; bypassing it for "just this one cell" is how the convention drifts.
  - Ratchets: tests = 310 + 6 PHAST + 27 e2e; client components = 2; lint = 0.

- **2026-09-07 — Closing a dispatch: cancelled vs failed, and re-dispatch.**
  - **Cancelled and failed carry DIFFERENT reason sets**
    ([packages/orders/src/closure.ts](packages/orders/src/closure.ts)). They are not
    synonyms: a cancelled job was never attempted, a failed one was. That distinction
    decides who absorbs the cost, whether a re-attempt is reasonable, and whether the
    number reflects on the operator at all — so one merged list would destroy the only
    thing the field is for. Reasons are a closed set, not free text: "nobody home" typed
    forty ways cannot be counted, and counting is the entire point.
  - **Fault is three-valued** (`operator` / `customer` / `neither`), not a blame flag.
    Recording weather as the operator's fault makes their own numbers worse than the work
    was, which is how a metric stops being used.
  - **Re-dispatch creates a NEW linked order, never a reopened one.** Terminal stays
    terminal. Reopening would rewrite the first attempt's history and erase its failure
    from the operator's numbers. `redispatched_from_order_id` links the two, and a job
    can only be re-dispatched once.
  - `transitionOrder` now REFUSES a closing transition with no reason, and refuses a
    reason belonging to the other status ("customer_cancelled" is not a way to fail).
    The seed script had to be updated to supply one — a seed that could skip it would be
    modelling something the product does not allow.
  - **A defect only a person looking at the page could catch.** The order page chose its
    status colour with `isTerminal(status)` — true of delivered, cancelled AND failed —
    so a job that never arrived rendered in the same success green as a delivered one.
    323 unit tests passed. The dispatch board had independently decided the same question
    and reached a different answer, which is the DOSI-S failure exactly: two places
    deciding one thing and drifting. Tone is now derived once, from the domain
    (`statusTone`), and the base `.pill` was retoned to NEUTRAL — green is a claim, and a
    default that made it silently was also wrong on every bare role badge in the app.
  - **S:** `statusTone` joins `STATUS_LABELS` as the single origin for how a status
    presents. **I:** tone follows OUTCOME, not finishedness — cancelled reads neutral
    because nobody attempted it, matching the reason sets rather than contradicting them.
  - New PHAST/e2e pillar: [e2e/orders-closure.spec.ts](e2e/orders-closure.spec.ts) builds
    its jobs through the board's own form and the real transition buttons rather than
    inserting rows, so a fixture cannot assert against a state the product can't reach.
    The colour assertion was verified non-vacuous by re-introducing the `isTerminal`
    branch: it failed with `Received string: "pill good"` on a failed job.
  - Also corrected: the seed file's header claimed every number was dialable and that no
    555 numbers were present, while two fixtures were 555 numbers — one inside the
    555-01xx block genuinely reserved for fiction. A comment that lies about the data
    beside it is worse than no comment.
  - Left alone (with reason): `formatUsdCents` still drops a whole-dollar ".00", so a job
    board can show "$41" above "$48.50". Correct and documented for a catalogue price
    ($199, not $199.00); a second transactional formatter would be an abstraction on the
    second use, not the third. Worth revisiting if operators read these columns as a
    ledger.
  - Ratchets: tests = **327** + 6 PHAST + **33** e2e; client components = 2; lint = 0.

- **2026-09-07 — PRD reconciled with the code; tier capabilities made machine-readable.**
  - A PRD arrived as JSON restating the catalogue. The prices, seat counts and tier names
    matched `plans.ts` exactly, and `app`/`fleet` were already reserved subdomains — so
    most of it needed no change. Four things did.
  - **`driverLimit` was the wrong word, and it contradicted `additionalDriverPrice`.** A
    limit refuses the sixth driver; what is built is an included count with $25 overage,
    and nothing anywhere enforces a cap. A wall and a meter are different products, and
    the code is the one a customer experiences. The PRD now says "included, never limit"
    and explains what a hard cap would additionally require, since today there is no
    field and no enforcement point.
  - **Capabilities are now data, separate from copy.** Tier features were prose strings
    gated nowhere: `isEntitled` only answers "is the subscription active", never "may
    this tenant use OCR". Each plan carries `capabilities: PlanCapability[]`, read by
    `planAllows` (a commercial question) and `tenantAllows` (an access decision). They are
    separate from `features` deliberately — a permission keyed to a marketing sentence
    moves the day someone rewords the sentence.
  - **`tenantAllows` requires the plan AND entitlement.** Checking the plan alone leaves a
    cancelled Agency tenant with working API access; checking entitlement alone gives a
    $199 courier the freight module. It composes `isEntitled` rather than re-deriving it.
    An unknown plan id refuses rather than throwing — an access check is the wrong place
    to turn a data problem into an outage.
  - Capability lists are written out **per tier, not inherited**, for the same reason the
    role matrix is: widening a parent silently widens every child. The monotonicity that
    inheritance would have given for free is asserted as a property instead — a dearer
    tier may never carry fewer capabilities than a cheaper one.
  - **The gate was verified to fail.** Removing the entitlement line made exactly the two
    tests that exist for it fail; the rest stayed green.
  - **One PRD, and it now reconciles.** No `prd.json` was added — a second PRD restating
    prices is a second source of truth, and `CLAUDE.prd.md` already declared the catalogue
    canonical. It keeps the numbers a human needs and
    [prd-reconciliation.test.ts](packages/billing/test/prd-reconciliation.test.ts) reads
    the REAL document (never a fixture, which would drift identically) and fails on any
    disagreement. Verified by planting `$459/mo` and watching it fail. It also guards
    itself: a test asserts a row is found for every plan, because a reformatted table that
    matched nothing would let every other assertion pass vacuously.
  - Merged in from the new document: the two researched buyer avatars with their pain
    points and search intent. Those live in the PRD rather than the catalogue because no
    code derives from them — acquisition intent is not a product requirement.
  - **Corrected two claims that were aspirational, not true.** `storage: Vercel Blob` and
    `deployment: Vercel` describe nothing that exists. That matters more than it reads:
    signature + photo POD is a **$199 entry-tier** feature, so blob storage is blocking at
    the bottom of the price list, not a freight extra.
  - **§11 was months stale** — it claimed 27 tests, no auth and no Next.js app while the
    ledger here was current. Rewritten to state what is built, what blocks a first paying
    customer in order, and what is sold but not built. A status section nobody trusts is
    worse than none, because it still gets quoted.
  - Left alone (with reason): the tier→subdomain model needed no change; `classifyHost`
    already reserves `app` and `fleet` as platform surfaces, so the PRD and the host rules
    agree. Nothing is served on them yet, which is a deployment gap and not a model gap.
    "100% Platform Anonymity" is still one bullet carrying a lot of engineering (sender
    domain, referrer, PWA manifest, app store listing); flagged in the PRD rather than
    decomposed, because decomposing it now would invent requirements ahead of a customer.
  - Ratchets: tests = **347** (was 327) + 6 PHAST + 33 e2e; client components = 2; lint = 0.

- **2026-09-08 — v1.3: shopping order types cut; one vocabulary instead of five.**
  - PRD v1.3 narrowed `orderTypes` to `fixed_pickup` and `scheduled_courier`. Cut rather
    than parked, matching the country-picker precedent: `shop_in_store`, `errand`, the
    `shopping`/`checkout` states, `hasShoppingPhase`, the `items_unavailable` failure
    reason, and **the whole pre-authorise/capture payment model** (`authorized_cents`,
    `captured_cents`, `captureTotal`). For the two surviving types the captured amount is
    always the agreed price, so a second nullable amount was a column that could only
    disagree with itself. **Zero rows carried one**, checked before dropping.
  - This closed two long-standing gaps by deletion rather than by building: the
    variable-total columns nothing wrote, and the errand "buy X" list never captured.
    Product-catalogue sourcing — previously the gating dependency in the PRD — left the
    critical path with them.
  - **The migration would have failed on live data.** drizzle narrows an enum by
    recreating the type and casting `USING col::new_type`, which errors on any row still
    holding a removed value. Two seeded orders and seven events held them. Audited first
    (read the rows, counted them, confirmed they were regenerable demo data on the demo
    tenant), cleared scoped by the property that doomed them — the order TYPE, not a name
    pattern — and asserted zero incompatible rows survived before migrating. The repo has
    already deleted a real user with a loose `LIKE` sweep; this is that lesson applied.
  - **The cut exposed the real finding: five copies of one list.** Removing two values
    meant hand-editing the union, the Postgres enum, the server action's validator, the
    board's creatable types, and the tests. Nothing would have caught a missed one —
    `readonly OrderType[]` is satisfied by an INCOMPLETE list, so a validator missing a
    value compiles and then silently refuses a legitimate job type at the form boundary.
    Same two-places-drifting failure as `statusTone`, spread over five.
  - **S:** `ORDER_TYPES`/`ORDER_STATUSES` are now derived from the label records, which
    `Record<OrderType, string>` already forces to be exhaustive at compile time — so the
    labels ARE the list. The Postgres enum derives from them too (db -> orders; `orders`
    is pure, so no cycle), because restating the vocabulary in the schema is how the
    database comes to accept a status the state machine has never heard of.
  - The derivation is guarded, not merely conventional:
    [order-vocabulary.test.ts](apps/marketing/test/order-vocabulary.test.ts) asserts the
    enums equal the domain lists and that no shopping vocabulary survives. Verified
    non-vacuous by re-hardcoding the enum with `errand` restored — three tests failed.
  - Recorded in the PRD, not built: v1.3's package scanning and POD. Both need a driver
    app that does not exist. Scanning needs a parcel entity that does not exist, and its
    design question is whether a package scanned at pickup but not at handoff produces a
    STATE — detecting the missing parcel is the whole value. POD's geotag must be a single
    point captured at the closing transition, not continued tracking (the location
    landmine), and its branded PDF is the first artifact reaching a tenant's customer, so
    it is the first real test of "100% platform anonymity". Blob storage now blocks three
    things rather than one.
  - Ratchets: tests = **349** (was 347) + 6 PHAST + 33 e2e; client components = 2; lint = 0.

- **2026-09-08 — I shipped a check-then-act race; closing it, and covering orders under load.**
  - **The defect was mine, in the file that explains why not to write it.**
    `redispatchOrder` selected for an existing re-dispatch and then inserted — the same
    shape as the webhook ledger bug — while the function directly above it carries a
    comment saying a SELECT-then-INSERT is that exact race. Its own comment named the
    consequence: "an impatient double-click quietly puts two drivers on the same
    delivery." Two concurrent callers both passed the check and both created a job.
  - A second window existed even single-threaded: the job was created and THEN linked, so
    a failure between the two left an unlinked duplicate that the once-only rule could no
    longer see.
  - Fixed the way this repo already fixes it: **a unique index answers the question
    atomically**, the link travels IN the insert, and the loser reads back which job won
    so the operator is told where the work went rather than just being refused.
  - **Two latent bugs surfaced while fixing it.** Drizzle wraps driver errors, so the
    constraint name is on `.cause`, never in `.message` — meaning the pre-existing
    reference-retry regex had never matched and was rethrowing collisions instead of
    retrying. And that catch matched any `/duplicate key/`, so once a second unique
    constraint existed, an "already re-dispatched" collision would burn five retries and
    report a reference failure. Both now go through `isUniqueViolation`, which walks the
    cause chain and reads SQLSTATE `23505` — shape, not text, the same lesson as
    `classifyAuthError`.
  - **Order concurrency is now covered** —
    [order-concurrency.test.ts](apps/marketing/test/order-concurrency.test.ts), closing a
    gap this file has listed as open since orders landed. Placed as an integration test
    rather than in PHAST deliberately, per our own rule: uniqueness is a data invariant,
    so it belongs in a deterministic test, not a browser rendering of the rule.
  - **Verified non-vacuous, and the method mattered.** Re-introducing the pre-check did
    NOT fail the race test — because the index was still there doing the work. Only
    dropping the unique index reproduced the bug: **8 concurrent attempts, 8 winners.**
    Worth recording, because it says plainly where the guarantee lives. A guard proven by
    reverting the wrong layer proves nothing.
  - Also covered: concurrent forward transitions and concurrent closure (cancel racing
    fail, both legal from `assigned`) each apply exactly once, with one audit line — so
    the compare-and-swap in `transitionOrder` is now demonstrated rather than assumed.
  - **Reported, not fixed:** the e2e suite fails a DIFFERENT auth test on most full runs.
    Diagnosed as HIBP rate-limiting — every signup makes a live call to
    `api.pwnedpasswords.com` and the signup specs run in parallel. Each test passes in
    isolation. It is a test-harness dependency, not a product fault, and the fix is to
    inject the range-fetcher rather than to retry.
  - Ratchets: tests = **354** (was 349) + 6 PHAST + 33 e2e; client components = 2; lint = 0.

- **2026-09-08 — Made the e2e suite trustworthy again.**
  - The suite failed a **different** auth test on most full runs. Diagnosed rather than
    retried: every signup makes a live call to `api.pwnedpasswords.com`, the signup specs
    run in parallel, and HIBP rate-limits. Each test passed in isolation, which is the
    signature of a shared external dependency rather than a product fault.
  - **Fixed with a fixture SOURCE, not an off-switch.** `PASSWORD_BREACH_CHECK=false`
    already existed and would have been the lazy fix — but it skips the check, so the e2e
    assertion "a breached password is refused" would have passed while testing nothing.
    `PASSWORD_BREACH_SOURCE=fixture` answers in HIBP's own wire format from a local list,
    so prefix matching, suffix comparison and the count column all still run. Only the
    network is removed.
  - **The seam cannot survive a deploy**, and that is tested, not promised: it throws on
    `NODE_ENV=production`, and the match is exact so no truthy value enables it. A breach
    check that silently no-oped in production is the worst failure available here.
  - **O, with the metric:** e2e went from ~5.0m to ~3.0m, because every signup previously
    blocked on a network round-trip. Two consecutive clean runs where the previous two
    both failed.
  - The fixture list is real leaked passwords, not invented strings — a fixture proving
    we refuse `test-breached-password-1` proves the plumbing and nothing about the rule.
  - Wired in two places for one reason worth remembering: Playwright's
    `reuseExistingServer` means its `webServer.env` only applies when Playwright STARTS
    the server, so a dev server already on the port keeps its own environment. The value
    is therefore also in `.env.local`. Documented in `.env.example`.
  - **Blocked, not done:** rotating the Neon role password. The MCP call was refused by
    the permission classifier — correctly, it destroys a live credential. The connection
    string is still exposed in this session's transcript and still needs rotating by hand.
  - Ratchets: tests = **360** (was 354) + 6 PHAST + 33 e2e; client components = 2; lint = 0.

- **2026-09-09 — Live on porterdirect.com; Stripe compliance audited end to end.**
  - **The production webhook endpoint did not exist.** Zero endpoints were registered on
    the account, and the `STRIPE_WEBHOOK_SECRET` in `.env.local` was the one `stripe
    listen` derives for a LOCALHOST forwarder. A real checkout would have succeeded at
    Stripe and the tenant would never have activated, because nothing told the app. This
    is the "per account AND per endpoint" landmine arriving exactly as described: not a
    visibly broken checkout, but silence.
  - Endpoint created for `https://porterdirect.com/api/stripe/webhook`, registering only
    the three events the app actually handles rather than a wildcard — an endpoint
    subscribed to events nothing consumes generates retries for messages we will never
    act on, and buries the ones that matter.
  - **Verified end to end against the live endpoint**, not asserted:
    - unsigned → **400** (Stripe does not retry; a forgery never becomes valid)
    - forged signature → **400**, with the real verification error in the log
    - `GET` → **405**
    - a genuine `stripe trigger` event → signature **accepted**, routed, and then
      correctly refused with `no line item matching a known plan Price` and a **500** so
      Stripe retries — because the fixture subscription uses a throwaway Price, not one
      from our catalogue. Two retry attempts observed. That is the contract working.
  - **A 500 on a forged signature was found and traced.** It was the "not configured"
    branch: the deployment serving the domain predated the secret being set. Worth
    recording because the symptom pointed at the wrong layer — the route's error handling
    was correct all along, the environment was stale. Redeploy after setting an env var;
    Vercel reads them at build time.
  - **Stripe Tax is `pending`, missing `head_office`, with 0 registrations.** So
    `STRIPE_AUTOMATIC_TAX=false` is not a lazy default — it is the only correct value
    today, and `provisioning.ts` refuses to run a LIVE key while it is false. The
    compliance gate is mechanical: real money cannot be taken until tax is configured.
  - Production runs **test-mode keys** (`rk_test_`), so nothing charges anyone yet. Said
    plainly because a deployed site on a real domain invites the assumption otherwise.
  - PCI position unchanged and worth restating: card data never touches this app. Stripe
    Checkout is hosted, and the billing portal is Stripe's — which is why neither was
    rebuilt.
  - Also: `BETTER_AUTH_URL` moved from the generated `vercel.app` URL to the apex, since
    it is both the auth callback origin and the base for links in outbound email; and
    `www` now 308s to the apex, in `next.config` rather than dashboard state.
  - Ratchets unchanged: tests = 360 + 6 PHAST + 33 e2e; client components = 2; lint = 0.

- **2026-09-09 — Proof of delivery: storage, capture, and the evidence panel.**
  - **Neon object storage over a platform blob API**, for reasons that outlast
    convenience: same vendor and region as the database (one BAA conversation rather than
    two if the medical work lands, and no cross-region transfer on the largest objects in
    the system), and the S3 API is portable — moving later is config, not a rewrite.
    Bucket is **private**; a POD photo can show a face or a patient label.
  - **Uploads are presigned and go direct from the device.** Not a preference: the
    platform caps a serverless request body near 4.5MB and a full-resolution phone photo
    exceeds that, so proxying would fail on the best cameras. The declared length is
    SIGNED INTO the URL, so the size limit survives leaving our process.
  - The photo is never resized or re-encoded. "Full resolution" is the requirement, and
    compression is invisible until somebody needs to zoom in on the evidence.
  - **`order_proofs` is its own table, not more nullable columns on `orders`.** Proof is a
    different kind of record — evidence, captured once, by a named person, at a place and
    time. Orders get edited; evidence should not. One proof per order, enforced by a
    unique index rather than a pre-check, because two proofs raise "which one is the
    evidence?" at exactly the moment somebody is disputing a delivery.
  - Rows hold object KEYS, never URLs. A stored URL bakes in the bucket host and the
    signing scheme, so a bucket move rewrites history; and a permanent link to a delivery
    photo is the leak. Read URLs are signed per render and expire.
  - **Capture and transition are separate steps, in that order.** Fusing them means a
    failed transition discards a signature the recipient already gave — which cannot be
    re-collected once the driver has left the door. Proof is recorded first; if the
    transition then fails the evidence still stands and the operator is told why.
  - **Location is a single point at handover, not a feed.** That is the legal distinction
    already in this file, so it is plain columns on the proof row rather than a
    rows-over-time table. A refused geolocation permission is not an error and never
    blocks a delivery.
  - **A job marked delivered with NO proof still renders the panel**, saying so. Hiding
    the section would read as "no problem" rather than "no evidence".
  - Third client component, and it earns it: a signature is drawn. `touch-action: none`
    on the pad, because without it a drag scrolls the page and signing is impossible on
    the device this is FOR.
  - Lint caught the prop typed `=> void` for an action that returns a promise — the
    component was claiming synchrony it did not have, and `busy` would have cleared
    before the write landed.
  - **Not yet verified end to end**: no storage credential exists yet, so presigning is
    proven by unit test (local HMAC, no network) and the round trip is not. Said plainly
    rather than implied — the code is written, the upload has never happened.
  - Ratchets: tests = **377** (was 360) + 6 PHAST + 33 e2e; client components = **3**
    (was 2, with reason); lint = 0; min-width:max-width media queries = 9:0.
