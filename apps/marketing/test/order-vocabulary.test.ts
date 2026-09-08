/**
 * The database's order vocabulary must equal the domain's.
 *
 * These lists used to exist in five hand-maintained copies — the TypeScript union, the
 * Postgres enum, the server action's validation array, the dispatch board's creatable
 * types, and the tests. Cutting two order types in v1.3 meant editing all five, and
 * nothing in the toolchain would have caught a missed one: `readonly OrderType[]` is
 * satisfied by a list with a value MISSING, so an incomplete validation array compiles
 * and then silently refuses a legitimate job type at the form boundary.
 *
 * They now derive from the label records, which `Record<OrderType, string>` already
 * forces to be exhaustive. This test is what stops someone re-hardcoding the enum: the
 * derivation is a convention until something fails when it is broken.
 *
 * Lives in the app rather than in `packages/db` because it is the only place that can
 * import both sides without giving a pure domain package a dependency on persistence.
 */
import { describe, expect, it } from "vitest";
import { orderStatus, orderType } from "@porterdirect/db";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  STATUS_LABELS,
  TYPE_LABELS,
} from "@porterdirect/orders";

describe("order vocabulary is one list, not five", () => {
  it("the order_type enum is exactly the domain's types, in order", () => {
    expect([...orderType.enumValues]).toEqual([...ORDER_TYPES]);
  });

  it("the order_status enum is exactly the domain's statuses, in order", () => {
    expect([...orderStatus.enumValues]).toEqual([...ORDER_STATUSES]);
  });

  it("v1.3 left no shopping vocabulary behind in the database", () => {
    // Named explicitly rather than left to the equality above: a value surviving in the
    // enum is a value the database will still accept, and it would be accepted for a
    // type the state machine can no longer move.
    for (const gone of ["shop_in_store", "errand"]) {
      expect(orderType.enumValues as readonly string[]).not.toContain(gone);
    }
    for (const gone of ["shopping", "checkout"]) {
      expect(orderStatus.enumValues as readonly string[]).not.toContain(gone);
    }
  });

  it("every type and status the database accepts has a label", () => {
    // The derivation runs this way round, so this asserts it did not get inverted —
    // a database value with no label is a value some surface renders as blank.
    for (const value of orderType.enumValues) {
      expect(TYPE_LABELS[value], `no label for type ${value}`).toBeTruthy();
    }
    for (const value of orderStatus.enumValues) {
      expect(STATUS_LABELS[value], `no label for status ${value}`).toBeTruthy();
    }
  });

  it("holds no duplicates", () => {
    expect(new Set(orderType.enumValues).size).toBe(orderType.enumValues.length);
    expect(new Set(orderStatus.enumValues).size).toBe(orderStatus.enumValues.length);
  });
});
