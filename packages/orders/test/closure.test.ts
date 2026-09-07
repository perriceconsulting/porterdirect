import { describe, expect, it } from "vitest";
import {
  CANCELLATION_REASONS,
  CLOSURE_REASON_LABELS,
  FAILURE_REASONS,
  faultFor,
  isRedispatchable,
  isValidReasonFor,
  reasonsFor,
  type ClosureReason,
} from "../src/closure.js";

const ALL: ClosureReason[] = [...CANCELLATION_REASONS, ...FAILURE_REASONS];

describe("cancelled and failed are not synonyms", () => {
  it("offers different reasons for each", () => {
    // Merging them would destroy the only thing the field is for: a cancelled job was
    // never attempted, a failed one was — different cost, different blame, different
    // decision about re-attempting.
    expect(reasonsFor("cancelled")).toEqual(CANCELLATION_REASONS);
    expect(reasonsFor("failed")).toEqual(FAILURE_REASONS);
    expect(CANCELLATION_REASONS.some((r) => (FAILURE_REASONS as readonly string[]).includes(r))).toBe(
      false,
    );
  });

  it("refuses a failure reason on a cancellation", () => {
    expect(isValidReasonFor("cancelled", "recipient_unavailable")).toBe(false);
    expect(isValidReasonFor("failed", "recipient_unavailable")).toBe(true);
  });

  it("refuses anything not in the set", () => {
    // Free text is what this exists to prevent: "nobody home" typed forty ways cannot be
    // counted, and counting is the point.
    for (const junk of ["", "because", "customer_cancelled ", "CUSTOMER_CANCELLED"]) {
      expect(isValidReasonFor("cancelled", junk), junk).toBe(false);
    }
  });
});

describe("every reason is complete", () => {
  it("has a label", () => {
    for (const r of ALL) {
      expect(CLOSURE_REASON_LABELS[r], `no label for ${r}`).toBeTruthy();
    }
  });

  it("uses operator vocabulary rather than database vocabulary", () => {
    // A dispatcher says "nobody there", not "recipient_unavailable".
    expect(CLOSURE_REASON_LABELS.recipient_unavailable).toBe("Nobody there to receive it");
  });

  it("is assigned a fault", () => {
    for (const r of ALL) {
      expect(["operator", "customer", "neither"]).toContain(faultFor(r));
    }
  });
});

describe("fault is three-valued, not a blame flag", () => {
  it("does not blame the operator for weather", () => {
    // Recording weather as the operator's fault makes their own numbers worse than the
    // work was, which is how a metric stops being used.
    expect(faultFor("weather_or_road")).toBe("neither");
  });

  it("blames the operator for its own failures", () => {
    expect(faultFor("no_driver_available")).toBe("operator");
    expect(faultFor("vehicle_breakdown")).toBe("operator");
  });

  it("attributes a wrong address and an absent recipient to the customer", () => {
    expect(faultFor("address_incorrect")).toBe("customer");
    expect(faultFor("recipient_unavailable")).toBe("customer");
  });

  it("uses all three values, so the distinction is real", () => {
    const used = new Set(ALL.map(faultFor));
    expect(used).toEqual(new Set(["operator", "customer", "neither"]));
  });
});

describe("re-dispatch is offered only where a second attempt makes sense", () => {
  it("offers it when nobody was there — the normal answer is to try again", () => {
    expect(isRedispatchable("recipient_unavailable")).toBe(true);
    expect(isRedispatchable("access_denied")).toBe(true);
    expect(isRedispatchable("weather_or_road")).toBe(true);
  });

  it("does not offer it where a second attempt is pointless", () => {
    expect(isRedispatchable("duplicate_job")).toBe(false);
    expect(isRedispatchable("customer_cancelled")).toBe(false);
    expect(isRedispatchable("delivery_refused")).toBe(false);
    expect(isRedispatchable("price_not_agreed")).toBe(false);
  });

  it("decides every reason one way or the other", () => {
    for (const r of ALL) expect(typeof isRedispatchable(r)).toBe("boolean");
  });
});
