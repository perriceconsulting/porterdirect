# PorterDirect — Product Requirements Document

> Captured from the founding scoping conversation. This is the **product/strategy**
> record; the engineering standard and Single-Source tables live in [CLAUDE.md](CLAUDE.md).
> Market claims are hypotheses to validate (§12), not established facts.

**Version 2.0.0** · Status: pre-launch · Last updated 2026-09-10.

> **What changed in 2.0:** the headline. White-label was the pitch and is now a feature.
> Competitor research established that branded, no-login tracking and self-service booking
> are shipped by at least six vendors, several of them cheaper — so "run your operation
> under your own brand" cannot carry a $199–$999 price. The product is the **evidence**.
> A repo audit run at the same time found that some of what §11 claimed as built was not,
> and that section is corrected below.

---

## 1. One-line summary

**PorterDirect sells the evidence a courier needs to win and keep contracts. Dispatch is
how the evidence gets produced.**

A courier firm with 3–20 drivers cannot produce a chain-of-custody trail, proof of
delivery, temperature documentation, on-time reporting at 95–98%, a signed BAA, or a
SOC 2 report. Hospitals, labs and public-health buyers demand all six before they will
sign. We produce them, so the courier can bid on work that is otherwise closed to them.

We build and rent the software; operator-tenants run the physical deliveries under their
own brand. We are the technology infrastructure, not a delivery company.

**Medical is the first market, not the boundary.** Custody, POD, retention, audit logging
and export serve legal filings and high-value handoffs identically. Temperature is the
single medical-specific piece.

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

## 3. The buyer

**One buyer: a same-day courier firm running 3–20 drivers in cars and cargo vans.**

Previous versions of this document listed six segments. That was a market description
pretending to be a target, and it produced a roadmap that served none of them
particularly. The list is gone.

### 3.1 The buyer's buyer is the one that matters

A courier firm this size does not buy software because dispatch is hard. They buy it
because **their customer is a hospital, a lab, or a public-health agency**, and that
customer's procurement demands things the courier cannot produce alone:

| Demand | Who it is asked of |
|---|---|
| Chain of custody | The courier — but the software has to generate it |
| Proof of delivery | The courier |
| Temperature documentation | The courier |
| On-time reporting at 95–98% | The courier, with service credits attached below threshold |
| Signed BAA | The courier, which forces one on us as their subcontractor |
| **SOC 2** | **The software vendor — us, not them** |

That last row is the business. A three-driver courier will never produce a SOC 2 report.
We can, and it is what lets them answer a HECVAT.

### 3.2 Search intent

Acquisition intent, not product requirements — no code derives from these:
"HIPAA compliant courier software", "medical courier chain of custody software",
"courier software with BAA", "lab specimen delivery tracking software",
"on-time delivery report for courier contract".

## 4. Two vertical modules on one shared core

The platform is **one codebase**: a shared core + two domain modules sharing primitives
(auth, tenancy, DB, payment rails, maps, location pipeline).

**Corrected in v1.3.** This section used to say the modules have "distinct domain logic —
NOT one product with skinned views." That is no longer true of the ORDER LIFECYCLE: cutting
the shopping types left both surviving types on one path with no branch in the transition
table, and a freight run moves through exactly the states a courier job does. The verticals
now diverge in **capabilities and paperwork**, not in how a job moves — Rate Con OCR, IFTA,
factoring invoices and broker GPS links are gated per tier (§9), and none of them touch the
state machine. Worth stating plainly, because "distinct domain logic" would justify forking
the order model, and nothing now justifies that.

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

**Built vs. intended.** The tree above is the target shape, not the current one — today
there is a single `apps/marketing` serving marketing, auth, and the operator console, and
the vertical apps do not exist. Two entries deserve naming as decisions rather than facts:

| Concern | Status | Note |
|---|---|---|
| Neon Postgres + Drizzle | **Built** | Canonical schema in `packages/db/src/schema.ts` |
| Next.js App Router, TypeScript | **Built** | One app, three verticals' worth of routes still to split |
| Blob storage (Vercel Blob or equivalent) | **Not built** | Load-bearing **at the entry tier**: signature + photo POD is a $199 Direct Courier feature, not a freight extra. Nothing can ship POD until this exists. |
| Deployment (Vercel) | **Not built** | Nothing is deployed anywhere; `perrice.trucking.com` resolves to nothing, so the white-label promise is currently unserved |

## 6. Order model

