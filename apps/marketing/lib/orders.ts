/**
 * Order persistence.
 *
 * Every query here is scoped by `tenantId` inside the WHERE clause, never filtered in
 * application code afterwards. That is not stylistic: a forgotten filter returns another
 * licensee's rows, and every check downstream then passes honestly against the wrong
 * data. If a function in this file does not take a tenant id, it is a bug.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  isUniqueViolation,
  orderEvents,
  orders,
  users,
  type Db,
  type Order,
} from "@porterdirect/db";
import {
  CLOSURE_REASON_LABELS,
  assertTransition,
  isRedispatchable,
  isClosingStatus,
  isValidReasonFor,
  type ClosureReason,
  type OrderStatus,
  type OrderType,
} from "@porterdirect/orders";
import {
  addressLabels,
  missingAddressParts,
  parsePhone,
  type Address,
  type CountryCode,
} from "@porterdirect/contact";

export interface CreateOrderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly type: OrderType;
  readonly customerFirstName: string;
  readonly customerLastName: string;
  readonly customerPhone?: string;
  /** The tenant's country, used to read a nationally-formatted number. */
  readonly country: CountryCode;
  readonly pickup: Address;
  readonly dropoff: Address;
  readonly notes?: string;
  readonly priceCents: number;
  /**
   * Required for `scheduled_courier`. An exact time window IS the product for that type,
   * so an unscheduled "scheduled" job is a contradiction the board cannot act on.
   */
  readonly scheduledFor?: Date | null;
  /**
   * Set when this job is a re-attempt of a failed one. Written in the SAME insert as the
   * row, never as a follow-up update: a create-then-link pair leaves a window where the
   * new job exists unlinked, and a failure inside it produces a duplicate job that the
   * once-only rule can no longer see.
   */
  readonly redispatchedFromOrderId?: string;
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
  // Each address is checked against ITS OWN country's rules — a US pickup needs a state
  // and ZIP, a UK drop-off does not need a county. Reporting the missing FIELDS by their
  // local names beats "address is required" when four inputs are on screen.
  for (const [label, addr] of [["Pickup", input.pickup], ["Drop-off", input.dropoff]] as const) {
    const missing = missingAddressParts(addr, addr.country);
    if (missing.length > 0) {
      const labels = addressLabels(addr.country);
      const names = missing.map((part) => labels[part]).join(", ");
      throw new OrderValidationError(`${label} address needs: ${names}.`);
    }
  }
  if (input.type === "scheduled_courier" && !input.scheduledFor) {
    // The product brief defines this type as an exact-time-window run. Accepting one
    // without a window puts a job on the board nobody can schedule against.
    throw new OrderValidationError("A scheduled courier job needs a date and time.");
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    // Money is integer cents. A float arriving here means one leaked in upstream.
    throw new OrderValidationError("Price must be a whole number of cents, zero or more.");
  }

  let normalizedPhone: string | null = null;
  if (input.customerPhone?.trim()) {
    const parsed = parsePhone(input.customerPhone, input.country);
    if (!parsed) {
      throw new OrderValidationError(
        "That phone number could not be read. Enter a number that can actually be dialled.",
      );
    }
    normalizedPhone = parsed.e164;
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
          // Stored as E.164 so one customer is one number however it was typed.
          // Refused rather than stored raw when unparseable — this is the field a
          // driver dials.
          customerPhone: normalizedPhone,
          pickupLine1: input.pickup.line1.trim(),
          pickupLine2: input.pickup.line2?.trim() || null,
          pickupCity: input.pickup.city.trim(),
          pickupRegion: input.pickup.region?.trim() || null,
          pickupPostalCode: input.pickup.postalCode?.trim() || null,
          pickupCountry: input.pickup.country,
          dropoffLine1: input.dropoff.line1.trim(),
          dropoffLine2: input.dropoff.line2?.trim() || null,
          dropoffCity: input.dropoff.city.trim(),
          dropoffRegion: input.dropoff.region?.trim() || null,
          dropoffPostalCode: input.dropoff.postalCode?.trim() || null,
          dropoffCountry: input.dropoff.country,
          notes: input.notes?.trim() || null,
          priceCents: input.priceCents,
          scheduledFor: input.scheduledFor ?? null,
          redispatchedFromOrderId: input.redispatchedFromOrderId ?? null,
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
      // Read by SQLSTATE + constraint name, not by matching the message. Drizzle wraps
      // the driver error and its message is the failed SQL, so the previous
      // `/orders_tenant_reference_idx|duplicate key/` test never matched anything — this
      // loop was not retrying reference collisions at all, it was rethrowing them.
      //
      // Narrowed to the REFERENCE constraint too: a retry loop must only retry the thing
      // it knows how to fix. Left broad, an "already re-dispatched" collision would burn
      // five attempts generating new references and then report a reference failure,
      // pointing at entirely the wrong problem.
      if (!isUniqueViolation(err, "orders_tenant_reference_idx")) throw err;
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
    /** Required when closing a job as cancelled or failed. */
    reason?: string;
  },
): Promise<Order> {
  const order = await findOrder(db, args.tenantId, args.orderId);
  if (!order) throw new OrderValidationError("Order not found.");

  // Throws on an illegal move — including any move out of a terminal state.
  assertTransition(order.type, order.status, args.to);

  // A job that ends without delivery must say WHY. Free text cannot be counted, and
  // counting is the point: dispatch efficiency cannot be improved without knowing which
  // failures are frequent and whose fault they are.
  // Checked INLINE, not via a boolean alias. `const closing = to === "cancelled" || ...`
  // reads identically and does not narrow `args.to`: aliased-condition narrowing does not
  // reach a property of a function parameter, so the call below failed to type-check.
  // It shipped, because `npm run typecheck` did not cover this app.
  const closing = isClosingStatus(args.to);
  if (isClosingStatus(args.to)) {
    if (!args.reason) {
      throw new OrderValidationError(`Choose a reason before marking this job ${args.to}.`);
    }
    if (!isValidReasonFor(args.to, args.reason)) {
      throw new OrderValidationError(
        `"${args.reason}" is not a reason a job can be ${args.to}.`,
      );
    }
  }

  const [updated] = await db
    .update(orders)
    .set({
      status: args.to,
      updatedAt: new Date(),
      ...(args.to === "delivered" ? { deliveredAt: new Date() } : {}),
      ...(closing
        ? { closureReason: args.reason ?? null, closureNote: args.note?.trim() || null }
        : {}),
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
    // The reason leads the audit line; a typed note follows it when there is one.
    note: closing
      ? [CLOSURE_REASON_LABELS[args.reason as ClosureReason], args.note?.trim()]
          .filter(Boolean)
          .join(" — ")
      : args.note?.trim() || null,
  });

  return updated;
}

