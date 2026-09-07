/**
 * Phone numbers.
 *
 * ONE canonical stored form — E.164, e.g. `+15551234567` — and many displayed forms.
 * Storing what someone typed means "(555) 123-4567", "555-123-4567" and "5551234567"
 * become three different customers, none of which match when a driver searches, and
 * none of which can be handed to a masked-calling provider without guessing.
 *
 * Formatting is NOT hand-rolled. Numbering plans are genuinely irregular — variable
 * trunk prefixes, variable national lengths, area codes that overlap between countries —
 * and a hand-written formatter mangles real numbers in exactly the markets a white-label
 * platform expands into. libphonenumber-js carries Google's metadata; the `/min` build
 * is used because full formatting metadata is far larger than this needs.
 */
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isSupportedCountry as isSupportedByMetadata,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from "libphonenumber-js/min";

export type { CountryCode };

/** Fallback when a tenant has not stated one. Explicit, not implied by locale. */
export const DEFAULT_COUNTRY: CountryCode = "US";

export interface ParsedPhone {
  /** Canonical storage form: +15551234567 */
  readonly e164: string;
  /** How a person in that country would write it: (555) 123-4567 */
  readonly national: string;
  /** How it should be written to someone abroad: +1 555 123 4567 */
  readonly international: string;
  readonly country: CountryCode | undefined;
  /** e.g. "44" — what actually determines how a number is dialled. */
  readonly countryCallingCode: string;
}

/**
 * Parse what a person typed into a canonical number.
 *
 * Returns null rather than guessing. A number that cannot be parsed must surface as a
 * correction the operator makes, not a value silently stored in whatever shape arrived —
 * this is the field a driver will call from.
 */
export function parsePhone(
  input: string,
  country: CountryCode = DEFAULT_COUNTRY,
): ParsedPhone | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // An explicit + means the number carries its own country; the default must not
  // override it, or a UK number entered by a US tenant is parsed as American.
  const parsed = parsePhoneNumberFromString(
    trimmed,
    trimmed.startsWith("+") ? undefined : country,
  );
  if (!parsed || !parsed.isValid()) return null;

  return {
    e164: parsed.number,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
    country: parsed.country,
    countryCallingCode: parsed.countryCallingCode,
  };
}

/** Is this a number we could actually dial? */
export function isValidPhone(input: string, country: CountryCode = DEFAULT_COUNTRY): boolean {
  return parsePhone(input, country) !== null;
}

/**
 * Format a stored number for display.
 *
 * Shown nationally when it belongs to the viewing tenant's country and internationally
 * when it does not — which is what someone about to dial actually needs to know.
 * Unparseable input is returned unchanged rather than blanked: a number we cannot format
 * is still the only contact detail on the job.
 */
export function formatPhone(
  e164: string | null | undefined,
  viewerCountry: CountryCode = DEFAULT_COUNTRY,
): string {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;

  // Compared by CALLING CODE, not country. Several +44 mobile ranges belong to the
  // Crown Dependencies — 7911 is Guernsey — and a GB viewer dials those exactly as they
  // dial a GB number. Comparing countries would show a neighbour's number in
  // international form to someone who would never dial it that way. The same holds
  // across the whole +1 plan.
  let viewerCallingCode: string;
  try {
    viewerCallingCode = getCountryCallingCode(viewerCountry);
  } catch {
    return parsed.formatInternational();
  }

  return parsed.countryCallingCode === viewerCallingCode
    ? parsed.formatNational()
    : parsed.formatInternational();
}

/**
 * Format a partial number as it is being typed.
 *
 * Deliberately never rejects or reorders: a formatter that fights the caret makes a
 * field unusable. It only adds the punctuation the country's plan implies, and returns
 * the raw input unchanged for anything it cannot shape yet.
 */
export function formatAsYouType(
  input: string,
  country: CountryCode = DEFAULT_COUNTRY,
): string {
  if (!input) return "";
  // An international prefix formats on its own plan, not the tenant's.
  const formatter = new AsYouType(input.startsWith("+") ? undefined : country);
  return formatter.input(input);
}

/**
 * ISO 3166-1 alpha-2, checked against the library's own metadata rather than a list
 * kept by hand here — a hand-kept list drifts the moment a numbering plan changes.
 */
export function isSupportedCountry(code: string): code is CountryCode {
  return isSupportedByMetadata(code.toUpperCase());
}

/** Every country the metadata covers, for a settings picker. */
export function supportedCountries(): readonly CountryCode[] {
  return getCountries();
}

/**
 * Is this already longer than any number in the relevant plan?
 *
 * The distinction matters more than it looks. E.164 allows fifteen digits GLOBALLY, but
 * a US national number is ten — so capping input at fifteen lets someone type twelve
 * digits, at which point no plan matches and the formatter degrades to raw digits. It
 * reads exactly like the formatting has broken.
 *
 * The limit therefore comes from the metadata for the actual country (or from the
 * number's own prefix when it carries one), never from a constant kept here.
 */
export function isTooLong(input: string, country: CountryCode = DEFAULT_COUNTRY): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  try {
    const result = trimmed.startsWith("+")
      ? validatePhoneNumberLength(trimmed)
      : validatePhoneNumberLength(trimmed, country);
    return result === "TOO_LONG";
  } catch {
    // An unparseable fragment is not "too long" — it is just not a number yet, and
    // blocking the keystroke would stop someone correcting it.
    return false;
  }
}
