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
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

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
