CREATE TABLE "order_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"recipient_name" text,
	"photo_key" text,
	"signature_key" text,
	"captured_lat" text,
	"captured_lng" text,
	"captured_accuracy_m" integer,
	"captured_by_user_id" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_captured_by_user_id_user_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_proofs_order_idx" ON "order_proofs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_proofs_tenant_idx" ON "order_proofs" USING btree ("tenant_id");