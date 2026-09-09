/**
 * Canonical database schema (Single Source for persisted shapes).
 *
 * Multi-tenancy is foundational, not retrofitted: every tenant-owned row carries
 * `tenant_id`. Tenant-isolation is the platform's life-or-death property (CLAUDE.md),
 * so the column exists from the first table and every query must scope by it.
 *
 * Stripe is the source of truth for billing STATUS; the `subscriptions` table is a
 * local mirror reconciled from Stripe webhooks (DOSI-S: a copy that reconciles back).
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { ORDER_STATUSES, ORDER_TYPES } from "@porterdirect/orders";

/** A licensee: the operator who rents the platform (courier firm, dispatcher, agency). */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Human-facing name and the subdomain/CNAME host that routes to this tenant.
    name: text("name").notNull(),
    primaryHost: text("primary_host"), // e.g. dispatch.theircompany.com (white-label CNAME)
    stripeCustomerId: text("stripe_customer_id"), // mirror of the Stripe Customer for this tenant
    /**
     * ISO 3166-1 alpha-2. Decides how phone numbers are parsed and displayed for this
     * operator. Taken from the TENANT rather than the browser: a dispatcher travelling,
     * or a VPN, would otherwise silently change how their customers' numbers are read.
     */
    defaultCountry: text("default_country").notNull().default("US"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hostIdx: uniqueIndex("tenants_primary_host_idx").on(t.primaryHost),
    stripeCustomerIdx: uniqueIndex("tenants_stripe_customer_idx").on(t.stripeCustomerId),
  }),
);

/**
 * The tenant's subscription to a PorterDirect plan. Local mirror of the Stripe
 * Subscription — reconciled by billing webhooks. `planId` references the canonical
 * catalog in packages/billing/src/plans.ts (not a DB table: the catalog is code).
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    planId: text("plan_id").notNull(), // catalog id, e.g. "direct_courier"
    status: text("status").notNull(), // normalized SubscriptionStatus (see billing/types.ts)
    seatCount: integer("seat_count").notNull().default(0), // active drivers/power units
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: integer("cancel_at_period_end").notNull().default(0), // 0/1 boolean
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("subscriptions_tenant_idx").on(t.tenantId),
    stripeSubIdx: uniqueIndex("subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
  }),
);

/**
 * Idempotency ledger for Stripe webhooks. A Stripe event may be delivered more than
 * once; recording processed event ids makes handling exactly-once (CLAUDE.md: a retry
 * without idempotency double-applies). Not tenant-scoped — event ids are global.
 */
export const processedWebhookEvents = pgTable("processed_webhook_events", {
  eventId: text("event_id").primaryKey(), // Stripe event id (evt_...)
  eventType: text("event_type").notNull(),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type ProcessedWebhookEvent = typeof processedWebhookEvents.$inferSelect;

/* ===========================================================================
 * Identity (Better Auth) and tenant membership.
 *
 * Better Auth owns IDENTITY only — who someone is, and whether this session is
 * really them. It does NOT own tenancy. Its organization plugin would introduce an
 * `organization` table, which would be a second tenant concept sitting beside the
 * canonical `tenants` above; we model membership ourselves instead so there is
 * exactly one answer to "what is a tenant" (DOSI-S).
 *
 * These four tables mirror Better Auth's expected schema. Column names match its
 * model so the Drizzle adapter binds without a mapping layer.
 * =========================================================================== */

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  /**
   * Display name, kept because Better Auth requires it. It is DERIVED from the two
   * fields below rather than being a separate source of truth.
   */
  name: text("name").notNull(),
  /**
   * Structured name. A single free-text "name" cannot distinguish two people called
   * John at the same operator, cannot be sorted by surname, and cannot address someone
   * correctly in a notification. Both are captured at signup so neither has to be
   * guessed at by splitting a string later.
   */
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("user_email_idx").on(t.email),
}));

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex("session_token_idx").on(t.token),
  userIdx: index("session_user_idx").on(t.userId),
}));

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  /** Hashed by Better Auth. Never a plaintext password, never logged. */
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("account_user_idx").on(t.userId),
  providerIdx: uniqueIndex("account_provider_idx").on(t.providerId, t.accountId),
}));

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  identifierIdx: index("verification_identifier_idx").on(t.identifier),
}));

/**
 * Tenant roles. A database ENUM rather than free text: this is the column an
 * authorization check reads, so a typo ("dispatchr") must fail on write rather than
 * silently denying — or worse, silently matching nothing in a permissive branch.
 */
