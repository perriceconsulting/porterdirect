DROP INDEX "orders_redispatch_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_redispatch_idx" ON "orders" USING btree ("redispatched_from_order_id");