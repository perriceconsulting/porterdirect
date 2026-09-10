CREATE TYPE "public"."access_actor_kind" AS ENUM('member', 'public_link');--> statement-breakpoint
CREATE TABLE "access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"actor_kind" "access_actor_kind" NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"object_key" text,
	"ip_address" text,
	"user_agent" text,
	"retain_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_events_order_idx" ON "access_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "access_events_tenant_idx" ON "access_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "access_events_actor_idx" ON "access_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "access_events_sweep_idx" ON "access_events" USING btree ("retain_until");