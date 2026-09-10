/**
 * Audit logging for reads of protected evidence.
 *
 * HIPAA §164.312(b), and — per the competitor research — the one control no incumbent
 * advertises. It is also the thing a HECVAT actually asks about, which makes it the
 * durable wedge in a way a SOC 2 badge is not, since several competitors already hold one.
 *
 * THE DESIGN DECISION THAT MATTERS: this is not a logging call sprinkled at each of the
 * six places that serve evidence. `presignProofDownload` was renamed to
 * `presignProofDownloadUnaudited`, and `openEvidence` below is the ordinary path — so a
 * seventh call site cannot be written without either naming an accessor or typing the
 * word "unaudited", which `verify:conventions` then fails on. A rule a checker enforces
 * survives; a rule in a comment erodes.
 *
 * IT FAILS CLOSED. If the audit write fails, no URL is issued and the caller sees an
 * error. That is the uncomfortable choice and it is deliberate: the alternative serves
 * PHI with no record, silently, which is the exact gap this closes. For a product whose
 * pitch is "we can evidence every access", an access that cannot be evidenced must not
 * happen. The cost is that a database problem blocks evidence viewing — visible, loud,
 * and recoverable, which is the failure you want.
 */
import { and, desc, eq, lte } from "drizzle-orm";
import { accessEvents, type AccessEvent, type Db } from "@porterdirect/db";
import { presignProofDownloadUnaudited } from "./storage";
import { retainUntil } from "./retention";

/** What was reached. A closed set, because a free-text action cannot be counted. */
export type AccessAction =
  | "proof.photo"
  | "proof.signature"
  | "proof.pdf"
  | "tracking.view"
  /**
   * A period's worth of records copied out at once — the largest single read the product
   * offers. It would be strange to sell an access log that could not see the one action
   * that takes everything.
   */
  | "export.pack";

/**
 * Who is asking.
 *
 * A public link genuinely has no identity behind it. Modelling that as its own case
 * rather than a null user id keeps the distinction between "a stranger holding a link"
 * and "a member we failed to identify" — which are different findings in an audit.
 */
export type Accessor =
  | { readonly kind: "member"; readonly tenantId: string; readonly userId: string }
  | { readonly kind: "public_link"; readonly tenantId: string };

export interface AccessContext {
  readonly accessor: Accessor;
  readonly action: AccessAction;
  readonly orderId: string | null;
  readonly objectKey?: string | null;
  /** From request headers. Absent is fine and recorded as absent, never invented. */
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export class AccessNotRecordedError extends Error {
  constructor(cause: unknown) {
    super("Could not record this access, so it was refused.");
    this.name = "AccessNotRecordedError";
    this.cause = cause;
  }
}

/** Write one audit row. Throws — see the fail-closed note above. */
export async function recordAccess(db: Db, ctx: AccessContext): Promise<void> {
  try {
    await db.insert(accessEvents).values({
      tenantId: ctx.accessor.tenantId,
      orderId: ctx.orderId,
      actorKind: ctx.accessor.kind,
      actorUserId: ctx.accessor.kind === "member" ? ctx.accessor.userId : null,
      action: ctx.action,
      objectKey: ctx.objectKey ?? null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      // Same clock as the evidence, from the same helper — so the log cannot outlive what
      // it describes, and cannot be shortened retroactively either.
      retainUntil: retainUntil(),
    });
  } catch (err) {
    throw new AccessNotRecordedError(err);
  }
}

/**
 * Mint a short-lived URL to a piece of evidence, and record that it happened.
 *
 * The audit row is written FIRST. If it fails, no URL exists — which is the whole point.
 * Writing it afterwards would mean a URL had already been handed out by the time the
 * record failed, and a URL is the access.
 */
export async function openEvidence(
  db: Db,
  args: {
    readonly key: string;
    readonly accessor: Accessor;
    readonly action: Extract<AccessAction, "proof.photo" | "proof.signature" | "proof.pdf">;
    readonly orderId: string | null;
    readonly ipAddress?: string | null;
    readonly userAgent?: string | null;
    readonly expiresIn?: number;
  },
): Promise<string> {
  await recordAccess(db, {
    accessor: args.accessor,
    action: args.action,
    orderId: args.orderId,
    objectKey: args.key,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
  return presignProofDownloadUnaudited(args.key, args.expiresIn);
}

/** Everything that touched one job — the operator's question, and a subpoena's. */
export async function listAccessForOrder(
  db: Db,
  tenantId: string,
  orderId: string,
  limit = 200,
): Promise<readonly AccessEvent[]> {
  return db
    .select()
    .from(accessEvents)
    .where(and(eq(accessEvents.tenantId, tenantId), eq(accessEvents.orderId, orderId)))
    .orderBy(desc(accessEvents.createdAt))
    .limit(limit);
}

/**
 * Delete audit rows past their retention date.
 *
 * A plain delete rather than a tombstone, unlike the object sweep: there is no external
 * artifact to fall out of step with, so a row that is gone IS the record of expiry. The
 * count is returned so a scheduled run can be reported rather than assumed.
 */
export async function purgeExpiredAccessEvents(
  db: Db,
  now: Date = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: accessEvents.id })
    .from(accessEvents)
    .where(lte(accessEvents.retainUntil, now));
  for (const row of due) {
    await db.delete(accessEvents).where(eq(accessEvents.id, row.id));
  }
  return due.length;
}
