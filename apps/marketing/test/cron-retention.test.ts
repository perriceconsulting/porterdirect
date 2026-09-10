/**
 * The scheduled retention sweep.
 *
 * The route exists because the sweep functions were written, tested, and then called by
 * nothing — retention meant "we CAN destroy on time" rather than "we DO", and under a BAA
 * the commitment is the second one. So the tests here are mostly about the guard on an
 * endpoint that deletes things, and about the sweep being safe to run when there is
 * nothing to do.
 *
 * The deletion behaviour itself is covered in `retention.test.ts` and `access-log.test.ts`
 * against a real database; this file is about the door.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

async function loadRoute() {
  vi.resetModules();
  return (await import("../app/api/cron/retention/route")) as {
    GET: (request: Request) => Promise<Response>;
  };
}

const get = (auth: string | null): Request =>
  new Request("https://porterdirect.com/api/cron/retention", {
    headers: auth === null ? {} : { authorization: auth },
  });

beforeEach(() => {
  process.env = { ...ORIGINAL };
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the door", () => {
  it("refuses when no secret is configured, rather than running openly", async () => {
    // Failing closed costs a night's sweep and makes the misconfiguration visible.
    // Failing open would put an unauthenticated delete endpoint on a public domain.
    delete process.env.CRON_SECRET;
    const { GET } = await loadRoute();
    expect((await GET(get("Bearer anything"))).status).toBe(404);
  });

  it("refuses a request with no authorization header", async () => {
    process.env.CRON_SECRET = "a-long-random-value";
    const { GET } = await loadRoute();
    expect((await GET(get(null))).status).toBe(404);
  });

  it("refuses a wrong secret", async () => {
    process.env.CRON_SECRET = "a-long-random-value";
    const { GET } = await loadRoute();
    expect((await GET(get("Bearer not-the-secret"))).status).toBe(404);
  });

  it("refuses the secret without the Bearer scheme", async () => {
    process.env.CRON_SECRET = "a-long-random-value";
    const { GET } = await loadRoute();
    expect((await GET(get("a-long-random-value"))).status).toBe(404);
  });

  it("answers 404 rather than 401, so the route's existence is not confirmed", async () => {
    // Same posture as every other refusal in this product: an unauthorized caller learns
    // nothing, including whether there is anything here to attack.
    process.env.CRON_SECRET = "a-long-random-value";
    const { GET } = await loadRoute();
    const res = await GET(get("Bearer wrong"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
  });
});

describe("the schedule", () => {
  it("is registered in vercel.json, or nothing ever calls the route", async () => {
    // The whole defect being fixed was a function with no caller. A route with no schedule
    // is the same defect one level up, and it would be invisible in exactly the same way.
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(
      readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"),
    ) as { crons?: { path?: string; schedule?: string }[] };

    const cron = config.crons?.find((c) => c.path === "/api/cron/retention");
    expect(cron, "no cron entry points at the retention route").toBeDefined();
    expect(typeof cron!.schedule).toBe("string");
    // Five fields, i.e. a real cron expression rather than a placeholder.
    expect(cron!.schedule!.trim().split(/\s+/)).toHaveLength(5);
  });
});
