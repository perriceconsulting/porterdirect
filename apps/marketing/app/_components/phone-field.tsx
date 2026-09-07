"use client";

/**
 * Phone input that formats as you type.
 *
 * The behaviour genuinely cannot exist without JavaScript — punctuation has to appear
 * between keystrokes — but it degrades rather than breaking. With JS disabled this is an
 * ordinary `tel` input, whatever is typed still submits, and the SERVER normalises to
 * E.164. The formatting here is a convenience, never what makes the value correct.
 *
 * Two behaviours are deliberate and were both learned the hard way:
 *
 *   Deletions are NOT reformatted. Formatting a deletion re-inserts the punctuation the
 *   user is removing, so backspace appears to do nothing.
 *
 *   Input is capped by the COUNTRY'S OWN plan length, not a fixed number of digits. Past
 *   the longest number that plan allows, the formatter stops matching and degrades to
 *   appending raw digits, which reads as "it started formatting and then broke".
 */
import { useState } from "react";
import {
  formatAsYouType,
  isTooLong,
  isValidPhone,
  type CountryCode,
} from "@porterdirect/contact";

/** Below this there is nothing to judge yet, so saying "invalid" would just be nagging. */
const MIN_DIGITS_BEFORE_JUDGING = 7;

const digitsOf = (value: string): string => value.replace(/\D/g, "");

/**
 * "United States", not "US". The code is what we store; a person reading an error should
 * see the country's name. Falls back to the code where the browser has no display name.
 */
function countryName(code: CountryCode): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function PhoneField({
  name,
  label,
  country,
  hint,
  defaultValue = "",
  required = false,
}: {
  name: string;
  label: string;
  country: CountryCode;
  hint?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const id = `phone-${name}`;
  const hintId = `${id}-hint`;

  const digits = digitsOf(value);
  const looksComplete = digits.length >= MIN_DIGITS_BEFORE_JUDGING;
  const valid = value !== "" && isValidPhone(value, country);
  const showProblem = looksComplete && !valid;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required={required}
        aria-invalid={showProblem || undefined}
        aria-describedby={hintId}
        value={value}
        onChange={(event) => {
          const next = event.target.value;

          // Deleting: take it verbatim, or backspace fights the formatter.
          if (next.length < value.length) {
            setValue(next);
            return;
          }

          // Refuse a digit that would take the number past its own plan's length.
          //
          // NOT a fixed cap: fifteen is the E.164 GLOBAL maximum, while a US national
          // number is ten. Capping at fifteen let twelve digits through, matched no
          // plan, and the formatter degraded to raw digits — which reads exactly like
          // the formatting breaking. The limit comes from the metadata per country.
          if (isTooLong(next, country)) return;

          setValue(formatAsYouType(next, country));
        }}
      />
      <span className={showProblem ? "hint hint-problem" : "hint"} id={hintId}>
        {showProblem
          // The country name reads as a modifier ("a valid United States number") rather
          // than after a preposition, which would need an article that is right for
          // "the United States" and wrong for "France".
          ? `That does not look like a valid ${countryName(country)} number. Check the digits, or start with + and a country code.`
          : hint}
      </span>
    </div>
  );
}
