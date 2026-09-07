# PorterDirect — Product Requirements Document

> Captured from the founding scoping conversation. This is the **product/strategy**
> record; the engineering standard and Single-Source tables live in [CLAUDE.md](CLAUDE.md).
> Market claims are hypotheses to validate (§12), not established facts.

Status: pre-launch. Last updated 2026-09-07.

---

## 1. One-line summary

A **multi-tenant, white-label logistics SaaS platform**. PorterDirect builds and rents the
software; operator-tenants (courier firms, freight dispatchers, agencies, retailers) run the
physical deliveries under their own brand and domain. We are the technology infrastructure,
not a delivery company.

## 2. Business model — sell the software, not the operations

The strategic decision: **be the platform, not the operator.** Rather than running drivers,
fleets, insurance, and worker-classification risk ourselves, we license the platform to
operators who already have local relationships and handle the physical work + local compliance.

- **High margin, low capex.** Software subscription margins (~70–80%) vs. low-margin,
  high-risk physical logistics.
- **Rapid scale.** Onboard tenants across many cities without boots on the ground.
- **Product focus shifts** to developer-grade reliability, tenant isolation, and branding
  controls — the moat is trust/brand/operations, which our tenants provide; our job is to
  *signal and enforce* it in software.

## 3. Target buyers (tenants)

- Boutique concierge & private security agencies (high-net-worth clientele).
- Local & independent courier operators modernizing legacy dispatch.
- Digital agencies & resellers packaging white-label delivery for their own clients.
- Luxury retailers & jewelers wanting branded same-day white-glove handoffs.
- Medical & legal courier fleets needing strict chain-of-custody.
- Small-fleet freight: owner-operators and 1–15 truck fleets, independent dispatchers.

## 4. Two vertical modules on one shared core

The platform is **one codebase**: a shared core + two domain modules. They share primitives
(auth, tenancy, DB, payment rails, maps, location pipeline) but have distinct domain logic —
they are NOT one product with skinned views.

| | **Courier** (`app.` subdomain) | **Freight** (`fleet.` subdomain) |
|---|---|---|
| Vehicles | Cars, SUVs, sprinter/cargo vans | Box trucks, semis (dry van / flatbed) |
| Distance | Local 5–50 mi | Regional/interstate 50–1,000+ mi |
| Dispatch | Dynamic / on-demand | Pre-booked hours/days ahead |
| Value metric | Speed, tracking presentation, trust | Rate-per-mile, paperwork speed, cash flow |
| Signature feature | White-label tracking link + instant dispatch | Rate Con OCR + automated factoring invoices |

## 5. Architecture

```
PorterDirect Platform (npm-workspaces monorepo, multi-tenant, white-label)
├── packages/core     shared: auth, tenancy, branding/custom-domains, Stripe, maps, location
├── packages/ui       shared design system (the "polish" that is the brand)
├── apps/marketing  → porterdirect.com
├── apps/concierge  → app.porterdirect.com    (courier domain logic)
└── apps/fleet      → fleet.porterdirect.com  (freight domain logic)
```

- **Domains:** subdomains under one apex (`porterdirect.com`); white-label tenants map their
  own CNAME (`dispatch.theircompany.com`). Optional vanity apex 301s to a subdomain.
- **Multi-tenant from day one.** `tenant_id` on every owned row; host → tenant resolution.
- **Four surfaces:** Driver app (native, produces location), Customer app (web/native,
  consumes one order), Back-office dashboard (web, consumes fleet, on-shift, audited),
  Backend (shared pipeline). One producer, two consumers, one backend.

## 6. Polymorphic order model

One order type field drives the lifecycle; the back half (delivery leg, tracking, POD) is
shared across all types:

```
fixed_pickup:    ASSIGNED ─────────────────▶ EN_ROUTE ─▶ DELIVERED   (fixed total)
shop_in_store:   ASSIGNED ─▶ SHOPPING ─▶ CHECKOUT ─▶ EN_ROUTE ─▶ DELIVERED
errand/concierge: (variant of shop_in_store — buy X, pick up from Y)
scheduled_courier: exact-time-window white-glove run
```

## 7. Key subsystems

- **Real-time location tracking** — per-order channel, fan-out via managed realtime (Firebase/
  Supabase/Ably-class) or Redis pub/sub + WS. Client interpolates between sparse fixes. The
  showcase feature for the trust-sold courier product.
- **Offline-first driver app** — local storage (SQLite/WatermelonDB) as source of truth during
  a delivery; predictive bounding-box map-tile caching on dispatch; **event-sourced** offline
  queue with client-generated ids + sequence numbers; background sync on reconnect; optimistic
  UI that reconciles and surfaces sync failures.
- **Communication** — per-order channel carries canned messages + free-text chat; for shopping,
  a **structured substitution approve/reject** card (primary), free chat (fallback); optional
  masked calling (Twilio Proxy). CS can read an order's chat for disputes.
- **Proof of delivery / chain-of-custody** — signature + photo (stored high-res as potential
  evidence), plus a who-held-it-when trail for legal/medical/high-value.
