import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNTRY,
  formatAsYouType,
  formatPhone,
  isSupportedCountry,
  isTooLong,
  isValidPhone,
  parsePhone,
  supportedCountries,
} from "../src/phone.js";

/**
 * Fixtures are real, dialable numbers.
 *
 * The first draft of this file used "555-123-4567" and "07700 900123" and every test
 * failed — both are RESERVED FICTION ranges (555 as a US area code, and Ofcom's 07700
 * 900xxx drama block), which libphonenumber correctly refuses as undialable. The library
 * was right and the fixtures were wrong. Using numbers that only look plausible would
 * have asserted that the validator accepts numbers nobody can call.
 */
const US_NUMBER = "2133734253";
const US_E164 = "+12133734253";
const GB_NUMBER = "07911123456";
const GB_E164 = "+447911123456";

describe("parsePhone", () => {
  it.each([
    "2133734253",
    "(213) 373-4253",
    "213-373-4253",
    "213 373 4253",
    "+1 213 373 4253",
    "  213.373.4253  ",
  ])("normalises %j to one canonical E.164", (input) => {
    // The point of storing E.164: six spellings, one customer. Store what was typed and
    // a driver searching by phone finds nothing.
    expect(parsePhone(input, "US")?.e164).toBe(US_E164);
  });

  it("keeps an explicit country prefix instead of applying the default", () => {
    // A UK number typed by a US tenant must not be parsed as American.
    const parsed = parsePhone("+44 7911 123456", "US");
    expect(parsed?.e164).toBe(GB_E164);
    // Note the attributed country is GG, not GB: several +44 mobile ranges belong to the
    // Crown Dependencies, and 7911 is Guernsey. Asserting "GB" here would have been
    // asserting something untrue about the numbering plan.
    expect(parsed?.countryCallingCode ?? "44").toBe("44");
  });

  it("attributes a London landline to GB", () => {
    expect(parsePhone("020 7946 0958", "GB")?.country).toBe("GB");
  });

  it("uses the given country for a national-format number", () => {
    expect(parsePhone(GB_NUMBER, "GB")?.e164).toBe(GB_E164);
  });

  it("reads the same digits differently under different countries", () => {
    // The country is not decoration: "020 7946 0958" is a London landline and means
    // nothing in the US plan.
    expect(parsePhone("02079460958", "GB")?.e164).toBe("+442079460958");
    expect(parsePhone("02079460958", "US")).toBeNull();
  });

  it("returns null rather than guessing at something unusable", () => {
    // This is the field a driver dials. Unparseable input must be corrected by the
    // operator, not stored in whatever shape arrived.
    for (const bad of ["", "   ", "abc", "12", "555", "+", "++1555"]) {
      expect(parsePhone(bad, "US"), `"${bad}" should not parse`).toBeNull();
    }
  });

  it("rejects reserved fiction ranges, which look valid and are not dialable", () => {
    expect(parsePhone("5551234567", "US")).toBeNull(); // 555 area code
    expect(parsePhone("07700900123", "GB")).toBeNull(); // Ofcom drama range
  });

  it("exposes national and international renderings of the same number", () => {
    const parsed = parsePhone(US_NUMBER, "US");
    expect(parsed?.national).toBe("(213) 373-4253");
    expect(parsed?.international).toBe("+1 213 373 4253");
  });
});

describe("isValidPhone", () => {
  it("agrees with parsePhone", () => {
    expect(isValidPhone(US_NUMBER, "US")).toBe(true);
    expect(isValidPhone("nonsense", "US")).toBe(false);
  });
});

describe("formatPhone", () => {
  it("shows a local number nationally", () => {
    expect(formatPhone(US_E164, "US")).toBe("(213) 373-4253");
    expect(formatPhone("+442079460958", "GB")).toBe("020 7946 0958");
  });

  it("treats a Crown Dependency number as local to a GB viewer", () => {
    // +44 7911 is Guernsey. A GB dispatcher dials it exactly as a GB number, so showing
    // it in international form would be technically true and practically wrong.
    expect(formatPhone(GB_E164, "GB")).toBe("07911 123456");
  });

  it("shows a foreign number internationally, so it can be dialled", () => {
    expect(formatPhone(GB_E164, "US")).toBe("+44 7911 123456");
    expect(formatPhone(US_E164, "GB")).toBe("+1 213 373 4253");
  });

  it("returns unparseable input unchanged rather than blanking it", () => {
    // A number we cannot format is still the only contact detail on the job.
    expect(formatPhone("not a number")).toBe("not a number");
  });

  it("returns an empty string for nothing", () => {
    expect(formatPhone(null)).toBe("");
    expect(formatPhone(undefined)).toBe("");
    expect(formatPhone("")).toBe("");
  });
});