**v1.3 cut the product to two order types.** `shop_in_store` and `errand` were removed —
code deleted, not parked, matching how the country picker was handled. Git history holds
the implementation if in-store shopping returns.

```
fixed_pickup:      PENDING ─▶ ASSIGNED ─▶ EN_ROUTE ─▶ DELIVERED
scheduled_courier: PENDING ─▶ ASSIGNED ─▶ EN_ROUTE ─▶ DELIVERED   (exact time window)
```

Both types now share ONE lifecycle, so the transition table has no branch. Cancellation
and failure apply from any non-terminal state and carry different reason sets (§10).

What went with the shopping types, deliberately: the `SHOPPING` and `CHECKOUT` states,
`hasShoppingPhase`, the `items_unavailable` failure reason, and **the entire
pre-authorise/capture payment model** — `authorized_cents`, `captured_cents` and
`captureTotal`. For a fixed pickup or a courier run the captured amount is always the
agreed price, so a second nullable amount was a column that could only ever disagree with
itself. No row in the database carried one when it was dropped.

## 7. Key subsystems

- **Real-time location tracking** — per-order channel, fan-out via managed realtime (Firebase/
  Supabase/Ably-class) or Redis pub/sub + WS. Client interpolates between sparse fixes. The
  showcase feature for the trust-sold courier product.
- **Offline-first driver app** — local storage (SQLite/WatermelonDB) as source of truth during
  a delivery; predictive bounding-box map-tile caching on dispatch; **event-sourced** offline
  queue with client-generated ids + sequence numbers; background sync on reconnect; optimistic
  UI that reconciles and surfaces sync failures.
- **Communication** — per-order channel carries canned messages + free-text chat; optional
  masked calling (Twilio Proxy), which is what E.164 storage exists for. CS can read an
  order's chat for disputes. (The structured substitution approve/reject card went with
  the shopping types in v1.3.)
- **Package scanning (v1.3)** — camera barcode/QR scan at two checkpoints: **pickup
  loading** and **final handoff**. Requires an entity that does not exist yet: an order
  today has no packages, so this needs a tenant-scoped parcel table. The design question
  that decides whether the feature is worth anything: **a package scanned at pickup and
  not at handoff must produce a state, not a log line.** Detecting the missing parcel is
  the entire value; scanning that cannot tell you something is missing is decoration.
- **Proof of delivery / chain-of-custody (v1.3)** — **full-resolution** photo capture,
  digital recipient signature, geotagged timestamping, and an automated **branded POD
  PDF**, plus a who-held-it-when trail for legal/medical/high-value. Four notes that are
  requirements rather than detail:
  - *Full-resolution is load-bearing.* Compression is the landmine in §10 — a POD photo
    is potential evidence, and a re-encoded one may not be.
  - *Geotagging is a single point captured AT the closing transition*, not a subscription.
    Location visibility is bound to order status and ends when the order does (§10); a POD
    geotag sits inside that window and must not be implemented as continued tracking.
  - *The branded PDF is the first real test of "100% platform anonymity."* It is the first
    artifact that leaves the platform and reaches the tenant's own customer. If it carries
    PorterDirect anywhere, anonymity is broken at the most visible possible point.
  - *Both capabilities presuppose the driver app*, which does not exist. Camera scanning
    and signature capture need a device, so neither is buildable before that surface.
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
- **Freight:** factoring integration, not card charges.

## 9. Pricing (tenant subscriptions) — canonical in `packages/billing/src/plans.ts`

| Tier | Price | Drivers included | Highlights |
|---|---|---|---|
| **Direct Courier** | $199/mo | 5, then $25/extra | CNAME, branded PWA tracking, offline maps, POD |
| **Fleet & Freight** | $499/mo | 15, then $25/extra | + Rate Con OCR, factoring invoices, IFTA, broker GPS |
| **White-Label Agency** | $999/mo + $1,500 setup | 50, then $25/extra | + sub-accounts, native app deploy, API/webhooks |

**"100% platform anonymity" is withdrawn from the Agency tier pending resolution.** It
conflicts directly with the BAA obligation the medical positioning creates: a covered
entity must know who its business associates are, and a subcontractor processing PHI
cannot be concealed from them. Selling total invisibility to an operator whose customer
is a hospital promises something HIPAA does not permit. The `platform_anonymity`
capability stays in the catalogue — it correctly gates the sender-domain work in
`sendDeliveryReceipt` — but it must not be marketed as anonymity *from the buyer*. What
it actually means is: our brand does not appear to the operator's customers. That is a
branding guarantee, not a disclosure one.