- **Dispatch & scheduling** — the real economic engine (premium utilization is the hard part):
  exact-time scheduling to pack a courier's day; affinity ("your regular driver") vs. nearest-
  available tradeoff; premium-safe batching.
- **Vetting** — background-check integration (Checkr-class); vetting surfaced as a product
  feature (badges, courier profile).
- **Freight module** — load boards; **Rate Con OCR** (drag-drop broker PDF → extract rate,
  pickup/drop, load #, human-confirmed); **IFTA** per-state mileage → quarterly summary;
  **factoring** (POD → clean PDF invoice → factoring company). Each is substantial specialist
  work; "thin" v1s have a real floor.

## 8. Payments

- **Licensee → us (BUILT, see §11):** monthly Stripe **Billing** subscriptions per tenant.
- **Customer → tenant / driver payouts:** Stripe **Connect** (Express accounts) — 1099
  contractor marketplace payouts + instant-pay; **Issuing** later for branded/store cards.
  This is the model DoorDash/Instacart/Spark use.
- **Shop-in-store:** pre-authorize estimate + buffer → capture actual at checkout; refund
  not-found items. Invariant: `captured ≤ authorized`; re-auth if actual exceeds.
- **Freight:** factoring integration, not card charges.

## 9. Pricing (tenant subscriptions) — canonical in `packages/billing/src/plans.ts`

| Tier | Price | Seats | Highlights |
|---|---|---|---|
| **Direct Courier** | $199/mo | 5 incl., $25/extra | CNAME, branded PWA tracking, offline maps, POD |
| **Fleet & Freight** | $499/mo | 15 incl., $25/extra | + Rate Con OCR, factoring invoices, IFTA, broker GPS |
| **White-Label Agency** | $999/mo + $1,500 setup | 50 incl., $25/extra | + sub-accounts, native app deploy, API/webhooks, anonymity |

Add-ons: native app-store deployment ($499 one-time), SMS/WhatsApp (metered pass-through +20%),
extra seats ($25/mo). Positioning: **zero per-delivery commission** — beats Onfleet ($619/mo
task fees) and Dispatch Science ($675+/mo before white-label). Each tier Price is a graduated
per-seat Stripe Price; subscription quantity = total active seats.

Licensing variants under consideration: monthly SaaS rent, per-dispatch royalty ($1.50–$3),
one-time source-code license ($5k–$25k+).

## 10. Domain landmines (silent failures) — see CLAUDE.md for the enforced list

Tenant data bleed · wrong Stripe account returns 200 · webhook double-apply · money-as-float ·
entitlement drift · off-shift / post-delivery location tracking (legal liability) · optimistic/
offline updates that never reconcile · over-compressed POD photos destroying evidence · blind
trust of OCR extraction · pre-auth expiry / capture > authorized.

## 11. Current build status

**Billing slice (licensee subscriptions) — built, 27 unit tests green, `tsc -b` clean.**
- npm-workspaces monorepo; `@porterdirect/db` (Drizzle schema, tenant-scoped); `@porterdirect/
  billing` (canonical plan catalog, pure entitlement/seat/money logic, Stripe test-mode guard,
  verify + idempotent webhook dispatch).
- Stripe dev-setup instantiated: `docs/stripe-dev-setup.md`, `scripts/stripe-doctor.sh`,
  `scripts/guard-stripe-env.sh`, `.env.example`.
- **Not yet:** live Stripe calls (needs test keys), DB-backed webhook store/sink (ports only),
  Next.js apps, auth, the driver app, either vertical's domain logic, lint config.

## 12. Hypotheses to validate (NOT established facts)

These came from preliminary market research and read as promotional/AI-generated; treat as
hypotheses until sourced:

- Market-size figures ($25B white-glove/concierge; trucking SaaS TAM) — need named sources;
  "white-glove logistics" is not a clean category.
- "Top 10–15% of high earners deliberately avoid gig apps" — shaky; affluent people use them.
  Sharper thesis: specific high-stakes jobs (legal docs, lab samples, high-value gifts) where
  they won't trust a gig app.
- Reddit/TikTok/LinkedIn sentiment is *signal*, not validation. The real validation metric is
  **pre-commitments** (operators/retailers putting a card on file before build).
- **Utilization risk:** premium flat-rate + dedicated vetted drivers has a hard idle-capacity
  problem; the market may be fragmented *because* the unit economics are hard. This makes
  dispatch/scheduling efficiency the highest-leverage software, not the tracking.
- Trucking stats (91% ≤10 trucks, 65% single-truck) are directionally credible; pricing bands
  and the keyword/forum go-to-market research are the more actionable parts.

## 13. Open decisions / next steps

- First-product sequencing: chosen "shared core + both thin" with white-label core from day one;
  recommend one vertical (courier) leads by a few weeks so a solid product demos before a broad one.
- Product-catalog sourcing (shopping/errand orders) — undecided; the gating dependency. Suggest a
  small owned pilot-store catalog before retailer integrations.
- Customer surface: web link vs native app (dashboard = web, driver = native are settled).
- Immediate build fork: (a) provide Stripe test keys → wire real checkout + reconciler, or
  (b) scaffold Next.js platform app + webhook route so the "one real call" can be exercised.
