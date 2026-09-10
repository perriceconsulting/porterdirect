/**
 * Road distance between two addresses.
 *
 * This is the one input `quoteJob` cannot compute for itself, and it is deliberately the
 * only part of pricing that touches a network. The arithmetic lives in
 * `@porterdirect/pricing` and takes the distance as an argument, so the money rules stay
 * testable with no key and no traffic.
 *
 * THREE RULES SHAPE EVERYTHING HERE.
 *
 * 1. It NEVER throws and never blocks a booking. Every failure — no key, a timeout, an
 *    address nothing recognises, a provider outage, a bad response — returns null, which
 *    `quoteJob` turns into `needs_review` and the operator prices by hand. A courier firm
 *    losing bookings because a mapping vendor is down would be a far worse product than
 *    one that occasionally asks someone to type a number.
 *
 * 2. It NEVER guesses. There is no straight-line fallback, and that is not laziness: a
 *    great-circle distance is short by a factor that grows precisely where the money is
 *    — dense cities with rivers, one-way systems and no bridge for two miles. A quote
 *    built on it would undercharge systematically on the operator's best work, and it
 *    would look completely reasonable while doing so.
 *
 * 3. It is TIME-BOXED. A customer waiting on a booking form is not going to wait on a
 *    vendor's slow day, and a hung request would hold a serverless invocation open. Past
 *    the deadline the job simply becomes one an operator prices.
 *
 * PRIVACY NOTE, because this is the first thing in the product that sends a tenant's
 * customer data to a third party: a pickup and drop-off pair leaves our infrastructure
 * on every quote. For the medical courier work in the PRD that is a data-processing
 * question with a real answer required (a DPA, and possibly a BAA), not a footnote. It
 * is one more reason the provider sits behind this interface rather than being called
 * from a form handler.
 */
import type { Address } from "@porterdirect/contact";

/** Past this, the booking becomes one an operator prices. */
const DEADLINE_MS = 4_000;

export interface RouteMeasurer {
  /** Whole metres of ROAD distance, or null if it could not be measured. Never throws. */
  measure(pickup: Address, dropoff: Address): Promise<number | null>;
}

/**
 * The measurer used when no provider is configured.
 *
 * Not a stub to be replaced later — it is the correct behaviour for a deployment with no
 * mapping account, and it is what keeps "no key" from being a special case anywhere else
 * in the codebase. Every booking simply arrives unpriced.
 */
export const unmeasuredRoute: RouteMeasurer = {
  measure: () => Promise.resolve(null),
};

/**
 * One address as a single query line.
 *
 * This is the ONE place the parts are flattened, and it happens at the boundary to a
 * service that wants a string. The parts stay the stored form, because "which jobs are
 * in this postcode" and "print a label" do not survive splitting free text afterwards.
 */
function queryLine(a: Address): string {
  return [a.line1, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(", ");
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

/** [lng, lat] — the order Mapbox uses, and the order its directions endpoint wants back. */
type Point = readonly [number, number];

function readFirstCoordinate(payload: unknown): Point | null {
  const features = (payload as { features?: unknown })?.features;
  if (!Array.isArray(features) || features.length === 0) return null;
  const coords = (features[0] as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  // Typed as unknown[] rather than destructured straight out of an `any[]`: everything
  // in this file is a payload from a vendor, and treating it as trusted is how a shape
  // change becomes a runtime throw on a booking form.
  const [lng, lat] = coords as unknown[];
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function readRouteMetres(payload: unknown): number | null {
  const routes = (payload as { routes?: unknown })?.routes;
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const distance = (routes[0] as { distance?: unknown })?.distance;
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) return null;
  // Whole metres: the pricing package refuses a fractional distance, because a float
  // arriving there means one leaked in upstream.
  return Math.round(distance);
}

/**
 * Mapbox: geocode both ends, then ask for a driving route.
 *
 * Two calls rather than one because addresses are stored in parts and Mapbox's directions
 * endpoint takes coordinates. Geocoding is the step that fails on a real address typed
 * slightly wrong, which is exactly the case that must degrade to `needs_review` rather
 * than to a wrong price.
 */
export function mapboxRouteMeasurer(token: string): RouteMeasurer {
  return {
    async measure(pickup: Address, dropoff: Address): Promise<number | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
      try {
        const geocode = async (a: Address): Promise<Point | null> => {
          const url =
            `https://api.mapbox.com/search/geocode/v6/forward` +
            `?q=${encodeURIComponent(queryLine(a))}&limit=1&access_token=${encodeURIComponent(token)}`;
          return readFirstCoordinate(await fetchJson(url, controller.signal));
        };

        // Both ends at once: two sequential round-trips would double the time a customer
        // waits, and either failing means the same answer anyway.
        const [from, to] = await Promise.all([geocode(pickup), geocode(dropoff)]);
        if (!from || !to) return null;

        const path = `${from[0]},${from[1]};${to[0]},${to[1]}`;
        const url =
          `https://api.mapbox.com/directions/v5/mapbox/driving/${path}` +
          `?overview=false&access_token=${encodeURIComponent(token)}`;
        return readRouteMetres(await fetchJson(url, controller.signal));
      } catch {
        // Includes the abort. A quote is a convenience; the booking is the product.
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The measurer this deployment should use.
 *
 * Reads the environment HERE rather than in a package, because a library that reads the
 * environment cannot be tested without one and hides which surface owns the secret —
 * which is why `process.env` is banned inside `packages/**\/src`.
 */
export function routeMeasurer(token = process.env.MAPBOX_ACCESS_TOKEN): RouteMeasurer {
  if (!token?.trim()) return unmeasuredRoute;
  return mapboxRouteMeasurer(token.trim());
}

/** Whether this deployment can quote at all — for the console's setup checklist. */
export function isRoutingConfigured(token = process.env.MAPBOX_ACCESS_TOKEN): boolean {
  return Boolean(token?.trim());
}