**"Included", never "limit".** The driver count is a billing threshold, not a wall: the
sixth driver on Direct Courier is added and charged $25, not refused. Nothing in the code
enforces a cap, and that is the intended product — `billableExtraSeats` bills the excess.
The distinction matters commercially: a limit makes growth a sales conversation and a
support ticket, while a threshold makes it revenue. If a hard cap is ever wanted it needs
a separate field and an enforcement point, because today there is neither.

**Capabilities are separate from these bullets.** What a tier lets a tenant *do* is
declared as `capabilities` on each plan in the catalogue and read by `planAllows` /
`tenantAllows`; the text above is display copy. They are deliberately different fields —
a marketing bullet gets reworded, and a permission keyed to that sentence would silently
move with it. `tenantAllows` requires BOTH that the plan carries the capability and that
the subscription is entitled, so a lapsed Agency tenant does not keep working API access.

Add-ons: native app-store deployment ($499 one-time), SMS/WhatsApp (metered pass-through +20%),
extra seats ($25/mo). Each tier Price is a graduated per-seat Stripe Price; subscription
quantity = total active seats.

Licensing variants under consideration: monthly SaaS rent, per-dispatch royalty ($1.50–$3),
one-time source-code license ($5k–$25k+).

### 9.1 The competitive ladder (researched 2026-09-10)

These are the prices the buyer is actually comparing us against. This table is
**observed**, not assumed, and it is what killed white-label as a headline.

| Vendor | Entry price | Model | Compliance posture |
|---|---|---|---|
| Shipday | $0 → $349/mo | tiered | SOC 2 |
| Detrack | $29/driver/mo | per driver | none established |
| Tookan | ~$99/mo | tiered | none established |
| Routific | $49/mo, to $93/driver | per driver | none established |
| **Onfleet** | **$619/mo** + $299 Courier Suite | **per task** (2,500) | BAA with covered entities |
| DispatchTrack | enterprise, unpublished | enterprise | SOC 2 + HIPAA (2024) |
| CXT Software / Key Software | enterprise, unpublished | enterprise | courier incumbents, medical-heavy |

**Two conclusions follow.**

**White-label is table stakes.** Onro, InstaDispatch, LiveCourier, Metafour, Softpal and
CourierManager all ship branded, no-login tracking and self-service booking; CXT includes
white labelling in every plan; Onro does custom domains at $239. "Run your operation under
your own brand" cannot justify $349 against OnTime 360 at $49.

**The gap is price × compliance.** The cheap tier cannot credibly serve medical. The
compliant tier starts at $619 and prices **per task**, which punishes exactly the
high-volume lab courier we target. Compliance-grade software at a per-driver price is the
opening.

### 9.2 The moat, stated honestly

SOC 2 is **weaker than it looks**. Shipday and DispatchTrack already hold one, and
DispatchTrack claims HIPAA as well. So our advantage is a gap in **pricing, not
capability**: it holds against the courier, who can never produce one, and it does not
hold against DispatchTrack deciding to price down.

**The durable wedge is access logging.** No incumbent advertises it, it is precisely what
a HECVAT question asks, and unlike a compliance badge it is specific and checkable. It is
also, today, one of the things we do not have (§11.1) — which makes it the thing to build
and then the thing to sell.

## 10. Domain landmines (silent failures) — see CLAUDE.md for the enforced list

Tenant data bleed · wrong Stripe account returns 200 · webhook double-apply · money-as-float ·
entitlement drift · off-shift / post-delivery location tracking (legal liability) · optimistic/
offline updates that never reconcile · over-compressed POD photos destroying evidence · blind
trust of OCR extraction.

## 11. Current build status

Kept honest deliberately: this section was months stale (it claimed 27 tests, no auth and
no Next.js app) while the ledger in `CLAUDE.md` was current. A status section nobody
trusts is worse than none, because it gets quoted.

**One operator can sign up, pay, and run real dispatch work end to end.** Signup → tenant
provisioned → Stripe Checkout → webhook → operator console → invite a team → raise a job →
move it through the lifecycle → close it with a reason → re-dispatch a failure.

Built and verified against live services (not just unit-tested):

- **Billing** — canonical catalogue, 6 Stripe Prices created, webhook verification and
  **atomic** idempotency proven under two concurrent listeners, one real subscription
  reconciled end to end. Tax behaviour settled as exclusive + Stripe Tax.
