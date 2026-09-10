CREATE TYPE "public"."fuel_basis" AS ENUM('gasoline', 'diesel');--> statement-breakpoint
CREATE TABLE "fuel_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"basis" "fuel_basis" NOT NULL,
	"region" text NOT NULL,
	"cents_per_gallon" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_rate_cards" ADD COLUMN "fuel_basis" "fuel_basis";--> statement-breakpoint
ALTER TABLE "tenant_rate_cards" ADD COLUMN "fuel_baseline_cents_per_gallon" integer;--> statement-breakpoint
ALTER TABLE "tenant_rate_cards" ADD COLUMN "miles_per_gallon_tenths" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_prices_observation_idx" ON "fuel_prices" USING btree ("basis","region","as_of");--> statement-breakpoint
CREATE INDEX "fuel_prices_latest_idx" ON "fuel_prices" USING btree ("basis","region","as_of");