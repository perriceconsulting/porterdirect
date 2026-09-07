/**
 * Host → tenant resolution.
 *
 * White-label tenants map their own CNAME (dispatch.theircompany.com) at the apex, so
 * the incoming Host header is the primary tenant signal. Normalisation is pure and
 * lives here rather than inline at the edge, because every surface must agree on what
 * "the same host" means — two normalisations is two tenancy answers.
 */

/** Hosts that belong to us rather than to a tenant. */
export interface HostConfig {
  /** e.g. "porterdirect.com" — our apex, whose subdomains are our own surfaces. */
  readonly apex: string;
  /** Subdomains of the apex that are platform surfaces, not tenants. */
  readonly reservedSubdomains: readonly string[];
}

export const DEFAULT_HOST_CONFIG: HostConfig = {
  apex: "porterdirect.com",
  reservedSubdomains: ["www", "app", "fleet", "api", "admin", "status"],
};

/**
 * Normalise a Host header to a comparable hostname.
 *
 * Strips the port (":3000" in dev, and any proxy-appended port), lowercases (Host is
 * case-insensitive but a database comparison is not), strips a trailing dot (a valid
 * fully-qualified form that would otherwise miss every lookup), and drops "www.".
 * Returns null for anything unusable, so a caller cannot accidentally look up "".
 */
export function normalizeHost(rawHost: string | null | undefined): string | null {
  if (!rawHost) return null;
  let host = rawHost.trim().toLowerCase();
  if (!host) return null;

  // IPv6 literals arrive bracketed ("[::1]:3000"); take the bracketed part.
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return null;
    host = host.slice(1, close);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }

  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("www.")) host = host.slice(4);

  return host || null;
}

export type HostKind =
  | { kind: "platform"; subdomain: string | null }
  | { kind: "tenant"; host: string };

/**
 * Classify a normalised host as one of our own surfaces or a tenant's custom domain.
 *
 * Anything that is not the apex or a reserved subdomain of it is treated as a TENANT
 * host, and must then be looked up. Classification never invents a tenant — an unknown
 * host resolving to no row is a 404, not a fallback to some default tenant. A fallback
 * here would serve one licensee's data on another's domain.
 */
export function classifyHost(
  rawHost: string | null | undefined,
  config: HostConfig = DEFAULT_HOST_CONFIG,
): HostKind | null {
  const host = normalizeHost(rawHost);
  if (!host) return null;

  const apex = config.apex.toLowerCase();
  if (host === apex) return { kind: "platform", subdomain: null };

  if (host.endsWith(`.${apex}`)) {
    const subdomain = host.slice(0, -(apex.length + 1));
    // Only a FIRST-level subdomain is a platform surface. "evil.app.porterdirect.com"
    // is not "app" — matching loosely here would hand a platform surface to any host
    // that merely ends with a reserved label.
    if (!subdomain.includes(".") && config.reservedSubdomains.includes(subdomain)) {
      return { kind: "platform", subdomain };
    }
    return { kind: "tenant", host };
  }

  return { kind: "tenant", host };
}

export type HostRejection =
  | "empty"
  | "malformed"
  | "reserved"
  | "our-apex"
  | "too-long";

export type HostAssignment =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: HostRejection };

/** A hostname label: letters, digits, hyphens; not starting or ending with a hyphen. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * May a tenant claim this host?
 *
 * This is the check standing between self-service signup and someone registering
 * `app.porterdirect.com` as their own tenant host. `classifyHost` decides what an
 * INCOMING request is; this decides what a tenant is ALLOWED to register, and the two
 * must agree — a host we would classify as a platform surface can never be assignable,
 * or a tenant row would shadow one of our own surfaces.
 */
export function assignableTenantHost(
  rawHost: string | null | undefined,
  config: HostConfig = DEFAULT_HOST_CONFIG,
): HostAssignment {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, reason: "empty" };
  if (host.length > 253) return { ok: false, reason: "too-long" };

  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, reason: "malformed" };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: "malformed" };

  // Defer to classifyHost rather than re-deriving the rule: two implementations of
  // "is this ours" is how a reserved host eventually becomes assignable on one path.
  const classified = classifyHost(host, config);
  if (!classified) return { ok: false, reason: "malformed" };
  if (classified.kind === "platform") {
    return { ok: false, reason: host === config.apex.toLowerCase() ? "our-apex" : "reserved" };
  }

  return { ok: true, host };
}