export const tenantRole = pgEnum("tenant_role", ["owner", "ops", "dispatcher", "driver"]);

/**
 * Which users belong to which tenant, and as what.
 *
 * A user may belong to several tenants — an agency operator running two brands, a
 * contractor driving for two firms — so identity is global and membership is scoped.
 * This join is what every tenant-scoped authorization check resolves through, which
 * is why it is a real foreign key on both sides rather than a synced mirror.
 */
export const tenantMembers = pgTable("tenant_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: tenantRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One membership row per (tenant, user). Two rows would mean two roles for the same
  // person in the same tenant, and no deterministic answer to "what may they do".
  uniqueMembership: uniqueIndex("tenant_members_tenant_user_idx").on(t.tenantId, t.userId),
  tenantIdx: index("tenant_members_tenant_idx").on(t.tenantId),
  userIdx: index("tenant_members_user_idx").on(t.userId),
}));

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;
export type TenantRole = (typeof tenantRole.enumValues)[number];

/* ===========================================================================
 * Orders — the job itself.
 * =========================================================================== */

/**
 * Enum values DERIVE from the domain vocabulary rather than restating it.
 *
 * The dependency points db -> orders on purpose: `packages/orders` is pure and owns the
 * lifecycle, and persistence mirrors it. Restating the values here is how the database
 * accepts a status the state machine has never heard of — or, as happened when the
 * shopping types were cut, how one of five copies gets missed.
 *
 * drizzle's `pgEnum` wants a non-empty tuple and our lists are `readonly T[]`, so the
 * shape is asserted here. It is checked where it matters: the migration generator
 * compares these values against the live database, so a mismatch surfaces as a migration
 * rather than as a runtime insert failure.
 */
const asEnumValues = <T extends string>(values: readonly T[]): [T, ...T[]] =>
  values as unknown as [T, ...T[]];

export const orderType = pgEnum("order_type", asEnumValues(ORDER_TYPES));

export const orderStatus = pgEnum("order_status", asEnumValues(ORDER_STATUSES));

