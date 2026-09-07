"use client";

/**
 * Phone input that formats as you type.
 *
 * The second client component in the project, and like the first it is here because the
 * behaviour genuinely cannot exist without JavaScript: punctuation has to appear between
 * keystrokes.
 *
 * It degrades rather than breaking. With JS disabled this is an ordinary `tel` input,
 * whatever is typed still submits, and the SERVER normalises it to E.164 — the formatting
 * here is a convenience, never the thing that makes the value correct.
 */
import { useState } from "react";
import { formatAsYouType, type CountryCode } from "@porterdirect/contact";

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
        // A cap, because nothing else stops forty digits being typed. The longest E.164
        // number is 15 digits; 24 leaves generous room for punctuation and a country
        // prefix while refusing obvious nonsense before it reaches the server.
        maxLength={24}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          // Only format when ADDING characters. Formatting a deletion re-inserts the
          // punctuation the user is trying to remove, so backspace appears to do
          // nothing — the single most common way an as-you-type field becomes unusable.
          if (next.length < value.length) {
            setValue(next);
            return;
          }
          setValue(formatAsYouType(next, country));
        }}
      />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
