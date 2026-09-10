CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer,
	"retain_until" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_objects_key_idx" ON "storage_objects" USING btree ("key");--> statement-breakpoint
CREATE INDEX "storage_objects_tenant_idx" ON "storage_objects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storage_objects_order_idx" ON "storage_objects" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "storage_objects_sweep_idx" ON "storage_objects" USING btree ("retain_until","deleted_at");