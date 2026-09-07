/**
 * The order lifecycle.
 *
 * One type field drives the front half; the back half — the delivery leg, tracking and
 * proof of delivery — is shared by every type (PRD §6). Encoding that as an explicit
 * transition table rather than scattered `if (status === …)` checks is the point: every
 * legal move is visible in one place, and an illegal one fails at the boundary rather
 * than leaving a row in a state nothing knows how to handle.
 *
 * Two rules here are not conveniences:
 *
 *   TERMINAL IS TERMINAL. A delivered order cannot be reopened and a cancelled one
 *   cannot resume. Both would silently re-bill, re-dispatch, or resurrect a tracking
 *   session for a driver who has gone off shift — and off-shift tracking is a legal
 *   liability, not a bug (CLAUDE.md).
 *
 *   NO SKIPPING. A jump straight to `delivered` bypasses proof of delivery, which is the
 *   evidence the premium tier is sold on. The table refuses it; nothing has to remember.
 */

/** What kind of job this is. Drives the front half of the lifecycle only. */
export type OrderType =
  | "fixed_pickup"
  | "shop_in_store"
  | "errand"
  | "scheduled_courier";

export type OrderStatus =
  /** Created and priced, no driver yet. */
  | "pending"
  /** A driver holds it. */
  | "assigned"
  /** Shopping types only: the driver is in the store picking items. */
  | "shopping"
  /** Shopping types only: at the till, resolving the true total. */
  | "checkout"
  /** Goods are with the driver, moving to the drop-off. */
  | "en_route"
  /** Complete, with proof of delivery. */
  | "delivered"
  /** Called off before completion. */
  | "cancelled"
  /** Attempted and could not be completed — nobody home, refused, damaged. */
  | "failed";

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "cancelled", "failed"];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Types that pass through a shopping phase. `errand` is a variant of shop_in_store —
 * buy X, collect from Y — and shares its states rather than getting its own.
 */
const SHOPPING_TYPES: readonly OrderType[] = ["shop_in_store", "errand"];

export function hasShoppingPhase(type: OrderType): boolean {
  return SHOPPING_TYPES.includes(type);
}

/**
 * Legal forward transitions per type. Cancellation and failure are handled separately
 * because they apply from ANY non-terminal state and listing them on every row would
 * bury the actual lifecycle.
 */
const FORWARD: Readonly<Record<OrderType, Readonly<Partial<Record<OrderStatus, readonly OrderStatus[]>>>>> = {
  fixed_pickup: {
    pending: ["assigned"],
    assigned: ["en_route"],
    en_route: ["delivered"],
  },
  scheduled_courier: {
    pending: ["assigned"],
    assigned: ["en_route"],
    en_route: ["delivered"],
  },
  shop_in_store: {
    pending: ["assigned"],
    assigned: ["shopping"],
    shopping: ["checkout"],
    checkout: ["en_route"],
    en_route: ["delivered"],
  },
  errand: {
    pending: ["assigned"],
    assigned: ["shopping"],
    shopping: ["checkout"],
    checkout: ["en_route"],
    en_route: ["delivered"],
  },
};

export type TransitionRejection =
  | "terminal"
  | "illegal-transition"
  | "same-status"
  | "unknown-status";

export type TransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TransitionRejection; readonly message: string };

/**
 * May this order move from `from` to `to`?
 *
 * Cancellation and failure are allowed from any non-terminal state — a job can go wrong
 * at any point, and refusing to record that would push operators into editing the
 * database by hand.
 */
export function canTransition(
  type: OrderType,
  from: OrderStatus,
  to: OrderStatus,
): TransitionResult {
  if (from === to) {
    return {
      ok: false,
      reason: "same-status",
      message: `Order is already ${from}.`,
    };
  }

  if (isTerminal(from)) {
    return {
      ok: false,
      reason: "terminal",
      message: `A ${from} order cannot change state. Terminal is terminal.`,
    };
  }

  if (to === "cancelled" || to === "failed") return { ok: true };

  const allowed = FORWARD[type][from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: "illegal-transition",
      message:
        allowed.length === 0
          ? `A ${type} order has no move out of ${from}.`
          : `A ${type} order moves from ${from} to ${allowed.join(" or ")}, not ${to}.`,
    };
  }

  return { ok: true };
}

/** Every status this order could legally move to right now. Drives the UI's buttons. */
export function nextStatuses(type: OrderType, from: OrderStatus): readonly OrderStatus[] {
  if (isTerminal(from)) return [];
  return [...(FORWARD[type][from] ?? []), "cancelled", "failed"];
}

/** Throwing form, for a caller that has already decided the move should be legal. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly type: OrderType,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly reason: TransitionRejection,
    message: string,
  ) {
    super(message);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(type: OrderType, from: OrderStatus, to: OrderStatus): void {
  const result = canTransition(type, from, to);
  if (!result.ok) {
    throw new IllegalTransitionError(type, from, to, result.reason, result.message);
  }
}

/**
 * Is a driver's location visible for this order?
 *
 * Location is scoped to an ORDER, never queried as "where is driver X" — that scoping is
 * what makes the privacy promise enforceable. Visibility ends the moment the order does:
 * continuing to track after delivery is a legal liability, not a feature.
 */
export function isLocationVisible(status: OrderStatus): boolean {
  return status === "assigned" || status === "shopping" || status === "checkout" || status === "en_route";
}

/** Human-facing label. Kept here so every surface says the same word for the same state. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Unassigned",
  assigned: "Assigned",
  shopping: "Shopping",
  checkout: "At checkout",
  en_route: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
  failed: "Failed",
};

/**
 * How a status should READ at a glance: succeeded, went wrong, or still running.
 *
 * Lives beside the labels, and for the same reason. The dispatch board and the order
 * page had each decided this for themselves and had already drifted: the board coloured
 * a failed job amber, the order page coloured it the same success green as a delivered
 * one, because it was branching on `isTerminal` — which is true of delivered, cancelled
 * AND failed. Green is not a neutral colour; on a job that did not get there it is a
 * false statement, and one only a person looking at the page could catch.
 *
 * Tone is deliberately about OUTCOME, not about whether the job is finished. "Cancelled"
 * is not a failure of the work — nobody attempted it — so it reads neutral rather than
 * alarming, which matches the reason sets in `closure.ts`.
 */
export type StatusTone = "good" | "warn" | "neutral";

export function statusTone(status: OrderStatus): StatusTone {
  if (status === "delivered") return "good";
  if (status === "failed") return "warn";
  return "neutral";
}

export const TYPE_LABELS: Record<OrderType, string> = {
  fixed_pickup: "Pickup and deliver",
  shop_in_store: "Shop in store",
  errand: "Errand",
  scheduled_courier: "Scheduled courier",
};
