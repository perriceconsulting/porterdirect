/**
 * The delivery certificate, and the promise it has to keep.
 *
 * This is the first artifact that leaves the platform and reaches a tenant's OWN customer,
 * which makes it the first real test of "100% platform anonymity" — a bullet on the
 * Agency tier that has never had anything enforcing it.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildProofPdf, type ProofPdfInput } from "../lib/proof-pdf";

/** A 1x1 PNG. Real image bytes, so embedding is genuinely exercised. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const BASE: ProofPdfInput = {
  operatorName: "Acme Couriers",
  operatorDomain: "dispatch.acmecouriers.com",
  reference: "ORD-9GTFF6",
  customerName: "Marisol Vega",
  pickupLines: ["811 W 7th St", "Los Angeles, CA 90017"],
  dropoffLines: ["1355 N Highland Ave", "Los Angeles, CA 90028"],
  recipientName: "J. Alvarez",
  capturedAt: new Date("2026-09-09T14:32:00Z"),
  lat: "34.098765",
  lng: "-118.329876",
  accuracyM: 12,
  signature: new Uint8Array(PNG),
  photo: new Uint8Array(PNG),
};

const build = (over: Partial<ProofPdfInput> = {}) => buildProofPdf({ ...BASE, ...over });

/**
 * Everything readable in the file: the raw bytes (which carry the METADATA as plain
 * strings) plus every decompressed content stream (which carries the DRAWN TEXT).
 *
 * Searching raw bytes alone is not enough — pdf-lib Flate-compresses content streams, so
 * a naive scan finds the metadata and none of the page. Getting that wrong would make the
 * anonymity assertions pass while looking at almost nothing, which is worse than not
 * having them. Text is emitted per glyph-run, so runs are joined before searching.
 */
function asText(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf);
  const raw = buf.toString("latin1");
  let out = raw;

  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      const inflated = inflateSync(buf.subarray(start, end)).toString("latin1");
      // Two encodings, and missing the second is how this extractor first read nothing:
      // pdf-lib emits text as HEX strings — `<41636D65...> Tj` — not the parenthesised
      // literals a PDF may also use. Both are decoded so the assertions see the page
      // whichever form the library picks.
      const literals = [...inflated.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]);
      const hex = [...inflated.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((x) =>
        Buffer.from(x[1]!.replace(/\s/g, ""), "hex").toString("latin1"),
      );
      out += "\n" + literals.join("") + hex.join("");
    } catch {
      // Not a Flate stream (an embedded image, say). Nothing to read here.
    }
  }
  return out;
}

describe("the certificate is a real PDF", () => {
  it("starts with the PDF magic bytes", async () => {
    const pdf = await build();
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("embeds both images without complaint", async () => {
    const withImages = await build();
    const without = await build({ signature: null, photo: null });
    // Embedding real bytes must make the document larger — otherwise the images were
    // silently dropped and the certificate proves nothing.
    expect(withImages.byteLength).toBeGreaterThan(without.byteLength);
  });

  it("still renders when a photo is missing", async () => {
    // A receipt that refuses to exist because one image is unreachable is worse than one
    // that says the photo was not captured.
    const pdf = await build({ photo: null });
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(asText(pdf)).toContain("Not captured");
  });

  it("the text extractor actually reads the page, not just the metadata", async () => {
    // Guards the guard. If inflation silently failed, every assertion below would be
    // searching the metadata alone and would pass while testing almost nothing.
    const text = asText(await build());
    expect(text).toContain("Proof of delivery");
    expect(text).toContain("DELIVERED TO");
  });
});

describe("platform anonymity", () => {
  it("names the OPERATOR, never us, anywhere in the file", async () => {
    const text = asText(await build());
    // The bullet the Agency tier is sold on, finally enforced rather than promised.
    expect(text).not.toMatch(/PorterDirect/i);
    expect(text).not.toMatch(/porterdirect\.com/i);
    expect(text).toContain("Acme Couriers");
  });

  it("keeps our name and the library's out of the METADATA too", async () => {
    // Producer and Creator are invisible on the page and trivially readable. An anonymity
    // promise that holds until someone opens Document Properties is not a promise.
    const text = asText(await build());
    expect(text).not.toMatch(/pdf-lib/i);
    expect(text).toContain("Acme Couriers");
  });

  it("carries the operator's own domain as the letterhead", async () => {
    expect(asText(await build())).toContain("dispatch.acmecouriers.com");
  });

  it("survives an operator with no domain yet", async () => {
    const pdf = await build({ operatorDomain: null });
    expect(asText(pdf)).toContain("Acme Couriers");
    expect(pdf.byteLength).toBeGreaterThan(0);
  });
});

describe("what the certificate states", () => {
  it("carries the reference, the recipient and both addresses", async () => {
    const text = asText(await build());
    for (const needle of [
      "ORD-9GTFF6",
      "J. Alvarez",
      "Marisol Vega",
      "1355 N Highland Ave",
      "811 W 7th St",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("says so plainly when no recipient name was taken", async () => {
    // "Not recorded" is a fact. A blank line is an invitation to assume.
    expect(asText(await build({ recipientName: null }))).toContain("Not recorded");
  });

  it("says so plainly when no location was captured", async () => {
    const text = asText(await build({ lat: null, lng: null, accuracyM: null }));
    expect(text).toContain("Location not recorded");
  });

  it("reports accuracy with the fix, because a fix without it is not evidence", async () => {
    expect(asText(await build())).toContain("12m");
  });

  it("states what the document certifies and who stands behind it", async () => {
    const text = asText(await build());
    expect(text).toContain("certifies delivery");
    expect(text).toContain("Acme Couriers");
  });
});
