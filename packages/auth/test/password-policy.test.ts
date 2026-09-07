import { describe, it, expect } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  NIST_POLICY,
  PCI_DSS_POLICY,
  checkPassword,
  describeVerdict,
  isBreachedPassword,
  policyByName,
} from "../src/password-policy.js";

describe("length rules", () => {
  it(`rejects anything under ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(checkPassword("short").reasons).toContain("too-short");
    expect(checkPassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).reasons).toContain("too-short");
  });

  it("accepts exactly the minimum length", () => {
    // Not "a".repeat(12) — that is now correctly refused as repetitive, and using it
    // here would have asserted that a terrible password is acceptable. A boundary test
    // needs a password that is ONLY interesting for its length.
    const twelve = "moth quilt v";
    expect([...twelve].length).toBe(MIN_PASSWORD_LENGTH);
    expect(checkPassword(twelve).ok).toBe(true);
  });

  it("allows a long passphrase — length is the point", () => {
    expect(checkPassword("correct horse battery staple and then some more words").ok).toBe(true);
  });

  it(`rejects beyond ${MAX_PASSWORD_LENGTH} characters`, () => {
    expect(checkPassword("a".repeat(MAX_PASSWORD_LENGTH + 1)).reasons).toContain("too-long");
  });

  it("counts code points, not UTF-16 units", () => {
    // Twelve emoji are twelve characters to a person; `.length` would say twenty-four
    // and let an eight-character password through as if it were sixteen.
    const twelveEmoji = "🔒".repeat(12);
    expect([...twelveEmoji].length).toBe(12);
    expect(checkPassword(twelveEmoji).reasons).not.toContain("too-short");

    const sixEmoji = "🔒".repeat(6);
    expect(sixEmoji.length).toBe(12); // what a naive check would see
    expect(checkPassword(sixEmoji).reasons).toContain("too-short");
  });
});

describe("no composition rules — deliberately", () => {
  it.each([
    // Not "abcdefghijklmnop" — that is the alphabet, now refused as sequential.
    ["all lowercase letters", "moth quilt vantage"],
    ["a spaced passphrase", "several plain english words here"],
    ["no digits or symbols", "thequickbrownfoxjumps"],
  ])("accepts %s", (_label, password) => {
    // NIST SP 800-63B: composition rules produce "Password1!" and encourage reuse.
    // Their absence here is a decision, so it is asserted rather than assumed.
    expect(checkPassword(password).ok).toBe(true);
  });

  it("accepts spaces and Unicode without mangling them", () => {
    expect(checkPassword("kääk sana lause pitkä").ok).toBe(true);
  });
});

describe("contextual rejections", () => {
  it("refuses a password containing the account's own email local part", () => {
    const verdict = checkPassword("percival-is-here", { email: "percival@example.com" });
    expect(verdict.reasons).toContain("contains-email");
  });

  it("ignores a very short local part rather than rejecting everything", () => {
    // "jo@x.com" would otherwise reject any password containing "jo".
    expect(checkPassword("jonquil meadows apart", { email: "jo@example.com" }).ok).toBe(true);
  });

  it("refuses the product name", () => {
    expect(checkPassword("porterdirect2026").reasons).toContain("contains-product-name");
    expect(checkPassword("Porter Direct Rocks").reasons).toContain("contains-product-name");
  });

  it("refuses a long-but-common password the minimum would otherwise allow", () => {
    expect(checkPassword("passwordpassword").reasons).toContain("too-common");
  });

  it("rejects whitespace-only input", () => {
    expect(checkPassword("               ").reasons).toContain("whitespace-only");
  });
});

describe("breach check (k-anonymity)", () => {
  const sha1Hex = async () => "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"; // "password"

  it("only ever sends the first five hash characters", async () => {
    let sent = "";
    await isBreachedPassword("password", {
      sha1Hex,
      fetchRange: async (prefix) => {
        sent = prefix;
        return "";
      },
    });
    // The password and the full hash must never leave this process.
    expect(sent).toBe("5BAA6");
    expect(sent).toHaveLength(5);
  });

  it("detects a hit by matching the suffix locally", async () => {
    const found = await isBreachedPassword("password", {
      sha1Hex,
      fetchRange: async () => "1E4C9B93F3F0682250B6CF8331B7EE68FD8:99999\nAAAAAAA:1",
    });
    expect(found).toBe(true);
  });

  it("reports clean when the suffix is absent", async () => {
    const found = await isBreachedPassword("password", {
      sha1Hex,
      fetchRange: async () => "0000000000000000000000000000000000:1",
    });
    expect(found).toBe(false);
  });

  it("fails OPEN when the service is unreachable", async () => {
    // Blocking every signup because a third-party list is down is the worse failure;
    // the synchronous rules still apply.
    const found = await isBreachedPassword("password", {
      sha1Hex,
      fetchRange: async () => {
        throw new Error("network down");
      },
    });
    expect(found).toBe(false);
  });
});

describe("describeVerdict", () => {
  it("returns null when the password is fine", () => {
    expect(describeVerdict(checkPassword("a perfectly fine passphrase"))).toBeNull();
  });

  it("phrases the first problem for a person", () => {
    expect(describeVerdict(checkPassword("short"))).toContain("at least 12");
  });
});

describe("low-entropy rejections (NIST names these explicitly)", () => {
  it.each([
    ["a single repeated character", "aaaaaaaaaaaa"],
    ["two alternating characters", "abababababab"],
    ["a long run of one character", "meadowaaaaalantern"],
  ])("rejects %s as repetitive", (_label, password) => {
    expect(checkPassword(password).reasons).toContain("repetitive");
  });

  it.each([
    ["the alphabet", "abcdefghijkl"],
    ["a descending run", "ponmlkjihgfe"],
    ["a keyboard row", "qwertyuiopas"],
    ["a keyboard row reversed", "poiuytrewqas"],
    ["a digit run inside a phrase", "meadow1234567lantern"],
  ])("rejects %s as sequential", (_label, password) => {
    expect(checkPassword(password).reasons).toContain("sequential");
  });

  it("does not reject ordinary passphrases as sequential or repetitive", () => {
    // The threshold matters: too eager and real passwords fail. These must all pass.
    for (const good of [
      "meadow lantern cobble drift",
      "correct horse battery staple",
      "the quick brown fox jumped",
      "Tr0ub4dor&3xample",
    ]) {
      const verdict = checkPassword(good);
      expect(verdict.reasons, `false positive on "${good}"`).not.toContain("sequential");
      expect(verdict.reasons, `false positive on "${good}"`).not.toContain("repetitive");
    }
  });
});

describe("configurable composition (compliance, not security)", () => {
  const PHRASE = "meadow lantern cobble drift";

  it("accepts a letters-only passphrase under the default NIST policy", () => {
    expect(checkPassword(PHRASE, {}, NIST_POLICY).ok).toBe(true);
  });

  it("refuses that same passphrase under PCI DSS, which mandates a digit", () => {
    // PCI DSS 4.0 §8.3.6: twelve characters AND both numeric and alphabetic. An auditor
    // reading that checklist is not persuaded by a citation of NIST.
    const verdict = checkPassword(PHRASE, {}, PCI_DSS_POLICY);
    expect(verdict.reasons).toContain("missing-digit");
  });

  it("accepts a passphrase with a digit under PCI DSS", () => {
    expect(checkPassword("meadow lantern cobble drift 7", {}, PCI_DSS_POLICY).ok).toBe(true);
  });

  it("does not mandate symbols or mixed case under PCI DSS", () => {
    // A policy stricter than the standard it cites is still a policy nobody chose.
    expect(PCI_DSS_POLICY.requireSymbol).toBe(false);
    expect(PCI_DSS_POLICY.requireMixedCase).toBe(false);
  });

  it("reports every unmet requirement, not just the first", () => {
    const strict = {
      ...NIST_POLICY,
      requireDigit: true,
      requireSymbol: true,
      requireMixedCase: true,
    };
    const reasons = checkPassword("meadow lantern cobble", {}, strict).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining(["missing-digit", "missing-symbol", "missing-mixed-case"]),
    );
  });

  it("selects a policy by name, defaulting to NIST for anything unrecognised", () => {
    expect(policyByName("pci")).toBe(PCI_DSS_POLICY);
    expect(policyByName("PCI")).toBe(PCI_DSS_POLICY);
    expect(policyByName("nist")).toBe(NIST_POLICY);
    expect(policyByName(undefined)).toBe(NIST_POLICY);
    // Unrecognised must fall back to a real policy, never to "no policy".
    expect(policyByName("whatever")).toBe(NIST_POLICY);
  });

  it("counts Unicode letters and digits, not just ASCII", () => {
    const pci = checkPassword("meadow lantern ünïcode ٧", {}, PCI_DSS_POLICY);
    expect(pci.reasons).not.toContain("missing-letter");
    expect(pci.reasons).not.toContain("missing-digit");
  });
});
