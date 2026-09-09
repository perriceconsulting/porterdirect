CREATE TYPE "public"."customer_account_status" AS ENUM('active', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."customer_signup_mode" AS ENUM('invite_only', 'open');--> statement-breakpoint
CREATE TABLE "customer_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"company_name" text,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"company_name" text,
	"phone" text,
	"status" "customer_account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_rate_card_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"type" "order_type" NOT NULL,
	"base_cents" integer NOT NULL,
	"per_mile_cents" integer NOT NULL,
	"minimum_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"driver_pay_percent" integer NOT NULL,
	"max_quotable_meters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "price_cents" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "price_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "booked_by_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "quoted_distance_meters" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "customer_signup" "customer_signup_mode" DEFAULT 'invite_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_customers" ADD CONSTRAINT "tenant_customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_customers" ADD CONSTRAINT "tenant_customers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_rate_card_rates" ADD CONSTRAINT "tenant_rate_card_rates_rate_card_id_tenant_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."tenant_rate_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_rate_cards" ADD CONSTRAINT "tenant_rate_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invitations_token_idx" ON "customer_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "customer_invitations_tenant_idx" ON "customer_invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customer_invitations_email_idx" ON "customer_invitations" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_customers_tenant_user_idx" ON "tenant_customers" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_customers_tenant_idx" ON "tenant_customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_customers_user_idx" ON "tenant_customers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_rate_card_rates_card_type_idx" ON "tenant_rate_card_rates" USING btree ("rate_card_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_rate_cards_tenant_idx" ON "tenant_rate_cards" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_booked_by_customer_id_tenant_customers_id_fk" FOREIGN KEY ("booked_by_customer_id") REFERENCES "public"."tenant_customers"("id") ON DELETE set null ON UPDATE no action;