ALTER TABLE "orders" ADD COLUMN "pickup_line1" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_line2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_city" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_region" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_postal_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_country" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_line1" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_line2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_city" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_region" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_postal_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dropoff_country" text NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_dropoff_area_idx" ON "orders" USING btree ("tenant_id","dropoff_postal_code");