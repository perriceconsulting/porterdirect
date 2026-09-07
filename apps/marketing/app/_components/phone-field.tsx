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
 *   Input is capped by DIGIT COUNT, not string length. Past the longest possible number
 *   the formatter stops matching any plan and silently degrades to appending raw digits,
 *   which reads as "it started formatting and then broke". Refusing the extra digits
 *   keeps the field in a state the formatter can actually render.
 */
import { useState } from "react";
import { formatAsYouType, isValidPhone, type CountryCode } from "@porterdirect/contact";

/** E.164 allows at most 15 digits, country code included. */
const MAX_DIGITS = 15;
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

          // Refuse digits past the longest number that can exist. Without this the
          // formatter gives up and starts appending, which looks like a failure.
          if (digitsOf(next).length > MAX_DIGITS) return;

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
