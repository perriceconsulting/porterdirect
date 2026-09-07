CREATE TYPE "public"."order_status" AS ENUM('pending', 'assigned', 'shopping', 'checkout', 'en_route', 'delivered', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('fixed_pickup', 'shop_in_store', 'errand', 'scheduled_courier');--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"actor_user_id" text,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"type" "order_type" NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"pickup_address" text NOT NULL,
	"dropoff_address" text NOT NULL,
	"notes" text,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"authorized_cents" integer,
	"captured_cents" integer,
	"assigned_user_id" text,
	"scheduled_for" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_events_tenant_idx" ON "order_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_reference_idx" ON "orders" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "orders_assigned_idx" ON "orders" USING btree ("assigned_user_id");