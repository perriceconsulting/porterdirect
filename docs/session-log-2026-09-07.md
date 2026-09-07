# Session log — 2026-09-07 (PorterDirect founding session)

A faithful chronological record of everything done in the session that created this
project, including decisions, the reasoning behind them, honest flags raised, and what
shipped. Companion to the distilled spec in [../CLAUDE.prd.md](../CLAUDE.prd.md) and the
engineering standard in [../CLAUDE.md](../CLAUDE.md).

---

## 0. Pre-history (unrelated, deleted)

The session began in a folder (`pythonWebVideoTest`) containing an OpenCV IP-camera
viewer script. That task was fixed (native venv, `import cv2`, stream URL diagnosis) and
then, at the user's request, **deleted entirely** — it has no relationship to PorterDirect.
The folder name is the only residue, which is why the project was later moved to a properly
named folder.

## 1. From "delivery tracking" to a product

Opening question: how do DoorDash/Instacart/Spark track a delivery driver, and how do we
build it. Established the core pipeline (driver GPS → backend relay → customer map, with
client-side interpolation) and the decisive early call:

- **Driver app must be native** (React Native + background-geolocation). A web PWA cannot
  get background GPS while the phone is locked/backgrounded — this drives everything.
- Location is scoped to an **order**, never queried as "where is driver X" — this is what
  makes privacy enforceable.

## 2. Scope grew, one dimension at a time

Each of these was added by the user and folded into the design:

1. **Back-office dashboard** — CS/ops need a fleet-wide live map. Introduced the driver
   **shift** concept (a superset of "has an active order"), role-gated access, an **audit
   log** of who viewed whom, and the hard rule: **tracking stops when off-shift** (a legal
   obligation, not a nicety).
2. **In-app communication** — canned messages + free-text chat + optional masked calling,
   riding the same per-order channel. Decided: design for it, defer the build.
3. **In-store shopping (Instacart-style)** — a whole shopping phase before delivery:
   line-item state, a **structured substitution approve/reject** flow, a product catalog
   dependency, and **variable-total payments** (pre-auth + buffer → capture actual). The
   order model became **polymorphic** (fixed-pickup vs shop-in-store vs errand).
4. **Payments** — three money flows (customer in, platform fee, driver payout).
   Recommended **Stripe Connect** (Express) for contractor payouts — confirmed as the model
   DoorDash/Instacart/Spark actually use (1099 contractors, weekly ACH + instant-pay +
   branded cards via Payfare/Branch/Stripe). Pre-auth/capture for shopping; `captured ≤
   authorized` as a hard invariant.

## 3. Positioning pivots (from market research)

The user supplied preliminary market research (flagged as promotional/AI-generated; see
PRD §12 for the honest caveats). Net effect on the design:

- **PorterDirect = premium, trust-first white-glove courier.** Reprioritized effort toward
  reliability (a frozen tracker breaks the promise), UX polish, trust-signaling UI, and —
  the sleeper insight — **dispatch/scheduling efficiency**, because premium flat-rate +
  dedicated vetted drivers has a brutal utilization problem. The moat is operational/brand,
  not technical; software's job is to signal and enforce trust.
- Honest flags raised and recorded: unsourced market-size numbers; the shaky "high earners
  avoid gig apps" premise (sharper thesis: specific high-stakes jobs); Reddit/TikTok as
  signal not validation; pre-commitments as the real validation metric.

## 4. The big pivot — sell the software, not the operations

The user reframed PorterDirect as a **white-label logistics SaaS/rental platform**. This
*resolved* the biggest risk previously flagged (running three operating businesses at once):
now it is one software business serving multiple operator types.

- Added a **second vertical**: small-fleet **freight** (`fleet.` subdomain) — load boards,
  **Rate Con OCR**, **IFTA**, **factoring**. Distinct regulated domain; shares the core but
  not the domain logic. Flagged clearly: "identical tech, dynamic views" understates it —
  these are two product modules on a shared core, not one skinned app.
- **Architecture:** subdomains under one apex, white-label tenant CNAMEs, **multi-tenant
  from day one**. Tenant isolation became the platform's life-or-death property and a
  mandatory PHAST pillar.
- User decisions captured: first product = "shared core + both thin"; white-label = **core
  from day one**. Recommendation logged: let one vertical (courier) lead by a few weeks.

## 5. Cross-cutting: offline-first

Reviewed a detailed offline-first proposal. Validated the sound parts (predictive tile
caching, event-sourced queue, background sync) and corrected the rest: it must use the
**native** path (not PWA/IndexedDB, which contradicts the driver-app decision); the hard
part is **reconciliation/idempotency/clock-skew**, not queuing; optimistic UI must reconcile
and surface failures; **POD photos must stay high-res** (evidence, given the chain-of-custody
positioning), not crushed to <100KB; cached tenant PII must be **encrypted and purged**
after delivery.

## 6. Build kickoff — DOSI from the gate + licensee billing

Directive: implement DOSI from the first commit; first capability = **monthly Stripe
subscriptions from licensees**. Built and verified:

- **npm-workspaces monorepo** (chose npm over pnpm+turbo — no tooling we couldn't justify).
- `@porterdirect/db` — Drizzle schema (`tenants`, `subscriptions`, `processed_webhook_events`),
  tenant-scoped from the first table.
- `@porterdirect/billing` — **canonical plan catalog** (Single Source), pure entitlement/
  seat/money logic (integer cents), Stripe **test-mode guard**, and verify + **idempotent**
  webhook dispatch.
- Project [CLAUDE.md](../CLAUDE.md) written to instantiate the DOSI standard: Single-Source
  table, silent-failure landmines, PHAST pillars (tenant isolation + data-integrity
  mandatory), and a ledger.
- **27 unit tests green, `tsc -b` clean.**

Then the user noted the global standard's Stripe dev-setup procedure. Instantiated it:
[stripe-dev-setup.md](stripe-dev-setup.md) + `scripts/stripe-doctor.sh` (whole-set check +
whoami account assertion, never prints a secret) + `scripts/guard-stripe-env.sh`. This also
surfaced and fixed a **DOSI-S consistency bug**: two seat-pricing models were in conflict;
standardized on the graduated per-seat Stripe Price that the code already assumed.

## 7. Rename & move

Renamed the package to `porterdirect`. The folder rename was blocked (Windows locks the
active workspace dir), so the project was **copied** into `C:\Users\percy\PorterDirect` and
verified there (clean install, 27 tests green). Captured the conversation as
[CLAUDE.prd.md](../CLAUDE.prd.md) and this log so the context survives into a fresh session.

## Honest status at session end

- Built & tested: the licensee-subscription billing core + DOSI scaffold + Stripe dev-setup
  tooling. **No commits yet** (commit only on request).
- Not built: live Stripe calls (need test keys), DB-backed webhook store/sink (ports only),
  Next.js apps, auth, driver app, either vertical's domain logic, lint config.
- Everything above the "current build status" line in the PRD is **design, not code**.
