/**
 * Order persistence.
 *
 * Every query here is scoped by `tenantId` inside the WHERE clause, never filtered in
 * application code afterwards. That is not stylistic: a forgotten filter returns another
 * licensee's rows, and every check downstream then passes honestly against the wrong
 * data. If a function in this file does not take a tenant id, it is a bug.
 */
import { and, desc, eq } from "drizzle-orm";
import { orderEvents, orders, users, type Db, type Order } from "@porterdirect/db";
import {
  assertTransition,
  type OrderStatus,
  type OrderType,
} from "@porterdirect/orders";

export interface CreateOrderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly type: OrderType;
  readonly customerFirstName: string;
  readonly customerLastName: string;
  readonly customerPhone?: string;
  readonly pickupAddress: string;
  readonly dropoffAddress: string;
  readonly notes?: string;
  readonly priceCents: number;
  /**
   * Required for `scheduled_courier`. An exact time window IS the product for that type,
   * so an unscheduled "scheduled" job is a contradiction the board cannot act on.
   */
  readonly scheduledFor?: Date | null;
}

/**
 * A short reference an operator can read down a phone: no vowels, so it cannot spell
 * anything unfortunate, and no 0/O or 1/I, which get misheard and mistyped.
 */
const REFERENCE_ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXZ";

function newReference(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += REFERENCE_ALPHABET[Math.floor(Math.random() * REFERENCE_ALPHABET.length)];
  }
  return `ORD-${out}`;
}

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderValidationError";
  }
}

export async function createOrder(db: Db, input: CreateOrderInput): Promise<Order> {
  if (!input.customerFirstName.trim()) {
    throw new OrderValidationError("Customer first name is required.");
  }
  if (!input.customerLastName.trim()) {
    throw new OrderValidationError("Customer last name is required.");
  }
  if (!input.pickupAddress.trim()) throw new OrderValidationError("Pickup address is required.");
  if (!input.dropoffAddress.trim()) throw new OrderValidationError("Drop-off address is required.");
  if (input.type === "scheduled_courier" && !input.scheduledFor) {
    // The product brief defines this type as an exact-time-window run. Accepting one
    // without a window puts a job on the board nobody can schedule against.
    throw new OrderValidationError("A scheduled courier job needs a date and time.");
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    // Money is integer cents. A float arriving here means one leaked in upstream.
    throw new OrderValidationError("Price must be a whole number of cents, zero or more.");
  }

  // Retry on the per-tenant unique index rather than pre-checking: a SELECT-then-INSERT
  // is the same check-then-act race the webhook ledger had, and the index already
  // answers the question atomically.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(orders)
        .values({
          tenantId: input.tenantId,
          reference: newReference(),
          type: input.type,
          status: "pending",
          customerFirstName: input.customerFirstName.trim(),
          customerLastName: input.customerLastName.trim(),
          customerPhone: input.customerPhone?.trim() || null,
          pickupAddress: input.pickupAddress.trim(),
          dropoffAddress: input.dropoffAddress.trim(),
          notes: input.notes?.trim() || null,
          priceCents: input.priceCents,
          scheduledFor: input.scheduledFor ?? null,
        })
        .returning();

      const created = row!;
      await db.insert(orderEvents).values({
        tenantId: input.tenantId,
        orderId: created.id,
        actorUserId: input.actorUserId,
        fromStatus: null,
        toStatus: "pending",
        note: "Order created",
      });
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!/orders_tenant_reference_idx|duplicate key/i.test(message)) throw err;
      // Collision on the reference — try another.
    }
  }
  throw new OrderValidationError("Could not allocate an order reference. Try again.");
}

/** This tenant's orders, newest first. */
export async function listOrders(db: Db, tenantId: string, limit = 50): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(eq(orders.tenantId, tenantId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

/**
 * One order, scoped by BOTH ids in a single predicate.
 *
 * Fetching by order id alone and comparing the tenant afterwards is the shape that
 * leaks — the row is already in memory by the time anyone checks, and a missed check
 * returns it.
 */
export async function findOrder(db: Db, tenantId: string, orderId: string): Promise<Order | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return null;
  }
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  return row ?? null;
}

