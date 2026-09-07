import { addressLabels, type Address } from "@porterdirect/contact";

/**
 * One address, in parts, labelled the way the country writes them.
 *
 * A server component: the labels are decided per country at render time, and nothing
 * here needs to react to typing. The country travels in a hidden field so a cross-border
 * job can carry a different one per address without the operator restating it.
 */
export function AddressFields({
  prefix,
  legend,
  country,
  defaults,
}: {
  /** Field-name prefix: "pickup" produces pickupLine1, pickupCity and so on. */
  prefix: string;
  legend: string;
  country: string;
  defaults?: Partial<Address>;
}) {
  // Placement class derived from the prefix, so the stylesheet targets a NAME rather
  // than a position — nth-of-type breaks the moment a group is added above it.
  const labels = addressLabels(country);
  const id = (part: string) => `${prefix}-${part}`;

  return (
    <fieldset className={`field-group group-${prefix}`}>
      <legend>{legend}</legend>
      <input type="hidden" name={`${prefix}Country`} value={country} />

      <div className="field">
        <label htmlFor={id("line1")}>{labels.line1}</label>
        <input
          id={id("line1")}
          name={`${prefix}Line1`}
          autoComplete="off"
          placeholder="Number and street"
          defaultValue={defaults?.line1 ?? ""}
          required
        />
      </div>

      <div className="field">
        <label htmlFor={id("line2")}>{labels.line2}</label>
        <input
          id={id("line2")}
          name={`${prefix}Line2`}
          autoComplete="off"
          defaultValue={defaults?.line2 ?? ""}
        />
      </div>

      <div className="row-2">
        <div className="field">
          <label htmlFor={id("city")}>{labels.city}</label>
          <input
            id={id("city")}
            name={`${prefix}City`}
            autoComplete="off"
            defaultValue={defaults?.city ?? ""}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={id("region")}>
            {labels.region}
            {/* Said plainly rather than left to a missing asterisk: a county is genuinely
                optional in the UK and genuinely required in the US. */}
            {labels.regionRequired ? "" : " (optional)"}
          </label>
          <input
            id={id("region")}
            name={`${prefix}Region`}
            autoComplete="off"
            defaultValue={defaults?.region ?? ""}
            required={labels.regionRequired}
          />
        </div>
      </div>

      <div className="field field-short">
        <label htmlFor={id("postal")}>
          {labels.postalCode}
          {labels.postalCodeRequired ? "" : " (optional)"}
        </label>
        <input
          id={id("postal")}
          name={`${prefix}PostalCode`}
          autoComplete="off"
          defaultValue={defaults?.postalCode ?? ""}
          required={labels.postalCodeRequired}
        />
      </div>
    </fieldset>
  );
}
