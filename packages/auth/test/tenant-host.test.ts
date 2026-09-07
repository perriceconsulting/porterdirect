import { describe, it, expect } from "vitest";
import {
  assignableTenantHost,
  classifyHost,
  normalizeHost,
  type HostConfig,
} from "../src/tenant-host.js";

const CONFIG: HostConfig = {
  apex: "porterdirect.com",
  reservedSubdomains: ["www", "app", "fleet", "api", "admin", "status"],
};

describe("normalizeHost", () => {
  it.each([
    ["PorterDirect.COM", "porterdirect.com", "Host is case-insensitive; a DB comparison is not"],
    ["localhost:3000", "localhost", "dev port"],
    ["dispatch.acme.com:8443", "dispatch.acme.com", "proxy-appended port"],
    ["porterdirect.com.", "porterdirect.com", "fully-qualified trailing dot"],
    ["www.acme.com", "acme.com", "www is not a distinct tenant"],
    ["  acme.com  ", "acme.com", "surrounding whitespace"],
    ["[::1]:3000", "::1", "bracketed IPv6 literal with port"],
  ])("normalizes %j to %j (%s)", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", ":3000", "[unclosed"])(
    "returns null for unusable host %j",
    (input) => {
      // Never "" — an empty host must not become a lookup that could match a blank row.
      expect(normalizeHost(input as string)).toBeNull();
    },
  );
});

describe("classifyHost", () => {
  it("treats the apex as a platform surface", () => {
    expect(classifyHost("porterdirect.com", CONFIG)).toEqual({ kind: "platform", subdomain: null });
    expect(classifyHost("www.porterdirect.com", CONFIG)).toEqual({ kind: "platform", subdomain: null });
  });

  it.each(["app", "fleet", "api", "admin", "status"])(
    "treats reserved subdomain %j as a platform surface",
    (sub) => {
      expect(classifyHost(`${sub}.porterdirect.com`, CONFIG)).toEqual({
        kind: "platform",
        subdomain: sub,
      });
    },
  );

  it("treats a white-label CNAME as a tenant host", () => {
    expect(classifyHost("dispatch.theircompany.com", CONFIG)).toEqual({
      kind: "tenant",
      host: "dispatch.theircompany.com",
    });
  });

  it("treats an unreserved subdomain of our apex as a tenant host", () => {
    expect(classifyHost("acmecouriers.porterdirect.com", CONFIG)).toEqual({
      kind: "tenant",
      host: "acmecouriers.porterdirect.com",
    });
  });

  /**
   * Subdomain confusion. A loose "does it contain a reserved label" check would hand a
   * platform surface to any host merely ending in one. Only a FIRST-level subdomain of
   * our apex counts.
   */
  it.each([
    "evil.app.porterdirect.com",
    "app.evil.porterdirect.com",
    "admin.attacker.porterdirect.com",
  ])("does not mistake nested %j for a platform surface", (host) => {
    expect(classifyHost(host, CONFIG)).toEqual({ kind: "tenant", host });
  });

  it("does not mistake a lookalike apex for ours", () => {
    // "notporterdirect.com" ends with our apex as a substring but is a different domain.
    expect(classifyHost("notporterdirect.com", CONFIG)).toEqual({
      kind: "tenant",
      host: "notporterdirect.com",
    });
  });

  it("returns null for an unusable host rather than guessing a tenant", () => {
    // A null here becomes a 404. There is deliberately no default tenant to fall back
    // to — a fallback would serve one licensee's data on another licensee's domain.
    expect(classifyHost("", CONFIG)).toBeNull();
    expect(classifyHost(null, CONFIG)).toBeNull();
  });
});

describe("assignableTenantHost", () => {
  it("accepts a normal white-label CNAME", () => {
    expect(assignableTenantHost("dispatch.acme.com", CONFIG)).toEqual({
      ok: true,
      host: "dispatch.acme.com",
    });
  });

  it("normalizes before accepting, so one host cannot be claimed twice", () => {
    // "WWW.Acme.COM:443" and "acme.com" must not become two tenant rows.
    expect(assignableTenantHost("WWW.Acme.COM:443", CONFIG)).toEqual({ ok: true, host: "acme.com" });
  });

  /**
   * The signup-abuse case: nothing self-service may claim a host we would classify as
   * one of our own surfaces, or a tenant row would shadow it.
   */
  it.each(["app", "fleet", "api", "admin", "status", "www"])(
    "refuses to assign reserved subdomain %j",
    (sub) => {
      const result = assignableTenantHost(`${sub}.porterdirect.com`, CONFIG);
      expect(result.ok).toBe(false);
    },
  );

  it("refuses our own apex", () => {
    expect(assignableTenantHost("porterdirect.com", CONFIG)).toEqual({
      ok: false,
      reason: "our-apex",
    });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["localhost", "malformed"],
    ["-bad.example.com", "malformed"],
    ["bad-.example.com", "malformed"],
    ["has space.example.com", "malformed"],
    ["under_score.example.com", "malformed"],
  ])("refuses %j as %s", (input, reason) => {
    expect(assignableTenantHost(input, CONFIG)).toEqual({ ok: false, reason });
  });

  it("refuses an over-long hostname", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`;
    expect(assignableTenantHost(long, CONFIG)).toEqual({ ok: false, reason: "too-long" });
  });

  it("agrees with classifyHost: nothing assignable is ever a platform surface", () => {
    const candidates = [
      "dispatch.acme.com",
      "app.porterdirect.com",
      "porterdirect.com",
      "acmecouriers.porterdirect.com",
      "evil.app.porterdirect.com",
    ];
    for (const host of candidates) {
      const assignment = assignableTenantHost(host, CONFIG);
      if (assignment.ok) {
        expect(classifyHost(assignment.host, CONFIG)?.kind, `${host} was assignable`).toBe("tenant");
      }
    }
  });
});