/**
 * A job. Tenant-scoped like everything owned, and enum-typed on both `type` and
 * `status` so an impossible value fails on write rather than reaching the state
 * machine as a string nothing matches.
 *
 * MONEY IS INTEGER CENTS throughout. There is ONE amount: `price_cents`, the agreed
 * price. The `authorized_cents` / `captured_cents` pair was removed in v1.3 along with
 * the shopping order types it existed for — for a fixed pickup or a scheduled courier
 * run the captured amount is always the agreed price, so a second nullable amount was a
 * column that could only ever disagree with itself.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Short human reference an operator can read down a phone. Unique per tenant. */
    reference: text("reference").notNull(),

    type: orderType("type").notNull(),
    status: orderStatus("status").notNull().default("pending"),

    /**
     * Structured, for the same reason the user table is: a single free-text name
     * cannot tell two customers called John Smith apart, cannot be sorted by surname,
     * and cannot address someone correctly in a notification.
     *
     * Unlike `users`, there is NO derived `customer_name` column here. That one exists
     * only because Better Auth requires it; without an external constraint, storing a
     * display name alongside its own two parts would be a second source of truth for
     * the same fact. The display form is composed at the point of use.
     *
     * Deliberately NOT unique. Two different customers genuinely can share a name, and
     * a uniqueness constraint would refuse the second one a delivery. What identifies a
     * customer is their phone — which is also what masked calling keys off.
     */
    /**
     * Structured, for the same reason the user table is: a single free-text name cannot
     * tell two customers called John Smith apart, cannot be sorted by surname, and
     * cannot address someone correctly in a notification.
     *
     * Unlike `users`, there is deliberately NO derived `customer_name` column. That one
     * exists only because Better Auth requires it; with no external constraint, storing
     * a display name beside its own two parts would be a second source of truth for the
     * same fact. The display form is composed at the point of use.
     *
     * Deliberately NOT unique. Two customers genuinely can share a name, and a
     * uniqueness constraint would refuse the second one a delivery. What identifies a
     * customer is their phone — which is also what masked calling keys off.
     */
    customerFirstName: text("customer_first_name").notNull(),
    customerLastName: text("customer_last_name").notNull(),
    customerPhone: text("customer_phone"),


    /**
     * Addresses in PARTS, not one free-text line.
     *
     * A dispatch platform has to answer "which jobs are in this postcode", print a
     * label, hand coordinates to a router and check a serviceable area. None of that is
     * possible by splitting a free-text line after the fact, and every attempt to do so
     * fails on the addresses that matter — the unusual ones.
     *
     * Named generically (`region`, `postal_code`) rather than `state` and `zip`: a
     * column called `state` forces every non-US operator to put something that is not a
     * state into it, and that vocabulary then spreads into queries and exports.
     *
     * Country is stored PER ADDRESS rather than taken from the tenant, because freight
     * runs cross borders and a pickup may not be in the operator's own country.
     */
    pickupLine1: text("pickup_line1").notNull(),
    pickupLine2: text("pickup_line2"),
    pickupCity: text("pickup_city").notNull(),
    pickupRegion: text("pickup_region"),
    pickupPostalCode: text("pickup_postal_code"),
    pickupCountry: text("pickup_country").notNull(),

    dropoffLine1: text("dropoff_line1").notNull(),
    dropoffLine2: text("dropoff_line2"),
    dropoffCity: text("dropoff_city").notNull(),
    dropoffRegion: text("dropoff_region"),
    dropoffPostalCode: text("dropoff_postal_code"),
    dropoffCountry: text("dropoff_country").notNull(),

    notes: text("notes"),

    /**
     * Where the delivery receipt goes. OPTIONAL: plenty of courier work is booked by
     * phone and the sender never gives one, and refusing the job over a missing address
     * would be the software telling the operator how to run their business.
     *
     * Not normalised the way a phone is. An address either routes or it does not, and
     * lower-casing or stripping a `+tag` is exactly how you break the one that would
     * have worked.
     */
    customerEmail: text("customer_email"),

    /**
     * The customer's tracking link.
     *
     * Crypto-random and unguessable, and — unlike an invitation token — stored in the
     * CLEAR on purpose. An invite is hashed because a database dump of raw invite tokens
     * is a set of working keys to join tenants. This grants read of ONE order that the
     * same dump already contains, so hashing would buy nothing and would cost the thing
     * that matters: an operator re-sending a customer their link. A token you cannot read
     * is a token you can only ever email once.
     *
     * NOT derived from the order id or the reference. A reference is read down a phone and
     * ends up in inboxes and spreadsheets; deriving the link from it would make every
     * delivery guessable from a scrap of paper.
     */
    publicToken: text("public_token"),

    /** Agreed with the customer, in cents. The only amount a job carries. */
    priceCents: integer("price_cents").notNull().default(0),

    /** The driver holding it. Null until assigned; a member of THIS tenant. */
    assignedUserId: text("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * Why a job ended without delivery. Set only for `cancelled` and `failed`.
     *
     * Stored as text validated against a closed set in the domain layer rather than a
     * database enum: the reason list will change as operators tell us what actually goes
     * wrong, and a migration per new reason would discourage adding them — which would
     * quietly push people back to free text.
     */
    closureReason: text("closure_reason"),
    /** Free text ALONGSIDE the reason, never instead of it. */
    closureNote: text("closure_note"),

    /**
     * The failed job this one re-attempts.
     *
     * A second attempt is a NEW order, not a reopened one: terminal has to stay terminal
     * or the first attempt's history is rewritten and its failure disappears from the
     * numbers. The link preserves both.
     */
    redispatchedFromOrderId: uuid("redispatched_from_order_id"),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique PER TENANT, not globally: two operators may both have an "ORD-1042", and a
    // global unique index would leak the platform's total order count through collisions.
    tenantReferenceIdx: uniqueIndex("orders_tenant_reference_idx").on(t.tenantId, t.reference),
    // The dispatch board's query: this tenant's orders, newest first.
    tenantStatusIdx: index("orders_tenant_status_idx").on(t.tenantId, t.status),
    assignedIdx: index("orders_assigned_idx").on(t.assignedUserId),
    // The query a dispatcher actually runs: this tenant's jobs going to a given area.
    dropoffAreaIdx: index("orders_dropoff_area_idx").on(t.tenantId, t.dropoffPostalCode),
    // "What is going wrong, and how often" — the query the reason field exists for.
    closureIdx: index("orders_closure_idx").on(t.tenantId, t.closureReason),
    /**
     * UNIQUE, not a plain index. A job may be re-dispatched at most once, and that rule
     * was previously enforced by SELECT-then-INSERT — the same check-then-act race the
     * webhook ledger already had, where two concurrent requests both pass the check and
     * both act. Here that means two drivers dispatched to one delivery.
     *
     * Postgres treats NULLs as distinct, so the many not-re-dispatched orders do not
     * collide with each other; only a second re-dispatch OF THE SAME order does.
     */
    // Unique so two orders can never share a link, and indexed because every tracking
    // page load is a lookup by exactly this column.
    publicTokenIdx: uniqueIndex("orders_public_token_idx").on(t.publicToken),
    redispatchIdx: uniqueIndex("orders_redispatch_idx").on(t.redispatchedFromOrderId),
  }),
);

