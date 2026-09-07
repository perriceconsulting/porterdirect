/**
 * Neon Postgres client. One place constructs the connection (DOSI-S) so no surface
 * invents its own pooling or SSL settings.
 *
 * Uses the neon-http driver: each query is a separate HTTP request, which suits
 * serverless/edge request handlers. It does NOT support multi-statement transactions —
 * anything needing one must use a websocket/Pool driver instead. The webhook path is
 * deliberately built from single atomic statements so it does not need transactions.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDbClient>;

export function createDbClient(connectionString: string | undefined) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required but not set.");
  }
  return drizzle(neon(connectionString), { schema });
}
