/**
 * Drizzle Kit config. Migrations are GENERATED from src/schema.ts — that file is the
 * canonical origin for persisted shapes (CLAUDE.md), and hand-writing DDL would make
 * the database a second source of truth that silently drifts from the types.
 */
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (see .env.local)");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
