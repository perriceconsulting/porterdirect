ALTER TABLE "order_events" DROP CONSTRAINT "order_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_actor_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "retain_until" timestamp with time zone DEFAULT now() + interval '6 years' NOT NULL;--> statement-breakpoint
CREATE INDEX "order_events_sweep_idx" ON "order_events" USING btree ("retain_until");