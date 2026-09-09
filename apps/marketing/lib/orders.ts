/**
 * Order persistence.
 *
 * Every query here is scoped by `tenantId` inside the WHERE clause, never filtered in
 * application code afterwards. That is not stylistic: a forgotten filter returns another
 * licensee's rows, and every check downstream then passes honestly against the wrong
 * data. If a function in this file does not take a tenant id, it is a bug.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import {
  isUniqueViolation,
  orderDeclines,
  orderEvents,
  orderProofs,
  orders,
  users,
  type Db,
  type Order,
  type OrderProof,
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
import { formatUsdCents } from "@porterdirect/billing";
import { looksLikeEmail } from "./delivery-receipt";
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
  /** Where the delivery receipt goes. Optional: plenty of work is booked by phone. */
  readonly customerEmail?: string;
  /** The tenant's country, used to read a nationally-formatted number. */
  readonly country: CountryCode;
  readonly pickup: Address;
  readonly dropoff: Address;
  readonly notes?: string;
  /**
   * Null means NOT YET PRICED, which is a real state once customers book their own work:
   * an address nothing could geocode, or a run beyond the operator's quotable range,
   * still has to reach the board. It is distinct from zero, which is a job that is free.
   */
  readonly priceCents: number | null;
  /** What the driver is paid. The number on the offer they accept or refuse. */
  readonly driverPayCents?: number;
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

/**
 * The customer's tracking token.
 *
 * 24 bytes of CRYPTO randomness — not a uuid. A uuid is an identifier: it leaks a
 * timestamp in v1, appears in logs and referrers, and reads like something safe to quote.
 * This is the only thing standing between a stranger and one delivery's details, so it is
 * generated the way a secret is.
 *
 * base64url so it survives being pasted into a URL, an SMS and a QR code without
 * escaping — the three places it will actually live.
 */
