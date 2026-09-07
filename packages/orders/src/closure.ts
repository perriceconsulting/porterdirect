/**
 * Why a job ended without being delivered.
 *
 * A closed set, not free text. "Nobody home" typed forty different ways cannot be
 * counted, and counting is the entire point: dispatch efficiency is the product's
 * highest-leverage lever, and it cannot be improved without knowing which failures are
 * frequent, which are the operator's fault, and which the customer should be charged for.
 *
 * CANCELLED and FAILED carry different reason sets on purpose. They are not synonyms:
 *
 *   cancelled — the job was called off. Nobody attempted it, or the attempt was stopped
 *               before it could succeed. Usually somebody's decision.
 *   failed    — the job WAS attempted and could not be completed. The driver went.
 *
 * That distinction decides who absorbs the cost, whether a re-attempt is reasonable, and
 * whether the number reflects on the operator at all — so a single merged list would
 * destroy the only thing the field is for.
 */

export type CancellationReason =
  | "customer_cancelled"
  | "operator_cancelled"
  | "duplicate_job"
  | "scheduling_conflict"
  | "price_not_agreed"
  | "no_driver_available";

export type FailureReason =
  | "recipient_unavailable"
  | "address_incorrect"
  | "access_denied"
  | "delivery_refused"
  | "goods_damaged"
  | "vehicle_breakdown"
  | "weather_or_road"
  | "items_unavailable";

export type ClosureReason = CancellationReason | FailureReason;

export const CANCELLATION_REASONS: readonly CancellationReason[] = [
  "customer_cancelled",
  "operator_cancelled",
  "duplicate_job",
  "scheduling_conflict",
  "price_not_agreed",
  "no_driver_available",
];

export const FAILURE_REASONS: readonly FailureReason[] = [
  "recipient_unavailable",
  "address_incorrect",
  "access_denied",
  "delivery_refused",
  "goods_damaged",
  "vehicle_breakdown",
  "weather_or_road",
  "items_unavailable",
];

/** Operator vocabulary, not database vocabulary. A dispatcher says "nobody home". */
export const CLOSURE_REASON_LABELS: Record<ClosureReason, string> = {
  customer_cancelled: "Customer cancelled",
  operator_cancelled: "We cancelled it",
  duplicate_job: "Duplicate job",
  scheduling_conflict: "Scheduling conflict",
  price_not_agreed: "Price not agreed",
  no_driver_available: "No driver available",

  recipient_unavailable: "Nobody there to receive it",
  address_incorrect: "Address was wrong",
  access_denied: "Could not get access",
  delivery_refused: "Recipient refused it",
  goods_damaged: "Goods damaged",
  vehicle_breakdown: "Vehicle breakdown",
  weather_or_road: "Weather or road conditions",
  items_unavailable: "Items unavailable in store",
};

/** Which reasons may accompany a given terminal status? */
export function reasonsFor(status: "cancelled" | "failed"): readonly ClosureReason[] {
  return status === "cancelled" ? CANCELLATION_REASONS : FAILURE_REASONS;
}

export function isValidReasonFor(
  status: "cancelled" | "failed",
  reason: string,
): reason is ClosureReason {
  return (reasonsFor(status) as readonly string[]).includes(reason);
}

/**
 * Is a second attempt reasonable for this reason?
 *
 * Drives whether re-dispatch is OFFERED, not whether it is permitted — an operator who
 * knows something the system does not can always raise a new job by hand. Offering it
 * for "duplicate job" would be actively wrong; withholding it for "nobody there" would
 * be obstructive, since a second attempt is the normal answer.
 */
export function isRedispatchable(reason: ClosureReason): boolean {
  const pointless: readonly ClosureReason[] = [
    "duplicate_job",
    "customer_cancelled",
    "price_not_agreed",
    "delivery_refused",
  ];
  return !pointless.includes(reason);
}

/**
 * Whose fault, for the operator's own reporting.
 *
 * Deliberately three-valued rather than a blame flag. "Weather" is nobody's fault and
 * recording it as the operator's would make their own numbers look worse than the work
 * was — which is how a metric stops being used.
 */
export type ClosureFault = "operator" | "customer" | "neither";

export function faultFor(reason: ClosureReason): ClosureFault {
  switch (reason) {
    case "operator_cancelled":
    case "no_driver_available":
    case "duplicate_job":
    case "goods_damaged":
    case "vehicle_breakdown":
      return "operator";
    case "customer_cancelled":
    case "price_not_agreed":
    case "recipient_unavailable":
    case "address_incorrect":
    case "access_denied":
    case "delivery_refused":
      return "customer";
    case "scheduling_conflict":
    case "weather_or_road":
    case "items_unavailable":
      return "neither";
  }
}
