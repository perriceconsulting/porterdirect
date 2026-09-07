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

/** A licensee: the operator who rents the platform (courier firm, dispatcher, agency). */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Human-facing name and the subdomain/CNAME host that routes to this tenant.
    name: text("name").notNull(),
    primaryHost: text("primary_host"), // e.g. dispatch.theircompany.com (white-label CNAME)
    stripeCustomerId: text("stripe_customer_id"), // mirror of the Stripe Customer for this tenant
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
  name: text("name").notNull(),
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