- **Identity & tenancy** — Better Auth on our own schema (no vendor `organization` table),
  explicit role matrix, tenant checked before role, isolation verified under concurrent
  load against forged, malformed and foreign tenant ids.
- **Orders** — explicit transition table, terminal-is-terminal, per-tenant references,
  tenant scoping inside the WHERE clause.
- **Closure** — cancelled and failed carry different reason sets; re-dispatch raises a new
  linked job rather than reopening a closed one.
- **Contact data** — E.164 phones, structured addresses (`region`/`postal_code`).
- **Enforcement** — lint, conventions guard, CI, and a test suite whose guards have each
  been verified to fail on a planted defect.

**Blocking a first paying customer, in order:**

1. **No email provider.** Invites and password resets cannot be delivered, so a tenant
   cannot onboard their second person. This is the hard blocker.
2. **Nothing is deployed.** The white-label domain — the thing being sold — is unserved.
3. **No blob storage.** Now blocks three things, not one: the full-res POD photo, the
   signature, and the generated PDF. POD is an entry-tier feature (§5), so this is the
   top infrastructure gap.
4. **No driver app**, which both v1.3 capabilities — scanning and POD — sit behind.
5. **Stripe Tax is off** and the app hard-refuses a live key while it is; needs a head
   office address and registrations.
6. **No git remote**, so CI is inert.

### 11.1 The compliance audit — what is NOT built

A repo audit against the procurement list above was run on 2026-09-10. It contradicted
this document in one place and found four requirements with no foundation at all.

| Requirement | Status | The actual gap |
|---|---|---|
| Proof of delivery | **BUILT** | Capture verified on a real phone. |
| Chain of custody | **PARTIAL** | See below. |
| **Retention** | **BUILT 2026-09-10** | Was worse than absent: deleting an order orphaned the POD photo and signature with no key left to find them — PHI we could neither account for nor destroy on request. Now `storage_objects`, a ledger of bucket contents that survives any cascade, with a six-year date stored per object and a sweep that destroys on time and records that it did. Costed before it was promised: ~$10/mo per Direct Courier tenant at year six, ~$102 at Agency scale. |
| **Access logging** | **BUILT 2026-09-10** | Every read of stored evidence and every tracking-link open now writes an audit row: who, which order, when, from where. Enforced structurally — the unaudited primitive is named as such and `verify:conventions` fails on any caller outside a four-entry allowlist. Fails closed: no audit row, no URL. **This is the wedge** (§9.2). |
| Temperature capture | **NOT BUILT** | Zero occurrences repo-wide. `order_proofs` is the nearest shape but its unique-per-order index cannot hold a pickup *and* a handoff reading. |
| On-time reporting | **NOT BUILT** | `scheduledFor` and `deliveredAt` both exist and are **never compared**. No aggregate query anywhere. "On time" is not definable without a tolerance the schema lacks. |

**Correction to a claim this document previously made.** §11 listed "append-only audit
trail" under what is built. **It is not true at the database level.** `order_events` is
append-only *by convention* — a comment in the schema, with zero triggers, revoked grants
or row-level security across all 18 migrations, and the table is cascade-deletable from
both `orders` and `tenants`. It also records status transitions only: an edited address,
a changed price or a reassigned driver leaves no trace at all.

This is the exact failure class §10 catalogues — it passes every test, returns 200, and
then a procurement reviewer asks us to prove it.

**Sold but not built:** Rate Con OCR, factoring invoices, IFTA, broker GPS links,
sub-accounts, native app deployment, API/webhook access, platform anonymity. All are now
declared as `capabilities` and gate correctly — the gate returns the right answer for a
feature that does not exist yet, which is the right order to build it in.

**Known product gaps inside what IS built:** there is no tenant settings UI, so existing
tenants cannot change their country. (The variable-total gap closed itself in v1.3 — the
types that had it were cut.)

## 12. What is established, and what is still a hypothesis

### Established by research (2026-09-10)

- **Competitor pricing and models** — §9.1. Observed from vendor pricing pages.
- **White-label is table stakes**, shipped by at least six vendors, several cheaper.
- **SOC 2 is held by competitors already** (Shipday, DispatchTrack, Dispatch), so it is a
  qualifier rather than a differentiator between vendors.
- **Stripe will not sign a BAA** and does not consider itself a business associate. PHI in
  *any* Stripe field — metadata, invoices, receipts, webhooks — breaks the
  payment-processing exemption. This is a hard architectural constraint, not a preference.
