/**
 * Postal addresses.
 *
 * Stored in PARTS, not as one line. A dispatch platform has to answer "which jobs are in
 * this postcode", print a label, hand coordinates to a router and check a serviceable
 * area — none of which can be done by splitting a free-text line after the fact.
 *
 * The parts are deliberately generic (`region`, `postalCode`) rather than American
 * (`state`, `zip`). A schema that says `state` forces every non-US operator to put
 * something that is not a state into a column called state, and the vocabulary then
 * spreads into queries, exports and integrations.
 *
 * What VARIES by country is presentation and expectation, not storage: the label a
 * person reads, whether a region is required at all, and the order the lines print in.
 */
import type { CountryCode } from "libphonenumber-js/min";

export interface Address {
  /** House number and street. */
  readonly line1: string;
  /** Apartment, suite, unit, floor — optional everywhere. */
  readonly line2?: string | null;
  readonly city: string;
  /** State, province, county, prefecture. Not required everywhere. */
  readonly region?: string | null;
  /** ZIP, postcode, PIN. Not used everywhere. */
  readonly postalCode?: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
}

export interface AddressLabels {
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  /** Whether a region must be given for this country. */
  readonly regionRequired: boolean;
  /** Whether a postal code must be given for this country. */
  readonly postalCodeRequired: boolean;
}

const US_LABELS: AddressLabels = {
  line1: "Street address",
  line2: "Apt, suite, unit",
  city: "City",
  region: "State",
  postalCode: "ZIP code",
  regionRequired: true,
  postalCodeRequired: true,
};

/**
 * Per-country wording and requirements.
 *
 * Only countries the product actually serves are listed; everything else falls back to
 * neutral wording rather than being shown American labels. Inventing entries for
 * countries with no operators would be structure the product cannot support.
 */
const LABELS: Partial<Record<string, AddressLabels>> = {
  US: US_LABELS,
  CA: {
    line1: "Street address",
    line2: "Apt, suite, unit",
    city: "City",
    region: "Province",
    postalCode: "Postal code",
    regionRequired: true,
    postalCodeRequired: true,
  },
  GB: {
    line1: "Address line 1",
    line2: "Address line 2",
    city: "Town or city",
    region: "County",
    postalCode: "Postcode",
    // A UK address is deliverable without a county; the postcode carries the routing.
    regionRequired: false,
    postalCodeRequired: true,
  },
  AU: {
    line1: "Street address",
    line2: "Unit, level",
    city: "Suburb",
    region: "State or territory",
    postalCode: "Postcode",
    regionRequired: true,
    postalCodeRequired: true,
  },
  IE: {
    line1: "Address line 1",
    line2: "Address line 2",
    city: "Town or city",
    region: "County",
    postalCode: "Eircode",
    regionRequired: false,
    // Eircodes exist but are still not universally used or known.
    postalCodeRequired: false,
  },
};

const NEUTRAL_LABELS: AddressLabels = {
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "Region",
  postalCode: "Postal code",
  regionRequired: false,
  postalCodeRequired: false,
};

/** Wording and requirements for a country, neutral where we have no specific rules. */
export function addressLabels(country: string): AddressLabels {
  return LABELS[country.toUpperCase()] ?? NEUTRAL_LABELS;
}

export type AddressProblem = "line1" | "city" | "region" | "postalCode";

/**
 * Which required parts are missing?
 *
 * Returns the FIELDS at fault rather than a sentence, so the caller can mark the right
 * inputs. Deliberately does not validate a postal code's shape: formats change, and a
 * regex that rejects a real new postcode blocks a real delivery.
 */
export function missingAddressParts(
  address: Partial<Address>,
  country: string,
): readonly AddressProblem[] {
  const labels = addressLabels(country);
  const missing: AddressProblem[] = [];

  if (!address.line1?.trim()) missing.push("line1");
  if (!address.city?.trim()) missing.push("city");
  if (labels.regionRequired && !address.region?.trim()) missing.push("region");
  if (labels.postalCodeRequired && !address.postalCode?.trim()) missing.push("postalCode");

  return missing;
}

/**
 * Render an address as a person in that country would write it.
 *
 * US puts the region and postal code on one line after the city; GB puts the postcode on
 * its own line last. Getting this wrong produces labels that look foreign to whoever has
 * to read them off a parcel.
 */
export function formatAddressLines(address: Address): readonly string[] {
  const country = address.country.toUpperCase();
  const lines: string[] = [address.line1.trim()];
  if (address.line2?.trim()) lines.push(address.line2.trim());

  const city = address.city.trim();
  const region = address.region?.trim() ?? "";
  const postal = address.postalCode?.trim() ?? "";

  if (country === "GB" || country === "IE") {
    // Town, then county, then the postcode alone on the final line.
    lines.push(city);
    if (region) lines.push(region);
    if (postal) lines.push(postal);
  } else {
    // "Newark, NJ 07102"
    const tail = [city, [region, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    if (tail) lines.push(tail);
  }

  return lines;
}

/** One-line form, for a table cell or a search result. */
export function formatAddressInline(address: Address): string {
  return formatAddressLines(address).join(", ");
}

export type { CountryCode };
