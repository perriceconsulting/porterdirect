/**
 * PHAST — tenant and auth isolation under concurrency.
 *
 * The property: a request's tenant is decided by its HOST and its identity by its
 * COOKIE, and no amount of parallel traffic may cross those wires. This is the
 * platform's existential failure mode — one licensee seeing another's data — and it is
 * exactly the class a single-threaded pass cannot surface, because it needs two
 * in-flight requests interleaving inside one server process.
 *
 * Concretely this hunts for: a cached auth instance or DB client that captured the
 * first request's identity; per-request memoisation leaking across requests; a response
 * cached by host but keyed without the session, or the reverse.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { inArray } from "drizzle-orm";
import { createDbClient, tenantMembers, tenants, users, type Db } from "@porterdirect/db";
import type { TenantRole } from "@porterdirect/db";

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const raw of text.split("\n")) {
      const m = /^DATABASE_URL=(.*)$/.exec(raw.replace(/\r$/, "").trim());
      if (m && m[1]) return m[1].trim();
    }
  } catch {
    /* offline — the suite skips */
  }
  return undefined;
}

const DB_URL = databaseUrl();
const PASSWORD = "correct-horse-battery-staple-42";
const run = randomUUID().slice(0, 8);

/**
 * One licensee: a host, a user, a role. Roles differ per actor on purpose, so a leak
 * surfaces as the WRONG ROLE as well as the wrong tenant id.
 */
interface Actor {
  readonly label: string;
  readonly host: string;
  readonly email: string;
  readonly role: TenantRole;
  tenantId: string;
  userId: string;
}

const ACTORS: Actor[] = [
  {
    label: "acme",
    host: `dispatch.acme-${run}.test`,
    email: `acme+${run}@example.test`,
    role: "dispatcher",
    tenantId: "",
    userId: "",
  },
  {
    label: "globex",
    host: `dispatch.globex-${run}.test`,
    email: `globex+${run}@example.test`,
    role: "owner",
    tenantId: "",
    userId: "",
  },
  {
    label: "initech",
    host: `dispatch.initech-${run}.test`,
    email: `initech+${run}@example.test`,
    role: "driver",
    tenantId: "",
    userId: "",
  },
];

let db: Db;
const contexts: APIRequestContext[] = [];

/** Sign up through the real endpoint so the cookie is a genuinely signed session. */
async function signUp(baseURL: string, actor: Actor): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/sign-up/email", {
    data: { email: actor.email, password: PASSWORD, name: actor.label },
  });
  expect(res.ok(), `sign-up failed for ${actor.label}: HTTP ${res.status()}`).toBeTruthy();
  return ctx;
}