export function newPublicToken(): string {
  return randomBytes(24).toString("base64url");
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
  if (input.priceCents !== null && (!Number.isInteger(input.priceCents) || input.priceCents < 0)) {
    // Money is integer cents. A float arriving here means one leaked in upstream.
    // Null is allowed and means unpriced; it is checked FOR rather than falling through,
    // so a `NaN` or a float can never reach the column by looking absent.
    throw new OrderValidationError("Price must be a whole number of cents, zero or more.");
  }

  if (input.customerEmail?.trim() && !looksLikeEmail(input.customerEmail)) {
    throw new OrderValidationError("That email address does not look right.");
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
          // Stored as given. An address either routes or it does not, and lower-casing or
          // stripping a `+tag` is exactly how the one that would have worked gets broken.
          customerEmail: input.customerEmail?.trim() || null,
          // Every job gets one at creation. Minting it later would mean a customer who
          // asks "where is it?" before anyone thinks to generate a link cannot be told.
          publicToken: newPublicToken(),
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
          driverPayCents: input.driverPayCents ?? null,
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

/**
 * This tenant's orders, newest first.
 *
 * `assignedTo` narrows to one driver's work IN THE QUERY, which is not a style
 * preference. The board previously fetched the most recent `limit` rows and filtered to
 * the driver afterwards, in the page — so on a tenant with more than `limit` jobs, a
 * driver whose work was not among the most recent saw an EMPTY BOARD. It failed only
 * once an operator got busy, which is the worst time for a driver's job list to vanish,
 * and it looked like "no work today" rather than a bug.
 *
 * The tenant predicate stays exactly where it was; this adds a second one beside it
 * rather than moving anything.
 */
export async function listOrders(
  db: Db,
  tenantId: string,
  opts: { limit?: number; assignedTo?: string } = {},
): Promise<Order[]> {
  const limit = opts.limit ?? 50;
  const where = opts.assignedTo
    ? and(eq(orders.tenantId, tenantId), eq(orders.assignedUserId, opts.assignedTo))
    : eq(orders.tenantId, tenantId);

  return db.select().from(orders).where(where).orderBy(desc(orders.createdAt)).limit(limit);
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

/**
 * Record proof of delivery.
 *
 * Deliberately does NOT transition the order. Capturing evidence and declaring the job
 * delivered are two decisions, and fusing them means a failed transition throws away a
 * signature the recipient already gave — which cannot be re-collected once the driver
 * has left the door. Capture first, move second.
 *
 * One proof per order, enforced by a unique index rather than a pre-check: two proofs
 * would raise "which one is the evidence?" at exactly the moment somebody is disputing
 * a delivery. A second attempt is refused with the reason, not silently ignored.
 */
export async function recordProof(
  db: Db,
  args: {
    tenantId: string;
    orderId: string;
    capturedByUserId: string | null;
    recipientName?: string | null;
    photoKey?: string | null;
    signatureKey?: string | null;
    lat?: string | null;
    lng?: string | null;
    accuracyM?: number | null;
  },
): Promise<OrderProof> {
  const order = await findOrder(db, args.tenantId, args.orderId);
  if (!order) throw new OrderValidationError("Order not found.");

  if (!args.photoKey && !args.signatureKey && !args.recipientName?.trim()) {
    // An empty proof is worse than none: it looks like evidence in a list and answers
    // nothing when opened.
    throw new OrderValidationError(
      "Capture a signature, a photo, or the recipient's name before saving proof.",
    );
  }

  try {
    const [row] = await db
      .insert(orderProofs)
      .values({
        tenantId: args.tenantId,
        orderId: args.orderId,
        capturedByUserId: args.capturedByUserId,
        recipientName: args.recipientName?.trim() || null,
        photoKey: args.photoKey ?? null,
        signatureKey: args.signatureKey ?? null,
        capturedLat: args.lat ?? null,
        capturedLng: args.lng ?? null,
        capturedAccuracyM: args.accuracyM ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (!isUniqueViolation(err, "order_proofs_order_idx")) throw err;
    throw new OrderValidationError("This job already has proof of delivery recorded.");
  }
}

/** This order's proof, or null. Scoped by both ids in one predicate, like every read here. */
export async function findProof(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<OrderProof | null> {
  const [row] = await db
    .select()
    .from(orderProofs)
    .where(and(eq(orderProofs.tenantId, tenantId), eq(orderProofs.orderId, orderId)))
    .limit(1);
  return row ?? null;
}

/**
 * One order by its PUBLIC token — the customer's view.
 *
 * Not tenant-scoped, and that is not an oversight: the token IS the scope. A stranger
 * holding it has no tenant id to supply, and requiring one would mean putting the tenant
 * id in the URL, which tells a recipient more about the operator's account than the
 * delivery they are asking about.
 *
 * The unique index makes one token resolve to at most one order, so there is no
 * ambiguity to resolve in application code.
 */
export async function findOrderByPublicToken(db: Db, token: string): Promise<Order | null> {
  // An empty token must never match a row whose column is NULL — that would hand every
  // pre-token order to anyone who visited /t/.
  if (!token.trim()) return null;
  const [row] = await db.select().from(orders).where(eq(orders.publicToken, token)).limit(1);
  return row ?? null;
}

/** Give orders created before tracking existed a token, so their links work too. */
export async function backfillPublicTokens(db: Db, tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), isNull(orders.publicToken)));
  for (const row of rows) {
    await db.update(orders).set({ publicToken: newPublicToken() }).where(eq(orders.id, row.id));
  }
  return rows.length;
}

/**
 * Jobs nobody has taken yet — the pool a driver may claim from.
 *
 * Scoped by tenant in the WHERE clause like every read here, and narrowed to genuinely
 * unclaimed work: `pending` AND no assignee. A job that is assigned but still pending
 * belongs to somebody; showing it here would invite two people to the same doorstep.
 */
export async function listOffersFor(
  db: Db,
  tenantId: string,
  userId: string,
  limit = 25,
): Promise<Order[]> {
  // Jobs this driver has already refused. Excluded so a decline MEANS something — without
  // it a driver can only ignore an offer, and within a day the jobs they have already
  // said no to crowd out the ones they might take.
  const declined = await db
    .select({ orderId: orderDeclines.orderId })
    .from(orderDeclines)
    .where(and(eq(orderDeclines.tenantId, tenantId), eq(orderDeclines.userId, userId)));
  const declinedIds = declined.map((d) => d.orderId);

  const base = and(
    eq(orders.tenantId, tenantId),
    eq(orders.status, "pending"),
    isNull(orders.assignedUserId),
  );

  return db
    .select()
    .from(orders)
    .where(declinedIds.length > 0 ? and(base, notInArray(orders.id, declinedIds)) : base)
    // Oldest first: the job that has been waiting longest is the one that needs a driver.
    // Newest-first would let old work rot at the bottom of a list nobody scrolls.
    .orderBy(orders.createdAt)
    .limit(limit);
}

/**
 * Refuse an offer.
 *
 * Hides the job from THIS driver and nobody else — a decline is one person's answer, not
 * a verdict on the work. Idempotent by unique index: tapping twice is the same answer.
 */
export async function declineOrder(
  db: Db,
  args: { tenantId: string; orderId: string; userId: string; reason?: string },
): Promise<void> {
  try {
    await db.insert(orderDeclines).values({
      tenantId: args.tenantId,
      orderId: args.orderId,
      userId: args.userId,
      reason: args.reason?.trim() || null,
    });
  } catch (err) {
    // Already declined. Saying no twice is not an error worth showing anyone.
    if (!isUniqueViolation(err, "order_declines_once_idx")) throw err;
  }
}

/**
 * Take an unassigned job.
 *
 * ONE atomic statement. The condition `assigned_user_id IS NULL AND status = 'pending'`
 * lives in the WHERE clause, so two drivers tapping the same job at the same moment
 * resolve in Postgres rather than in application code — the loser updates zero rows and
 * is told, rather than both being sent to the same address.
 *
 * This repo has written the check-then-act version of this twice and been bitten both
 * times. A SELECT to see whether it is free, followed by an UPDATE to take it, is exactly
 * the shape that fails only under the concurrency this feature invites.
 */
export async function claimOrder(
  db: Db,
  args: { tenantId: string; orderId: string; userId: string },
): Promise<Order> {
  // An offer with no amount is not a choice. Refused here rather than rendered as a
  // blank, because a driver accepting an unpriced job has agreed to something nobody
  // has stated — and the argument about what it was worth happens after the work.
  const offered = await findOrder(db, args.tenantId, args.orderId);
  if (offered && offered.driverPayCents === null) {
    throw new OrderValidationError(
      "This job has no driver pay set. Ask the office to price it before accepting.",
    );
  }

  const [claimed] = await db
    .update(orders)
    .set({ assignedUserId: args.userId, status: "assigned", updatedAt: new Date() })
    .where(
      and(
        eq(orders.tenantId, args.tenantId),
        eq(orders.id, args.orderId),
        eq(orders.status, "pending"),
        isNull(orders.assignedUserId),
      ),
    )
    .returning();

  if (!claimed) {
    // Deliberately one message for "someone else took it", "it was cancelled" and "no
    // such job". A driver can act on all three the same way — go back and pick another —
    // and distinguishing them would report on work they are not entitled to see.
    throw new OrderValidationError("That job is no longer available. Someone else may have taken it.");
  }

  await db.insert(orderEvents).values({
    tenantId: args.tenantId,
    orderId: args.orderId,
    actorUserId: args.userId,
    fromStatus: "pending",
    toStatus: "assigned",
    note: "Claimed by driver",
  });

  return claimed;
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

/**
 * How a price reads when there is not one yet.
 *
 * One function, because three surfaces render this — the board, the order page and the
 * closed-jobs table — and two places deciding one presentational question is precisely
 * how `statusTone` came to paint failed deliveries success-green. The word is
 * ACTIONABLE on purpose: "Needs pricing" tells a dispatcher there is something to do,
 * where "—" or "$0.00" reads as a job that is simply cheap.
 */
export const UNPRICED_LABEL = "Needs pricing";

export function formatOrderPrice(cents: number | null): string {
  return cents === null ? UNPRICED_LABEL : formatUsdCents(cents);
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
