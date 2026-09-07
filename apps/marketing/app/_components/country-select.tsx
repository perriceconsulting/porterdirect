import { supportedCountries } from "@porterdirect/contact";

/**
 * Country picker.
 *
 * A server component: the list is fixed at render time and needs no interactivity. Names
 * come from `Intl.DisplayNames`, so a country reads as "United Kingdom" rather than
 * "GB", and the list is sorted by that NAME rather than by code — nobody scans for "GB"
 * under G expecting United Kingdom.
 *
 * This exists because the operator's country was previously a column default nobody
 * could change: every tenant silently got US phone rules and US address labels.
 */
export function CountrySelect({
  name,
  label,
  defaultValue,
  hint,
  required = true,
}: {
  name: string;
  label: string;
  defaultValue: string;
  hint?: string;
  required?: boolean;
}) {
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const options = supportedCountries()
    .map((code) => ({ code, name: display.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <select id={name} name={name} defaultValue={defaultValue} required={required}>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.name}
          </option>
        ))}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
