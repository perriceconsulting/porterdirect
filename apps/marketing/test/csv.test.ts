/**
 * CSV writing, and the thing that makes it a security concern rather than a formatting one.
 *
 * These files are handed to a hospital's procurement team and opened in Excel. Every value
 * in them is attacker-influenced: a dispatcher types the customer name and the delivery
 * note today, and once customers book their own jobs they type them directly. A cell that
 * begins `=`, `+`, `-`, `@`, tab or carriage return is evaluated as a FORMULA on open, so
 * an export is a delivery mechanism unless something stops it.
 */
import { describe, expect, it } from "vitest";
import { csvDocument, csvField, csvRow, csvTimestamp, neutralizeFormula } from "../lib/csv";

describe("formula injection", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ['=HYPERLINK("https://evil.example","Invoice")', `'=HYPERLINK("https://evil.example","Invoice")`],
    ["+1234567890", "'+1234567890"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
    ["\tstarts with tab", "'\tstarts with tab"],
    ["\rstarts with CR", "'\rstarts with CR"],
  ])("neutralises %j", (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it("leaves ordinary text completely alone", () => {
    // The prefix is visible in the cell, so it must not be applied to values that were
    // never going to be interpreted. A courier's export should not be littered with
    // apostrophes.
    for (const ordinary of [
      "ORD-7X4KMQ",
      "Marisol Vega",
      "811 W 7th St",
      "Los Angeles",
      "nobody home",
      "$48.50",
      "2026-09-10T04:00:00.000Z",
      "",
    ]) {
      expect(neutralizeFormula(ordinary)).toBe(ordinary);
    }
  });

  it("still neutralises when the value also needs quoting", () => {
    // Both problems at once: a formula that contains a comma. The apostrophe goes inside
    // the quotes, where the spreadsheet will see it.
    expect(csvField("=SUM(1,2)")).toBe(`"'=SUM(1,2)"`);
  });

  it("does not treat a negative NUMBER as a formula", () => {
    // Numbers are passed through as numbers. Quoting -5 would make a numeric column
    // stop summing, which is the sort of "safety" that gets the guard removed.
    expect(csvField(-5)).toBe("-5");
  });
});

describe("quoting", () => {
  it("quotes a value containing a comma", () => {
    expect(csvField("Vega, Marisol")).toBe('"Vega, Marisol"');
  });

  it("doubles embedded quotes", () => {
    expect(csvField('He said "leave it at the door"')).toBe('"He said ""leave it at the door"""');
  });

  it("quotes a value containing a newline", () => {
    // Driver notes routinely contain these, and an unquoted newline silently splits one
    // delivery into two rows — a corruption that looks like missing data, not like a bug.
    expect(csvField("Gate code 1234\nRing twice")).toBe('"Gate code 1234\nRing twice"');
  });

  it("leaves a plain value unquoted", () => {
    expect(csvField("ORD-7X4KMQ")).toBe("ORD-7X4KMQ");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
});

describe("documents", () => {
  it("uses CRLF, as RFC 4180 and Excel expect", () => {
    const doc = csvDocument(["A", "B"], [["1", "2"]]);
    expect(doc).toBe("A,B\r\n1,2\r\n");
  });

  it("keeps a header with no rows, so an empty period is still a valid file", () => {
    // An empty export must be a readable document that says "nothing happened", not a
    // zero-byte file that reads as a failed download.
    expect(csvDocument(["Reference", "Status"], [])).toBe("Reference,Status\r\n");
  });

  it("writes one row per record", () => {
    const doc = csvRow(["a", 1, null, "x,y"]);
    expect(doc).toBe('a,1,,"x,y"');
  });
});

describe("timestamps", () => {
  it("writes ISO 8601 UTC", () => {
    expect(csvTimestamp(new Date("2026-09-10T04:05:06.000Z"))).toBe("2026-09-10T04:05:06.000Z");
  });

  it("writes an empty cell for a missing date, never a fake one", () => {
    expect(csvTimestamp(null)).toBe("");
    expect(csvTimestamp(undefined)).toBe("");
  });

  it("writes an empty cell for an invalid date rather than 'Invalid Date'", () => {
    // The shape that already bit this repo once, via Stripe: `new Date(undefined * 1000)`
    // is an Invalid Date that survives until something renders it.
    expect(csvTimestamp(new Date(Number.NaN))).toBe("");
  });
});