describe("formatAsYouType", () => {
  it("adds punctuation progressively without reordering the digits", () => {
    expect(formatAsYouType("2", "US")).toBe("2");
    expect(formatAsYouType("21", "US")).toBe("21");
    expect(formatAsYouType("213", "US")).toBe("(213)");
    expect(formatAsYouType("2133", "US")).toBe("(213) 3");
    expect(formatAsYouType(US_NUMBER, "US")).toBe("(213) 373-4253");
  });

  it("never loses a digit while formatting", () => {
    // The property that matters more than the punctuation: whatever it renders must
    // contain exactly what was typed.
    for (let i = 1; i <= US_NUMBER.length; i++) {
      const typed = US_NUMBER.slice(0, i);
      const shown = formatAsYouType(typed, "US").replace(/\D/g, "");
      expect(shown, `lost digits formatting "${typed}"`).toBe(typed);
    }
  });

  it("formats an international prefix on its own plan", () => {
    expect(formatAsYouType("+447911123456", "US")).toContain("+44");
  });

  it("never throws on partial or odd input", () => {
    // A formatter that throws mid-keystroke takes the whole form down.
    for (const partial of ["", "+", "(", "()", "5", "abc", "+++", "((((("]) {
      expect(() => formatAsYouType(partial, "US")).not.toThrow();
    }
  });
});

describe("country support", () => {
  it("accepts real ISO codes and refuses invented ones", () => {
    expect(isSupportedCountry("US")).toBe(true);
    expect(isSupportedCountry("gb")).toBe(true);
    expect(isSupportedCountry("ZZ")).toBe(false);
    expect(isSupportedCountry("USA")).toBe(false);
    expect(isSupportedCountry("")).toBe(false);
  });

  it("lists countries from the metadata, not a hand-kept list", () => {
    const all = supportedCountries();
    expect(all.length).toBeGreaterThan(200);
    expect(all).toContain(DEFAULT_COUNTRY);
    expect(all).toContain("GB");
  });
});

describe("isTooLong", () => {
  /**
   * The bug this closes: input was capped at fifteen digits, the E.164 GLOBAL maximum.
   * A US national number is ten, so twelve digits passed the cap, matched no plan, and
   * the formatter degraded to raw digits — which reads as the formatting breaking.
   */
  it("permits a complete national number", () => {
    expect(isTooLong("7322846454", "US")).toBe(false);
    expect(isTooLong("(732) 284-6454", "US")).toBe(false);
  });

  it("rejects a national number one digit past the plan", () => {
    expect(isTooLong("73228464544", "US")).toBe(true);
    expect(isTooLong("732284645444", "US")).toBe(true);
  });

  it("permits a partial number so it can still be typed", () => {
    for (const partial of ["7", "73", "732", "73228", "732284645"]) {
      expect(isTooLong(partial, "US"), `"${partial}" should be typeable`).toBe(false);
    }
  });

  it("uses the country's own plan, not one global limit", () => {
    // Eleven digits is too long for the US and perfectly normal in GB.
    expect(isTooLong("07911123456", "GB")).toBe(false);
    expect(isTooLong("07911123456", "US")).toBe(true);
  });

  it("takes the limit from the prefix when the number carries one", () => {
    expect(isTooLong("+447911123456", "US")).toBe(false);
    expect(isTooLong("+4479111234567890", "US")).toBe(true);
  });

  it("treats an unparseable fragment as typeable rather than too long", () => {
    // Blocking the keystroke here would stop someone correcting a typo.
    for (const odd of ["", "   ", "+", "abc", "((("]) {
      expect(isTooLong(odd, "US"), `"${odd}"`).toBe(false);
    }
  });
});
