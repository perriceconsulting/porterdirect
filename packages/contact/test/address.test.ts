import { describe, expect, it } from "vitest";
import {
  addressLabels,
  formatAddressInline,
  formatAddressLines,
  missingAddressParts,
  type Address,
} from "../src/address.js";

const US_ADDRESS: Address = {
  line1: "1600 Pennsylvania Avenue NW",
  city: "Washington",
  region: "DC",
  postalCode: "20500",
  country: "US",
};

const GB_ADDRESS: Address = {
  line1: "10 Downing Street",
  city: "London",
  postalCode: "SW1A 2AA",
  country: "GB",
};

describe("labels adapt to the country", () => {
  it("uses American wording for the US", () => {
    const l = addressLabels("US");
    expect(l.region).toBe("State");
    expect(l.postalCode).toBe("ZIP code");
  });

  it("uses local wording elsewhere", () => {
    expect(addressLabels("GB").postalCode).toBe("Postcode");
    expect(addressLabels("GB").city).toBe("Town or city");
    expect(addressLabels("CA").region).toBe("Province");
    expect(addressLabels("AU").city).toBe("Suburb");
  });

  it("falls back to neutral wording rather than American for an unlisted country", () => {
    // Showing "State" and "ZIP code" to a French operator is worse than showing
    // "Region" and "Postal code".
    const l = addressLabels("FR");
    expect(l.region).toBe("Region");
    expect(l.postalCode).toBe("Postal code");
  });

  it("is case-insensitive about the country code", () => {
    expect(addressLabels("gb").postalCode).toBe("Postcode");
  });
});

describe("required parts differ by country", () => {
  it("requires a state and ZIP in the US", () => {
    expect(missingAddressParts({ line1: "1 Main St", city: "Newark" }, "US")).toEqual([
      "region",
      "postalCode",
    ]);
  });

  it("does not require a county in the UK", () => {
    // A UK address is deliverable without one; the postcode carries the routing.
    expect(missingAddressParts({ line1: "10 Downing St", city: "London", postalCode: "SW1A 2AA" }, "GB")).toEqual([]);
  });

  it("always requires a street and a city", () => {
    expect(missingAddressParts({}, "GB")).toContain("line1");
    expect(missingAddressParts({}, "GB")).toContain("city");
  });

  it("treats whitespace as missing", () => {
    expect(missingAddressParts({ line1: "   ", city: " " }, "US")).toContain("line1");
  });

  it("accepts a complete address", () => {
    expect(missingAddressParts(US_ADDRESS, "US")).toEqual([]);
  });

  it("does not validate the SHAPE of a postal code", () => {
    // Formats change, and a regex that rejects a real new postcode blocks a real
    // delivery. Presence is checked; correctness is the postal service's job.
    expect(missingAddressParts({ ...US_ADDRESS, postalCode: "not-a-zip" }, "US")).toEqual([]);
  });
});

describe("rendering follows local convention", () => {
  it("writes a US address with city, state and ZIP on one line", () => {
    expect(formatAddressLines(US_ADDRESS)).toEqual([
      "1600 Pennsylvania Avenue NW",
      "Washington, DC 20500",
    ]);
  });

  it("writes a UK address with the postcode alone on the last line", () => {
    expect(formatAddressLines(GB_ADDRESS)).toEqual([
      "10 Downing Street",
      "London",
      "SW1A 2AA",
    ]);
  });

  it("includes a second line when there is one", () => {
    expect(formatAddressLines({ ...US_ADDRESS, line2: "Suite 4" })[1]).toBe("Suite 4");
  });

  it("omits empty parts rather than leaving stray punctuation", () => {
    // "Newark, " with a dangling comma is how an address label looks wrong.
    const partial: Address = { line1: "1 Main St", city: "Newark", country: "US" };
    expect(formatAddressLines(partial)).toEqual(["1 Main St", "Newark"]);
  });

  it("renders inline for a table cell", () => {
    expect(formatAddressInline(US_ADDRESS)).toBe(
      "1600 Pennsylvania Avenue NW, Washington, DC 20500",
    );
  });
});
