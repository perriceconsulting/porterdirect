/**
 * Everything that can refuse a signup, checked BEFORE an account exists.
 *
 * This file exists because of a live defect found against production. `signUpAction`
 * created the Better Auth user and only then called `provisionTenant`, so any provisioning
 * refusal left an **orphaned account**: a user row with no tenant. Two consequences, the
 * second worse than the first —
 *
 *   the person could sign in and land nowhere; and
 *   retrying with the same address hit "that email is already registered", so they could
 *   never complete signup with their own email.
 *
 * It was found by submitting a reserved host to the live signup form and then finding the
 * row in the database. Nothing in the suite could see it, because no test asserted on what
 * did NOT get created.
 *
 * The assertions here are therefore about ORDER, not about the individual rules — those
 * are covered by the host and plan tests. What must hold is that every refusal is
 * reachable without a user id.
 *
 * Skipped (not failed) without DATABASE_URL: `host-taken` is a real uniqueness question.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, tenants, type Db } from "@porterdirect/db";
import { validateProvisionInput } from "../lib/provisioning";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    for (const raw of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
      const line = raw.replace(/\r$/, "").trim();
      const m = /^DATABASE_URL=(.*)$/.exec(line);
      if (m && m[1]) return m[1].trim();
    }
  } catch {
    /* no .env.local — fall through to skip */
  }
  return undefined;
}

const DB_URL = databaseUrl();
const suite = DB_URL ? describe : describe.skip;

const good = { name: "Acme Courier", host: "", planId: "direct_courier", country: "US" };

suite("signup pre-flight", () => {
  let db: Db;
  let takenHost = "";
  let tenantId = "";
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    // `validateProvisionInput` reads `process.env.DATABASE_URL` itself rather than taking
    // a client, so resolving the URL into a local is not enough — it has to be where the
    // function will look. Worth noting rather than working around silently: this is the
    // shape `packages/**` bans for exactly this reason, and it is only tolerable here
    // because the app layer is where configuration is allowed to be read.
    process.env.DATABASE_URL ??= DB_URL;
    db = createDbClient(DB_URL);
    takenHost = `preflight-${run}.example.test`;
    const [t] = await db
      .insert(tenants)
      .values({ name: `Preflight ${run}`, primaryHost: takenHost })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  });

  afterAll(async () => {
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  /**
   * The property that closes the defect. Every one of these is a refusal a real person
   * hits, and every one of them used to happen only after their account was created.
   */
  it.each([
    ["a reserved platform host", { host: "app.porterdirect.com" }, "invalid-host"],
    ["a malformed host", { host: "not a host" }, "invalid-host"],
    ["a company name too short to be one", { host: `ok-${run}.example.test`, name: "A" }, "invalid-name"],
    ["a plan that does not exist", { host: `ok-${run}.example.test`, planId: "gold_plated" }, "unknown-plan"],
    ["an unsupported country", { host: `ok-${run}.example.test`, country: "ZZ" }, "invalid-country"],
  ])("refuses %s with no user id in hand", async (_label, override, expected) => {
    const result = await validateProvisionInput({ ...good, ...override });
    expect("failure" in result, "expected a refusal").toBe(true);
    if (!("failure" in result)) return;
    expect(result.failure.kind).toBe(expected);
  });

  it("refuses a host another operator already holds", async () => {
    const result = await validateProvisionInput({ ...good, host: takenHost });
    expect("failure" in result).toBe(true);
    if (!("failure" in result)) return;
    expect(result.failure.kind).toBe("host-taken");
  });

  it("accepts a clean signup and hands back the normalised host and plan", async () => {
    const result = await validateProvisionInput({ ...good, host: `FRESH-${run}.example.test` });
    expect("failure" in result, "expected acceptance").toBe(false);
    if ("failure" in result) return;
    // Normalised by the same rule that classifies incoming requests, so the host stored
    // is the host a later request will match on.
    expect(result.host).toBe(`fresh-${run}.example.test`);
    expect(result.planId).toBe("direct_courier");
  });

  it("takes no user id at all — which is what makes the ordering fix possible", () => {
    // A property about the SIGNATURE, asserted so a future change that reintroduces a
    // user-id dependency has to confront this comment. If provisioning validation ever
    // needs the account, the orphan window comes back.
    expect(validateProvisionInput.length).toBe(1);
    const arg: Parameters<typeof validateProvisionInput>[0] = good;
    expect(Object.keys(arg).sort()).toEqual(["country", "host", "name", "planId"]);
  });
});