/** Rebuild the pickup address from a row, for display. */
export function pickupAddressOf(order: Order): Address {
  return {
    line1: order.pickupLine1,
    line2: order.pickupLine2,
    city: order.pickupCity,
    region: order.pickupRegion,
    postalCode: order.pickupPostalCode,
    country: order.pickupCountry,
  };
}

/** Rebuild the drop-off address from a row, for display. */
export function dropoffAddressOf(order: Order): Address {
  return {
    line1: order.dropoffLine1,
    line2: order.dropoffLine2,
    city: order.dropoffCity,
    region: order.dropoffRegion,
    postalCode: order.dropoffPostalCode,
    country: order.dropoffCountry,
  };
}

/**
 * Raise a fresh attempt at a failed job.
 *
 * A NEW order, never a reopened one. Reopening would rewrite the first attempt's history
 * and erase its failure from the numbers — and the whole reason for recording a closure
 * reason is that those numbers are the operator's only view of what keeps going wrong.
 *
 * The new job copies the details, links back to the original, and starts at `pending` so
 * it is dispatched deliberately rather than inheriting a driver who already could not
 * complete it.
 */
export async function redispatchOrder(
  db: Db,
  args: { tenantId: string; orderId: string; actorUserId: string },
): Promise<Order> {
  const original = await findOrder(db, args.tenantId, args.orderId);
  if (!original) throw new OrderValidationError("Order not found.");

  if (original.status !== "failed") {
    throw new OrderValidationError(
      "Only a failed job can be re-dispatched. Cancelled work is not re-attempted automatically.",
    );
  }
  if (original.closureReason && !isRedispatchable(original.closureReason as ClosureReason)) {
    throw new OrderValidationError(
      `A job that ended "${CLOSURE_REASON_LABELS[original.closureReason as ClosureReason]}" ` +
        `is not re-attempted. Raise a new job if the situation has changed.`,
    );
  }

  // NO pre-check that this job was already re-dispatched.
  //
  // It used to SELECT for an existing re-dispatch and then INSERT, which is exactly the
  // check-then-act race the webhook ledger was already bitten by: two concurrent requests
  // — an impatient double-click, or two dispatchers on the same job — both pass the
  // SELECT and both create an order. The comment above it named that precise failure
  // while the code allowed it.
  //
  // The unique index on `redispatched_from_order_id` answers the question atomically, so
  // the loser of the race gets a constraint violation instead of a second driver. The
  // link travels IN the insert, so there is no window where the new job exists unlinked.
  let created: Order;
  try {
    created = await createOrder(db, {
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      type: original.type,
      customerFirstName: original.customerFirstName,
      customerLastName: original.customerLastName,
      customerPhone: original.customerPhone ?? undefined,
      country: original.pickupCountry as CountryCode,
      pickup: pickupAddressOf(original),
      dropoff: dropoffAddressOf(original),
      priceCents: original.priceCents,
      notes: original.notes ?? undefined,
      scheduledFor: null,
      redispatchedFromOrderId: original.id,
    });
  } catch (err) {
    if (!isUniqueViolation(err, "orders_redispatch_idx")) throw err;
    // Lost the race, or a genuine second attempt. Read back what won so the operator is
    // told WHICH job now carries the work rather than just being refused.
    const winner = await findRedispatch(db, args.tenantId, args.orderId);
    throw new OrderValidationError(
      winner
        ? `This job has already been re-dispatched as ${winner.reference}.`
        : "This job has already been re-dispatched.",
    );
  }

  await db.insert(orderEvents).values({
    tenantId: args.tenantId,
    orderId: created.id,
    actorUserId: args.actorUserId,
    fromStatus: null,
    toStatus: "pending",
    note: `Re-dispatch of ${original.reference}`,
  });

  return created;
}

/** The follow-up raised for a failed job, if there is one. */
export async function findRedispatch(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<Order | null> {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.redispatchedFromOrderId, orderId)))
    .limit(1);
  return row ?? null;
}

/** The failed job this one re-attempts, if any. */
export async function findRedispatchOrigin(
  db: Db,
  tenantId: string,
  order: Order,
): Promise<Order | null> {
  if (!order.redispatchedFromOrderId) return null;
  return findOrder(db, tenantId, order.redispatchedFromOrderId);
}
