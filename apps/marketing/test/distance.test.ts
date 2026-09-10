/**
 * The route measurer.
 *
 * Every test here drives a STUBBED `fetch`. That is the point of the interface: the one
 * part of pricing that touches a network is the one part that must be exercisable
 * without one, because a live third-party call inside a test path produces a moving
 * failure — which this repo has already paid for once with the HIBP breach check.
 *
 * What is asserted is almost entirely failure behaviour, because a quote is a
 * convenience and the booking is the product: every way this can go wrong has to come
 * back as null so the job reaches the board unpriced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@porterdirect/contact";
import {
  isRoutingConfigured,
  mapboxRouteMeasurer,
  routeMeasurer,
  unmeasuredRoute,
} from "../lib/distance";

const pickup: Address = {
  line1: "811 W 7th St",
  line2: null,
  city: "Los Angeles",
  region: "CA",
  postalCode: "90017",
  country: "US",
};
const dropoff: Address = { ...pickup, line1: "1355 N Highland Ave", postalCode: "90028" };

const geocoded = (lng: number, lat: number) => ({
  features: [{ geometry: { coordinates: [lng, lat] } }],
});
const routed = (metres: number) => ({ routes: [{ distance: metres }] });

function stubFetch(responses: unknown[]): ReturnType<typeof vi.fn> {
  const calls = [...responses];
  const fn = vi.fn(() => {
    const next = calls.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined) return Promise.reject(new Error("unexpected extra fetch"));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(next) } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("no provider configured", () => {
  it("measures nothing, which is the correct behaviour rather than a stub", async () => {
    expect(await unmeasuredRoute.measure(pickup, dropoff)).toBeNull();
  });

  it("is what an empty or blank token resolves to", async () => {
    expect(await routeMeasurer(undefined).measure(pickup, dropoff)).toBeNull();
    expect(await routeMeasurer("").measure(pickup, dropoff)).toBeNull();
    expect(await routeMeasurer("   ").measure(pickup, dropoff)).toBeNull();
  });

  it("reports itself to the setup checklist", () => {
    expect(isRoutingConfigured(undefined)).toBe(false);
    expect(isRoutingConfigured("  ")).toBe(false);
    expect(isRoutingConfigured("pk.abc")).toBe(true);
  });
});

describe("measuring a route", () => {
  it("returns whole metres of road distance", async () => {
    stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), routed(12_345.67)]);
    const metres = await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff);
    // Rounded, because the pricing package REFUSES a fractional distance — a float
    // arriving there means one leaked in upstream.
    expect(metres).toBe(12_346);
  });

  it("geocodes both ends together rather than one after the other", async () => {
    const fetchFn = stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), routed(1000)]);
    await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff);
    // Two sequential round-trips would double the time a customer waits on the form, and
    // either one failing produces the same answer anyway.
    const [first, second] = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(first).toContain("/search/geocode/");
    expect(second).toContain("/search/geocode/");
    expect(String(fetchFn.mock.calls[2]![0])).toContain("/directions/");
  });

  it("sends the address parts as one query line, and nothing else", async () => {
    const fetchFn = stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), routed(1000)]);
    await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff);
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(decodeURIComponent(url)).toContain("811 W 7th St, Los Angeles, CA, 90017, US");
  });

  it("asks for no route geometry", async () => {
    // The distance is the whole answer. A full polyline is a much larger response for
    // something nothing renders.
    const fetchFn = stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), routed(1000)]);
    await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff);
    expect(String(fetchFn.mock.calls[2]![0])).toContain("overview=false");
  });
});

describe("every failure degrades to 'an operator prices it'", () => {
  it("returns null when an address geocodes to nothing", async () => {
    // The common real case: a genuine address typed slightly wrong. It must produce a
    // job someone prices, never a wrong price.
    stubFetch([{ features: [] }, geocoded(-118.33, 34.09)]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null when the provider errors", async () => {
    stubFetch([new Error("ECONNRESET")]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 429 } as Response)));
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null when the response is not the shape we expect", async () => {
    // A vendor changing a field name must not become an exception on a booking form.
    stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), { routes: [{}] }]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null when a route comes back with a non-finite distance", async () => {
    stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), routed(Number.NaN)]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null when there is no route between the two points", async () => {
    stubFetch([geocoded(-118.26, 34.04), geocoded(-118.33, 34.09), { routes: [] }]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("returns null rather than throwing when coordinates are not numbers", async () => {
    stubFetch([{ features: [{ geometry: { coordinates: ["west", "north"] } }] }, geocoded(0, 0)]);
    expect(await mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).toBeNull();
  });

  it("NEVER throws, whatever comes back", async () => {
    // The contract the whole booking path leans on.
    for (const payload of [null, undefined, "", 0, [], { routes: "nope" }, { features: 3 }]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response)),
      );
      await expect(mapboxRouteMeasurer("pk.test").measure(pickup, dropoff)).resolves.toBeNull();
    }
  });

  it("gives up rather than hanging a booking form", async () => {
    // A request that never settles must not hold the form — or the serverless
    // invocation — open. The abort surfaces as a rejection, which is caught as null.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    vi.useFakeTimers();
    const pending = mapboxRouteMeasurer("pk.test").measure(pickup, dropoff);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe("the token never leaks into an error path", () => {
  it("is not present in what the function returns", async () => {
    // It goes in a query string to the vendor, which is their API's shape. What matters
    // is that nothing here carries it back out into a log, a message or a page.
    stubFetch([new Error("boom pk.secret-token")]);
    const result = await mapboxRouteMeasurer("pk.secret-token").measure(pickup, dropoff);
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