/**
 * Every state change, with who made it.
 *
 * This is the chain-of-custody trail the premium tier is sold on: not "the order is
 * delivered" but "who moved it, when, and from what". Append-only by convention — there
 * is deliberately no update path, because an editable audit log is not an audit log.
 */
/**
 * Proof of delivery — the evidence the premium tier is sold on.
 *
 * A separate table rather than more nullable columns on `orders`, because POD is a
 * DIFFERENT KIND of record: it is evidence, captured once, by a named person, at a place
 * and time. Orders get edited; evidence should not, and keeping it apart makes an
 * append-only guarantee possible later without freezing the order row too.
 *
 * The image bytes live in object storage; these are KEYS, not URLs. Storing a URL would
 * bake in the bucket host and the signing scheme, so a bucket move or a switch to signed
 * access would rewrite every historical row. A key is stable; the URL is derived at read
 * time and is short-lived by design, because a permanent public link to a delivery photo
 * is the leak.
 *
 * Location is a SINGLE POINT captured at the moment of handover, not a tracking feed.
 * That distinction is the legal one (CLAUDE.md: location visibility is bound to order
 * status and ends when the order does) and it is why these are plain columns here rather
 * than a rows-over-time table.
 */
export const orderProofs = pgTable(
  "order_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Who took delivery, as given at the door. Free text on purpose — it is testimony. */
    recipientName: text("recipient_name"),
    /** Object-storage keys. Null when that piece was not captured. */
    photoKey: text("photo_key"),
    signatureKey: text("signature_key"),
    /** Where the handover happened. Null when the device refused or lacked permission. */
    capturedLat: text("captured_lat"),
    capturedLng: text("captured_lng"),
    /** Metres of uncertainty reported by the device; a fix with no accuracy is not evidence. */
    capturedAccuracyM: integer("captured_accuracy_m"),
    capturedByUserId: text("captured_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One proof per order. A second would raise "which one is the evidence?" at exactly
    // the moment somebody is disputing a delivery.
    orderIdx: uniqueIndex("order_proofs_order_idx").on(t.orderId),
    tenantIdx: index("order_proofs_tenant_idx").on(t.tenantId),
  }),
);

export type OrderProof = typeof orderProofs.$inferSelect;
export type NewOrderProof = typeof orderProofs.$inferInsert;

export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Null when the actor is the system rather than a person. */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    fromStatus: orderStatus("from_status"),
    toStatus: orderStatus("to_status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index("order_events_order_idx").on(t.orderId, t.createdAt),
    tenantIdx: index("order_events_tenant_idx").on(t.tenantId),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;

/**
 * Pending invitations into a tenant.
 *
 * THE TOKEN IS STORED AS A HASH, never in the clear. An invite token is a bearer
 * credential — whoever holds it joins the tenant — so a database dump containing raw
 * tokens is a set of working keys to every outstanding invitation. Hashing means a leak
 * of this table grants nothing, exactly as with passwords.
 *
 * Single-use and time-bound: `acceptedAt` closes it, `expiresAt` ages it out. An invite
 * that stays valid forever is a standing key sitting in someone's inbox.
 */
export const tenantInvitations = pgTable(
  "tenant_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Bound to an address: accepting requires signing in as the person invited. */
    email: text("email").notNull(),
    role: tenantRole("role").notNull(),
    /** SHA-256 of the token. The token itself exists only in the emailed link. */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Looked up by hash on accept — the only index that path needs.
    tokenIdx: uniqueIndex("tenant_invitations_token_idx").on(t.tokenHash),
    tenantIdx: index("tenant_invitations_tenant_idx").on(t.tenantId),
    // One OPEN invite per (tenant, email) is enforced in the domain layer rather than
    // here, because a unique index would also block re-inviting after a decline.
    emailIdx: index("tenant_invitations_email_idx").on(t.tenantId, t.email),
  }),
);

export type TenantInvitation = typeof tenantInvitations.$inferSelect;
export type NewTenantInvitation = typeof tenantInvitations.$inferInsert;