- **HIPAA custody logs must be retained six years and be tamper-proof.**
- **On-time benchmarks are 95% baseline, 98% for leaders**, and contracts attach service
  credits (typically 5% monthly credit at 95–97%, 10% below 95%, termination right after
  two consecutive months below threshold). SLA practice requires the contract to define
  what counts as a delay and how weekends and holidays are treated.
- **US same-day delivery is ~$10.4–13.9bn and genuinely fragmented** — regional operators
  ~31% and local providers ~22% of activity against ~46% for the top ten. The long tail we
  target is real.

### Still hypotheses — treat as unvalidated

- **Nobody has been asked to buy this.** No operator conversations, no pre-commitments.
  Everything above is desk-verified and repo-verified: it establishes that we *can* build
  the thing, not that anyone will pay for it. **This is the largest open risk in the
  document** and no amount of further desk research closes it.
- Whether a 3–20 driver courier will pay $199–$999 for compliance they currently do
  without — or whether they simply decline the hospital work.
- Whether "we hold the SOC 2 so you can answer the HECVAT" is a sentence that lands in a
  sales conversation, or one that only makes sense to someone who already knows what a
  HECVAT is.
- Whether temperature documentation is a real buying trigger or a checkbox that never gets
  audited in practice.
- Utilization risk (carried forward): the market may be fragmented *because* the unit
  economics are hard, which would make dispatch efficiency higher-leverage than evidence.

## 13. Build order

Settled 2026-09-10. The sequence is a dependency chain, not a priority list.

1. **Email actually sending** — verify Resend delivers, not merely that credentials
   exist; the code path previously threw in production. Then deployment and git remote.
2. **The evidence spine**, in this order:
   1. ~~Correct the false append-only claim~~ — **done, §11.1.**
   2. ~~Retention~~ — **done.** Objects are now enumerable independently of the rows they
      came from, which is exactly what access logging needs. Note the deliberate deviation
      from the original wording: there is **no object-storage lifecycle rule**, because a
      bucket-level expiry deletes without recording that it did — which leaves the same
      "cannot account for it" problem pointing the other way.
   3. ~~Access logging~~ — **done.** Who read a POD, who opened a tracking link, when.
   4. **Enforce append-only in the database** — trigger plus revoked UPDATE/DELETE.
   5. Stop the tenant/order cascade destroying custody records.
   6. Extend custody to **field edits**, not just status transitions.
   7. **Export pack.** Not a late deliverable: a custody trail is invisible until a client
      asks for it, so the export is the artifact that makes the value legible. A courier
      can show an on-time report to a prospect *before* they hold a contract.
3. **Native driver app** — scanning, offline queue, push. Needs a parcel entity, which
   does not exist. Note that POD capture already works on a phone through the web driver
   surface, so POD is *not* blocked behind this.
4. **Temperature** at pickup and handoff, own table, excursion as a first-class state.
   **One canonical definition of "late"**, verified against a weekend/holiday fixture.
5. **Resume the booking portal** — rate card, fuel surcharge, customer self-booking, all
   committed and green but paused here. Then decide the Mapbox question below.
6. **Paperwork, in parallel, not code** — BAAs with Neon, Vercel and AWS; a test asserting
   no PHI can reach Stripe; SOC 2 *readiness* now, the audit once there are tenants.

### Known inconsistency, deliberately not fixed here

`apps/marketing/app/layout.tsx` still reads *"PorterDirect — white-label logistics
platform … zero per-delivery commission"*, and that is the OpenGraph title every shared
link previews. It contradicts §1 as of this revision. It is left alone on purpose: it is
live copy on a real domain, and rewriting the marketing surface is its own pass with its
own review, not a trailing edit on a document change. **Whoever does the marketing rewrite
should start from §1 and §9.2, not from the current page.**

### Open decisions

- **Mapbox and PHI.** The distance adapter sends full pickup and drop-off addresses to a
  third party; for a medical tenant that is a patient address. It is currently **wired to
  nothing and has never sent an address**, so the decision is deferred rather than urgent.
  Three options: obtain a BAA, disable auto-quoting for medical tenants (the quote path
  already degrades cleanly to "an operator prices it"), or geocode in-house.
- Whether a hard driver cap is ever wanted (§9) — today there is no field and no
  enforcement point.
- Freight (Rate Con OCR, IFTA, factoring, broker GPS) stays **declared and unbuilt**. The
  capabilities gate correctly; removing them would break entitlement and the $499 Price.
  There is no freight implementation code to remove — verified.
