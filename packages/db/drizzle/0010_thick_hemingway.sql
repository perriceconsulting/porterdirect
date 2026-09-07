ALTER TABLE "orders" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "closure_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "redispatched_from_order_id" uuid;--> statement-breakpoint
CREATE INDEX "orders_closure_idx" ON "orders" USING btree ("tenant_id","closure_reason");--> statement-breakpoint
CREATE INDEX "orders_redispatch_idx" ON "orders" USING btree ("redispatched_from_order_id");