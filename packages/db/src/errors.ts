/**
 * Reading a unique-constraint violation out of a driver error.
 *
 * Message matching does NOT work here, and that is the whole reason this exists. Drizzle
 * wraps the driver error in a `DrizzleQueryError` whose message is the failed SQL —
 * "Failed query: insert into orders (...)" — while the useful part sits on `.cause` as a
 * `NeonDbError` carrying SQLSTATE `23505` and the constraint NAME. Two separate retry
 * handlers in this repo tested `err.message` for a constraint name and therefore never
 * matched: one silently stopped retrying reference collisions, the other turned an
 * "already re-dispatched" refusal into a raw query error.
 *
 * Same lesson as `classifyAuthError` in the auth package: classify by SHAPE, because the
 * identity and the text of an error both change underneath you. Here the error is not a
 * different class — it is buried one level down.
 *
 * Walks the cause chain rather than checking one level, since a driver is free to add
 * another wrapper in a future release.
 */
export function uniqueViolation(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505" && typeof e.constraint === "string") return e.constraint;
    current = e.cause;
  }
  return null;
}

/** Did this error violate exactly this constraint? */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  return uniqueViolation(err) === constraint;
}

/**
 * The SQLSTATE a driver error carries, if any.
 *
 * Same cause-chain walk and the same reason as above: the code sits on the wrapped error,
 * never in the message. Generalised out of `uniqueViolation` once a SECOND caller needed
 * it — the append-only trigger on `order_events` raises `restrict_violation`, and a test
 * that asserted on the message text matched the failed SQL instead and reported the guard
 * as absent when it was working perfectly.
 */
export function sqlState(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string") return e.code;
    current = e.cause;
  }
  return null;
}

/**
 * Refused by a rule rather than by a constraint — SQLSTATE 23001.
 *
 * What the `order_events` append-only trigger raises. Distinct from a unique violation:
 * this one means "the database will not let you do that", not "that value is taken".
 */
export function isRestrictViolation(err: unknown): boolean {
  return sqlState(err) === "23001";
}
