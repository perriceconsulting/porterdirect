ALTER TABLE "order_events" ALTER COLUMN "from_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "to_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
DROP TYPE "public"."order_status";--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'assigned', 'en_route', 'delivered', 'cancelled', 'failed');--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "from_status" SET DATA TYPE "public"."order_status" USING "from_status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "order_events" ALTER COLUMN "to_status" SET DATA TYPE "public"."order_status" USING "to_status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."order_status";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DATA TYPE "public"."order_status" USING "status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."order_type";--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('fixed_pickup', 'scheduled_courier');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "type" SET DATA TYPE "public"."order_type" USING "type"::"public"."order_type";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "authorized_cents";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "captured_cents";