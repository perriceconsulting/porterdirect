"use client";

/**
 * Password input with a show/hide toggle.
 *
 * This is the project's FIRST client component, and the reason is worth stating: nothing
 * in CSS can change an input's `type`, so revealing a password genuinely requires
 * JavaScript. The ratchet moves 0 -> 1 for a real capability, not for convenience — and
 * it is scoped to this field alone rather than turning a whole page into a client tree.
 *
 * Without JS the field still works: it renders as a normal password input and the toggle
 * simply does nothing, so the form degrades rather than breaking.
 */
import { useId, useState } from "react";

export function PasswordField({
  name,
  label,
  autoComplete,
  minLength,
  hint,
  required = true,
}: {
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  hint?: string;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-wrap">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          aria-describedby={hint ? hintId : undefined}
          className="password-input"
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          // aria-pressed communicates the toggle STATE; the label says what pressing does.
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          // Never submits: a button inside a form defaults to type="submit", which would
          // post the form on the first tap.
        >
          {visible ? <EyeOff /> : <Eye />}
        </button>
      </div>
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M1.5 10S4.5 4.5 10 4.5c1.4 0 2.6.3 3.7.8M18.5 10s-1.3 2.4-3.8 3.9M10 15.5c-5.5 0-8.5-5.5-8.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 3l14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
