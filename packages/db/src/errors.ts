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
