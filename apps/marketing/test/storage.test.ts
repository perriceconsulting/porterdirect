/**
 * Object-storage rules for proof-of-delivery evidence.
 *
 * Presigning is a local HMAC — no network — so everything here runs offline against
 * throwaway credentials. That matters: the rules this file protects are the ones that
 * decide what a device is allowed to write into a bucket we later serve back, and a test
 * that needed real credentials would be skipped in CI and stop protecting anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROOF_BYTES,
  StorageNotConfiguredError,
  isAllowedContentType,
  isStorageConfigured,
  presignProofUpload,
} from "../lib/storage";

const REAL = { ...process.env };

const CONFIG = {
  STORAGE_S3_ENDPOINT: "https://example-branch.storage.c-5.us-east-2.aws.neon.tech",
  STORAGE_REGION: "us-east-2",
  STORAGE_BUCKET: "porterdirect-pod",
  STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE",
  STORAGE_SECRET_ACCESS_KEY: "not-a-real-secret-only-used-to-sign-locally",
};

beforeEach(() => {
  Object.assign(process.env, CONFIG);
});

afterEach(() => {
  for (const key of Object.keys(CONFIG)) {
    if (REAL[key] === undefined) delete process.env[key];
    else process.env[key] = REAL[key];
  }
});

const upload = (over: Partial<Parameters<typeof presignProofUpload>[0]> = {}) =>
  presignProofUpload({
    tenantId: "11111111-1111-1111-1111-111111111111",
    orderId: "22222222-2222-2222-2222-222222222222",
    kind: "photo",
    contentType: "image/jpeg",
    contentLength: 1024,
    ...over,
  });

describe("content types are an allowlist", () => {
  it("accepts what a camera or a signature pad produces", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp"]) {
      expect(isAllowedContentType(t), t).toBe(true);
    }
  });

  it("refuses everything else, including things that merely look like images", () => {
    // An allowlist rather than a denylist, because this decides what can be written into
    // a bucket the app serves back. SVG is the one that catches people out: it is an
    // image to a user and a script host to a browser.
    for (const t of ["image/svg+xml", "text/html", "application/pdf", "image/gif", ""]) {
      expect(isAllowedContentType(t), t).toBe(false);
    }
  });
});

describe("size limits leave with the URL", () => {
  it("refuses a file larger than the cap", async () => {
    await expect(upload({ contentLength: MAX_PROOF_BYTES + 1 })).rejects.toThrow(/larger than/i);
  });

  it("allows a full-resolution phone photo", async () => {
    // The point of the feature. A cap that rejected 8MB would fail on exactly the good
    // cameras — the worst possible failure curve for evidence.
    await expect(upload({ contentLength: 8 * 1024 * 1024 })).resolves.toBeTruthy();
  });

  it("refuses a zero or negative length", async () => {
    for (const len of [0, -1, 1.5]) {
      await expect(upload({ contentLength: len }), String(len)).rejects.toThrow();
    }
  });

  it("signs the declared length into the URL", async () => {
    // So the holder of a signed URL cannot upload something larger than they declared:
    // the limit survives leaving our process, which is the only place we still control.
    const { url } = await upload({ contentLength: 4242 });
    expect(url).toMatch(/content-length/i);
  });
});

describe("object keys", () => {
  it("are scoped by tenant, then order", async () => {
    // Tenant FIRST so a bucket listing segregates by licensee and a per-tenant export or
    // retention policy has a prefix to work with.
    const { key } = await upload();
    expect(key.startsWith("tenants/11111111-1111-1111-1111-111111111111/orders/")).toBe(true);
    expect(key).toContain("/orders/22222222-2222-2222-2222-222222222222/");
  });

  it("cannot be guessed from the order id alone", async () => {
    // Belt and braces behind a private bucket: a leaked key should not follow from a
    // leaked order reference.
    const a = await upload();
    const b = await upload();
    expect(a.key).not.toBe(b.key);
  });

  it("name the kind and carry a matching extension", async () => {
    const photo = await upload({ kind: "photo", contentType: "image/jpeg" });
    const sig = await upload({ kind: "signature", contentType: "image/png" });
    expect(photo.key).toMatch(/\/photo-[0-9a-f-]+\.jpg$/);
    expect(sig.key).toMatch(/\/signature-[0-9a-f-]+\.png$/);
  });

  it("never contain a traversal sequence", async () => {
    const { key } = await upload();
    expect(key).not.toContain("..");
    expect(key.startsWith("/")).toBe(false);
  });
});

describe("configuration is reported, not guessed at", () => {
  it("names the missing variables and none of their values", async () => {
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
    const err = await upload().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageNotConfiguredError);
    expect(String(err)).toContain("STORAGE_SECRET_ACCESS_KEY");
    // The whole point of naming variables rather than dumping config.
    expect(String(err)).not.toContain(CONFIG.STORAGE_ACCESS_KEY_ID);
  });

  it("lets a surface ask before it throws at a user", () => {
    expect(isStorageConfigured()).toBe(true);
    delete process.env.STORAGE_BUCKET;
    expect(isStorageConfigured()).toBe(false);
  });
});

describe("the presigned URL", () => {
  it("addresses the bucket by PATH, not by virtual host", async () => {
    // Neon's endpoint does not resolve `<bucket>.<endpoint>`; without path style every
    // upload fails DNS, which reads like a network fault rather than a config one.
    const { url, key } = await upload();
    expect(url).toContain(`/${CONFIG.STORAGE_BUCKET}/${key.split("/")[0]}`);
    expect(url.startsWith(`${CONFIG.STORAGE_S3_ENDPOINT}/${CONFIG.STORAGE_BUCKET}/`)).toBe(true);
  });

  it("expires", async () => {
    const { url } = await upload();
    expect(url).toMatch(/X-Amz-Expires=\d+/);
    const expires = Number(/X-Amz-Expires=(\d+)/.exec(url)?.[1]);
    // Long enough to upload a photo on a bad connection, short enough that a URL copied
    // out of devtools is useless by the time anyone pastes it.
    expect(expires).toBeGreaterThan(0);
    expect(expires).toBeLessThanOrEqual(600);
  });
});