export interface OrderEventRow {
  readonly toStatus: OrderStatus;
  readonly fromStatus: OrderStatus | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly actorName: string | null;
}

/** The order's history — the chain-of-custody trail, oldest first. */
export async function listOrderEvents(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<OrderEventRow[]> {
  const rows = await db
    .select({
      toStatus: orderEvents.toStatus,
      fromStatus: orderEvents.fromStatus,
      note: orderEvents.note,
      createdAt: orderEvents.createdAt,
      actorName: users.name,
    })
    .from(orderEvents)
    .leftJoin(users, eq(users.id, orderEvents.actorUserId))
    .where(and(eq(orderEvents.tenantId, tenantId), eq(orderEvents.orderId, orderId)))
    .orderBy(orderEvents.createdAt);
  return rows;
}

/**
 * Move an order to a new status, recording who did it.
 *
 * The state machine decides legality; this function only persists. Splitting them keeps
 * every lifecycle rule in one pure, fast-tested place rather than spread across the
 * queries that happen to touch orders.
 */
export async function transitionOrder(
  db: Db,
  args: {
    tenantId: string;
    orderId: string;
    to: OrderStatus;
    actorUserId: string;
    note?: string;
  },
): Promise<Order> {
  const order = await findOrder(db, args.tenantId, args.orderId);
  if (!order) throw new OrderValidationError("Order not found.");

  // Throws on an illegal move — including any move out of a terminal state.
  assertTransition(order.type, order.status, args.to);

  const [updated] = await db
    .update(orders)
    .set({
      status: args.to,
      updatedAt: new Date(),
      ...(args.to === "delivered" ? { deliveredAt: new Date() } : {}),
    })
    // Scoped by tenant AND by the status we read, so a concurrent transition loses
    // rather than both succeeding — the same atomic-claim shape as the webhook ledger.
    .where(
      and(
        eq(orders.tenantId, args.tenantId),
        eq(orders.id, args.orderId),
        eq(orders.status, order.status),
      ),
    )
    .returning();

  if (!updated) {
    throw new OrderValidationError(
      "That order changed while you were looking at it. Reload and try again.",
    );
  }

  await db.insert(orderEvents).values({
    tenantId: args.tenantId,
    orderId: args.orderId,
    actorUserId: args.actorUserId,
    fromStatus: order.status,
    toStatus: args.to,
    note: args.note?.trim() || null,
  });

  return updated;
}

/**
 * Record the true total for a variable-total job.
 *
 * Enforces the hard invariant from the product brief: `captured <= authorized`. Going
 * over means re-authorising, never over-capturing — taking more than was authorised is
 * a chargeback and a broken promise, not a rounding detail.
 */
export async function captureTotal(
  db: Db,
  args: { tenantId: string; orderId: string; capturedCents: number },
): Promise<Order> {
  if (!Number.isInteger(args.capturedCents) || args.capturedCents < 0) {
    throw new OrderValidationError("Captured amount must be a whole number of cents.");
  }
  const order = await findOrder(db, args.tenantId, args.orderId);
  if (!order) throw new OrderValidationError("Order not found.");

  const authorized = order.authorizedCents;
  if (authorized === null) {
    throw new OrderValidationError("This order has no authorisation to capture against.");
  }
  if (args.capturedCents > authorized) {
    throw new OrderValidationError(
      `Cannot capture ${args.capturedCents} against an authorisation of ${authorized}. ` +
        `Re-authorise for the higher amount instead.`,
    );
  }

  const [updated] = await db
    .update(orders)
    .set({ capturedCents: args.capturedCents, updatedAt: new Date() })
    .where(and(eq(orders.tenantId, args.tenantId), eq(orders.id, args.orderId)))
    .returning();
  return updated!;
}
