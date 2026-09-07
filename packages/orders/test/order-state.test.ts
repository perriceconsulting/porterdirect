import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  TYPE_LABELS,
  assertTransition,
  canTransition,
  hasShoppingPhase,
  isLocationVisible,
  isTerminal,
  nextStatuses,
  statusTone,
  type OrderStatus,
  type OrderType,
} from "../src/order-state.js";

const ALL_TYPES: OrderType[] = ["fixed_pickup", "shop_in_store", "errand", "scheduled_courier"];
const ALL_STATUSES: OrderStatus[] = [
  "pending",
  "assigned",
  "shopping",
  "checkout",
  "en_route",
  "delivered",
  "cancelled",
  "failed",
];

describe("the happy paths match the product brief", () => {
  it("fixed_pickup: pending -> assigned -> en_route -> delivered", () => {
    const path: OrderStatus[] = ["pending", "assigned", "en_route", "delivered"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition("fixed_pickup", path[i]!, path[i + 1]!).ok, `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("shop_in_store: adds shopping and checkout before the delivery leg", () => {
    const path: OrderStatus[] = ["pending", "assigned", "shopping", "checkout", "en_route", "delivered"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition("shop_in_store", path[i]!, path[i + 1]!).ok, `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("errand shares the shopping lifecycle rather than inventing its own", () => {
    expect(hasShoppingPhase("errand")).toBe(true);
    expect(canTransition("errand", "assigned", "shopping").ok).toBe(true);
  });

  it("scheduled_courier follows the fixed_pickup shape", () => {
    expect(hasShoppingPhase("scheduled_courier")).toBe(false);
    expect(canTransition("scheduled_courier", "assigned", "en_route").ok).toBe(true);
  });
});

describe("no skipping", () => {
  it("refuses a jump straight to delivered, which would bypass proof of delivery", () => {
    // POD is the evidence the premium tier is sold on. A shortcut here loses it.
    const result = canTransition("fixed_pickup", "pending", "delivered");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("illegal-transition");
  });

  it("refuses assigned -> delivered", () => {
    expect(canTransition("fixed_pickup", "assigned", "delivered").ok).toBe(false);
  });

  it("refuses a shopping order skipping the till", () => {
    // Straight from shopping to en_route means no true total was ever captured, so the
    // pre-authorisation is never reconciled against what was actually bought.
    expect(canTransition("shop_in_store", "shopping", "en_route").ok).toBe(false);
  });

  it("refuses a non-shopping order entering the shopping phase", () => {
    expect(canTransition("fixed_pickup", "assigned", "shopping").ok).toBe(false);
    expect(canTransition("scheduled_courier", "assigned", "checkout").ok).toBe(false);
  });

  it("refuses moving backwards", () => {
    expect(canTransition("fixed_pickup", "en_route", "assigned").ok).toBe(false);
    expect(canTransition("shop_in_store", "checkout", "shopping").ok).toBe(false);
  });
});

describe("terminal is terminal", () => {
  it.each(TERMINAL_STATUSES)("nothing moves out of %s", (terminal) => {
    for (const type of ALL_TYPES) {
      for (const to of ALL_STATUSES) {
        if (to === terminal) continue;
        const result = canTransition(type, terminal, to);
        expect(result.ok, `${type}: ${terminal} -> ${to} must be refused`).toBe(false);
        if (!result.ok) expect(result.reason).toBe("terminal");
      }
    }
  });

  it("a delivered order cannot be reopened", () => {
    // Reopening would re-dispatch, re-bill, and resurrect a tracking session for a
    // driver who may have gone off shift.
    expect(canTransition("fixed_pickup", "delivered", "en_route").ok).toBe(false);
  });

  it("a cancelled order cannot resume", () => {
    expect(canTransition("fixed_pickup", "cancelled", "assigned").ok).toBe(false);
  });

  it("offers no onward moves from a terminal state", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(nextStatuses("shop_in_store", terminal)).toEqual([]);
    }
  });
});

describe("cancellation and failure", () => {
  it("are reachable from every non-terminal state, for every type", () => {
    // A job can go wrong at any point. Refusing to record that pushes operators into
    // editing the database by hand, which is worse than a permissive transition.
    for (const type of ALL_TYPES) {
      for (const status of ALL_STATUSES) {
        if (isTerminal(status)) continue;
        expect(canTransition(type, status, "cancelled").ok, `${type} ${status} -> cancelled`).toBe(true);
        expect(canTransition(type, status, "failed").ok, `${type} ${status} -> failed`).toBe(true);
      }
    }
  });

  it("are still refused from a terminal state", () => {
    expect(canTransition("fixed_pickup", "delivered", "cancelled").ok).toBe(false);
  });
});

describe("nextStatuses drives the UI", () => {
  it("offers exactly the legal moves plus the two escape hatches", () => {
    expect(nextStatuses("fixed_pickup", "assigned")).toEqual(["en_route", "cancelled", "failed"]);
    expect(nextStatuses("shop_in_store", "assigned")).toEqual(["shopping", "cancelled", "failed"]);
  });

  it("never offers a move the transition check would refuse", () => {
    // The buttons and the guard must agree, or the UI offers something that then fails.
    for (const type of ALL_TYPES) {
      for (const status of ALL_STATUSES) {
        for (const next of nextStatuses(type, status)) {
          expect(canTransition(type, status, next).ok, `${type}: ${status} -> ${next}`).toBe(true);
        }
      }
    }
  });
});

describe("location visibility is bound to the order, not the person", () => {
  it("is visible only while the job is live", () => {
    expect(isLocationVisible("assigned")).toBe(true);
    expect(isLocationVisible("shopping")).toBe(true);
    expect(isLocationVisible("checkout")).toBe(true);
    expect(isLocationVisible("en_route")).toBe(true);
  });

  it("stops the moment the order ends", () => {
    // Continuing to track after delivery is a legal liability, not a feature.
    for (const terminal of TERMINAL_STATUSES) {
      expect(isLocationVisible(terminal), `${terminal} must not expose location`).toBe(false);
    }
  });

  it("is not visible before a driver holds the order", () => {
    expect(isLocationVisible("pending")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("passes silently for a legal move", () => {
    expect(() => assertTransition("fixed_pickup", "pending", "assigned")).not.toThrow();
  });

  it("throws with the type, both states and a reason", () => {
    try {
      assertTransition("fixed_pickup", "delivered", "en_route");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.from).toBe("delivered");
      expect(e.to).toBe("en_route");
      expect(e.reason).toBe("terminal");
    }
  });

  it("refuses a no-op rather than silently accepting it", () => {
    // Accepting a same-state move would let a double-submitted form look successful.
    const result = canTransition("fixed_pickup", "assigned", "assigned");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("same-status");
  });
});

describe("vocabulary", () => {
  it("labels every status and every type", () => {
    for (const s of ALL_STATUSES) expect(STATUS_LABELS[s], `no label for ${s}`).toBeTruthy();
    for (const t of ALL_TYPES) expect(TYPE_LABELS[t], `no label for ${t}`).toBeTruthy();
  });

  it("uses operator vocabulary, not database vocabulary", () => {
    // A dispatcher says "on the way", not "en_route".
    expect(STATUS_LABELS.en_route).toBe("On the way");
    expect(STATUS_LABELS.pending).toBe("Unassigned");
  });
});

describe("statusTone", () => {
  it("calls a delivered job, and only a delivered job, a success", () => {
    const good = ALL_STATUSES.filter((s) => statusTone(s) === "good");
    expect(good).toEqual(["delivered"]);
  });

  it("does not colour a failed job as a success", () => {
    // The defect this exists for: the order page branched on isTerminal, which is true
    // of delivered, cancelled AND failed, so a job that never arrived rendered green.
    expect(statusTone("failed")).not.toBe("good");
    expect(statusTone("cancelled")).not.toBe("good");
  });

  it("warns on failure but not on cancellation", () => {
    // Cancelled work was never attempted, so it is not a failure of the operator's work
    // and must not read like one. Same distinction as the closure reason sets.
    expect(statusTone("failed")).toBe("warn");
    expect(statusTone("cancelled")).toBe("neutral");
  });

  it("treats every live status as neutral", () => {
    for (const status of ALL_STATUSES.filter((s) => !isTerminal(s))) {
      expect(statusTone(status)).toBe("neutral");
    }
  });
});