test.describe("tenant + auth isolation under concurrency", () => {
  // Several contexts sign in and fan out; the 30s default would expire on load and the
  // resulting "Test ended" reads like a product failure while being a harness limit.
  test.describe.configure({ timeout: 180_000, mode: "serial" });

  test.skip(!DB_URL, "DATABASE_URL is required to seed tenants");

  test.beforeAll(async ({ baseURL }) => {
    db = createDbClient(DB_URL);

    for (const actor of ACTORS) {
      const ctx = await signUp(baseURL ?? "http://localhost:3000", actor);
      contexts.push(ctx);
      const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
        user?: { id?: string };
      };
      actor.userId = session.user?.id ?? "";
      expect(actor.userId, `no user id for ${actor.label}`).toBeTruthy();
    }

    const rows = await db
      .insert(tenants)
      .values(ACTORS.map((a) => ({ name: `${a.label} ${run}`, primaryHost: a.host })))
      .returning({ id: tenants.id, host: tenants.primaryHost });

    for (const actor of ACTORS) {
      actor.tenantId = rows.find((r) => r.host === actor.host)?.id ?? "";
      expect(actor.tenantId, `no tenant for ${actor.label}`).toBeTruthy();
    }

    await db
      .insert(tenantMembers)
      .values(ACTORS.map((a) => ({ tenantId: a.tenantId, userId: a.userId, role: a.role })));
  });

  test.afterAll(async () => {
    for (const ctx of contexts) await ctx.dispose();
    if (!db) return;
    const tenantIds = ACTORS.map((a) => a.tenantId).filter(Boolean);
    const userIds = ACTORS.map((a) => a.userId).filter(Boolean);
    if (tenantIds.length) {
      await db.delete(tenantMembers).where(inArray(tenantMembers.tenantId, tenantIds));
      await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    }
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  });

  test("each actor sees only its own tenant when all request CONCURRENTLY", async () => {
    const results = await Promise.all(
      ACTORS.map(async (actor, i) => {
        const res = await contexts[i]!.get("/api/me", { headers: { host: actor.host } });
        return { actor, status: res.status(), body: (await res.json()) as Record<string, any> };
      }),
    );

    for (const { actor, status, body } of results) {
      expect(status, `${actor.label} expected 200`).toBe(200);
      expect(body.tenant?.id, `${actor.label} received the wrong tenant`).toBe(actor.tenantId);
      expect(body.userId, `${actor.label} received the wrong user`).toBe(actor.userId);
      expect(body.role, `${actor.label} received the wrong role`).toBe(actor.role);
    }
  });

  test("holds under a sustained burst of interleaved requests", async () => {
    // Repetition matters: a leak from a lazily-populated cache appears only once that
    // cache is warm, so a first round can pass while later ones do not.
    const rounds = 12;
    const calls = ACTORS.flatMap((actor, i) =>
      Array.from({ length: rounds }, () => async () => {
        const res = await contexts[i]!.get("/api/me", { headers: { host: actor.host } });
        const body = (await res.json()) as Record<string, any>;
        return {
          label: actor.label,
          ok:
            res.status() === 200 &&
            body.tenant?.id === actor.tenantId &&
            body.role === actor.role &&
            body.userId === actor.userId,
          saw: body.tenant?.id as string | undefined,
          expected: actor.tenantId,
        };
      }),
    );

    const settled = await Promise.all(calls.map((c) => c()));
    const leaks = settled.filter((r) => !r.ok);
    expect(leaks, `cross-tenant leak under load: ${JSON.stringify(leaks.slice(0, 3))}`).toHaveLength(
      0,
    );
  });

  test("a valid session on ANOTHER tenant's host is refused, not served", async () => {
    // The dangerous near-miss: a real signed-in user pointed at a host they hold no
    // membership on. It must be 403 — never 200 with the other tenant's data, and never
    // 200 with their own tenant's data on a host that is not theirs.
    const results = await Promise.all(
      ACTORS.map(async (actor, i) => {
        const foreign = ACTORS[(i + 1) % ACTORS.length]!;
        const res = await contexts[i]!.get("/api/me", { headers: { host: foreign.host } });
        return {
          actor: actor.label,
          foreign: foreign.label,
          status: res.status(),
          text: await res.text(),
        };
      }),
    );

    for (const r of results) {
      expect(r.status, `${r.actor} on ${r.foreign}'s host must be refused`).toBe(403);
      for (const a of ACTORS) {
        expect(r.text, `refusal leaked a tenant id to ${r.actor}`).not.toContain(a.tenantId);
      }
    }
  });

  test("an unclaimed host is 404 — there is no default tenant to fall back to", async () => {
    const res = await contexts[0]!.get("/api/me", { headers: { host: `nobody-${run}.test` } });
    expect(res.status()).toBe(404);
  });

  test("no cookie is 401, and the refusal leaks no tenant data", async () => {
    const anon = await request.newContext({ baseURL: "http://localhost:3000" });
    const res = await anon.get("/api/me", { headers: { host: ACTORS[0]!.host } });
    expect(res.status()).toBe(401);
    expect(await res.text()).not.toContain(ACTORS[0]!.tenantId);
    await anon.dispose();
  });

  test("identity responses are not stored by a shared cache", async () => {
    // A cache-control slip is how one tenant's /api/me reaches another through any
    // intermediary that caches on host alone.
    const res = await contexts[0]!.get("/api/me", { headers: { host: ACTORS[0]!.host } });
    const cc = res.headers()["cache-control"] ?? "";
    expect(cc).toContain("no-store");
    expect(cc).toContain("private");
  });
});
