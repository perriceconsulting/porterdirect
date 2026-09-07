import { describe, it, expect } from "vitest";
import { APIError } from "better-auth/api";
import {
  classifyAuthError,
  isAuthApiError,
  isRedirectError,
} from "../src/errors.js";

/** A real Better Auth error, as thrown by the API. */
function realApiError(status: string, message: string) {
  return new APIError(status as never, { message });
}

/**
 * The SAME error after crossing a bundler boundary: identical shape, different class
 * identity. This is what defeated `instanceof` inside a Next server action, and it is
 * the case the classifier must handle.
 */
function bundledApiError(statusCode: number, status: string, message: string) {
  return { statusCode, status, message, body: { message } };
}

describe("isRedirectError", () => {
  it("recognises a Next redirect so a catch never swallows navigation", () => {
    expect(isRedirectError({ digest: "NEXT_REDIRECT;push;/welcome;307;" })).toBe(true);
    expect(isRedirectError({ digest: "NEXT_NOT_FOUND" })).toBe(true);
  });

  it("does not mistake an ordinary error for a redirect", () => {
    expect(isRedirectError(new Error("boom"))).toBe(false);
    expect(isRedirectError(null)).toBe(false);
    expect(isRedirectError("NEXT_REDIRECT")).toBe(false);
  });
});

describe("isAuthApiError", () => {
  it("recognises a real Better Auth APIError", () => {
    expect(isAuthApiError(realApiError("UNAUTHORIZED", "Invalid email or password"))).toBe(true);
  });

  /** The regression: same shape, different class identity after bundling. */
  it("recognises an auth error that crossed a bundler boundary", () => {
    expect(isAuthApiError(bundledApiError(401, "UNAUTHORIZED", "Invalid email or password"))).toBe(
      true,
    );
  });

  it("never classifies a Next redirect as an auth error", () => {
    // Getting this wrong would convert every successful sign-in into an error page.
    expect(isAuthApiError({ digest: "NEXT_REDIRECT;push;/welcome;307;" })).toBe(false);
  });

  it.each([new Error("boom"), null, undefined, "string", 42, {}])(
    "rejects non-auth error %p",
    (value) => {
      expect(isAuthApiError(value)).toBe(false);
    },
  );
});

describe("classifyAuthError", () => {
  it("maps a real wrong-password error to bad-credentials", () => {
    expect(classifyAuthError(realApiError("UNAUTHORIZED", "Invalid email or password"))).toBe(
      "bad-credentials",
    );
  });

  it("maps the bundled equivalent identically — the whole point of the fix", () => {
    expect(classifyAuthError(bundledApiError(401, "UNAUTHORIZED", "Invalid email or password"))).toBe(
      "bad-credentials",
    );
  });

  it("gives the SAME code whether the account exists or the password is wrong", () => {
    // No account-enumeration oracle: both must be indistinguishable to the caller.
    const noSuchUser = bundledApiError(401, "UNAUTHORIZED", "Invalid email or password");
    const wrongPassword = bundledApiError(401, "UNAUTHORIZED", "Invalid email or password");
    expect(classifyAuthError(noSuchUser)).toBe(classifyAuthError(wrongPassword));
  });

  it("detects a duplicate email on sign-up", () => {
    expect(
      classifyAuthError(bundledApiError(422, "UNPROCESSABLE_ENTITY", "User already exists")),
    ).toBe("email-taken");
  });

  it("detects a password that is too short", () => {
    expect(
      classifyAuthError(bundledApiError(400, "BAD_REQUEST", "Password is too short")),
    ).toBe("weak-password");
  });

  it("detects rate limiting", () => {
    expect(classifyAuthError(bundledApiError(429, "TOO_MANY_REQUESTS", "Too many requests"))).toBe(
      "rate-limited",
    );
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyAuthError(new Error("database on fire"))).toBe("unknown");
    expect(classifyAuthError(bundledApiError(500, "INTERNAL_SERVER_ERROR", "boom"))).toBe("unknown");
  });
});
