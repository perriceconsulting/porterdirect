/**
 * The export pack: the artifact that makes the evidence legible.
 *
 * Everything built into this product recently — the custody trail, the retention
 * guarantee, the access log — is invisible until somebody asks for it, and by then the
 * courier is already in a contract. This is what they hand a hospital's procurement team
 * BEFORE that, and it is the reason the export moved into the evidence spine rather than
 * sitting after it.
 *
 * Three documents, because a buyer asks three different questions:
 *
 *   DELIVERIES  — what did you carry for us, and did it arrive on time?
 *   CUSTODY     — who held it, and when did it change hands?
 *   ACCESS      — who has looked at the evidence since?
 *
 * The third is the one no competitor advertises and the one a HECVAT actually asks about.
 * It is also the strangest to hand over, so it is worth being plain: a courier gives their
 * client the access log to prove that the record has been looked at only by the people who
 * should have looked at it. That is the whole product in one file.
 *
 * CSV rather than PDF because procurement reads these in a spreadsheet and reconciles them
 * against their own system. A PDF is for a person; this is for a person WITH a system.
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accessEvents,
  orderEvents,
  orderProofs,
  orders,
  users,
  type Db,
} from "@porterdirect/db";
import { STATUS_LABELS, TYPE_LABELS } from "@porterdirect/orders";
import { formatUsdCentsExact } from "@porterdirect/billing";
import { csvDocument, csvTimestamp } from "./csv";

export type ExportKind = "deliveries" | "custody" | "access";

export const EXPORT_KINDS: readonly ExportKind[] = ["deliveries", "custody", "access"];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

export interface ExportRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Deliveries in the period, with the facts a buyer reconciles against their own records.
 *
 * `Proof captured` is a yes/no rather than a link: a signed URL expires, and a permanent
 * one to a delivery photograph is the leak this product spends most of its care avoiding.
 * The buyer who wants the image asks for that specific delivery, which is then an access
 * with a name attached — exactly what the third document records.
 */
export async function buildDeliveriesCsv(
  db: Db,
  tenantId: string,
  range: ExportRange,
): Promise<string> {
  const rows = await db
    .select({
      reference: orders.reference,
      type: orders.type,
      status: orders.status,
      createdAt: orders.createdAt,
      scheduledFor: orders.scheduledFor,
      deliveredAt: orders.deliveredAt,
      city: orders.dropoffCity,
      region: orders.dropoffRegion,
      postalCode: orders.dropoffPostalCode,
      priceCents: orders.priceCents,
      closureReason: orders.closureReason,
      proofId: orderProofs.id,
      recipientName: orderProofs.recipientName,
      capturedAt: orderProofs.capturedAt,
    })
    .from(orders)
    .leftJoin(orderProofs, eq(orderProofs.orderId, orders.id))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        gte(orders.createdAt, range.from),
        lte(orders.createdAt, range.to),
      ),
    )
    .orderBy(asc(orders.createdAt));

  return csvDocument(
    [
      "Reference",
      "Type",
      "Status",
      "Created (UTC)",
      "Scheduled for (UTC)",
      "Delivered (UTC)",
      "Destination city",
      "Destination region",
      "Destination postal code",
      "Price",
      "Closure reason",
      "Proof captured",
      "Received by",
      "Proof captured at (UTC)",
    ],
    rows.map((r) => [
      r.reference,
      TYPE_LABELS[r.type],
      STATUS_LABELS[r.status],
      csvTimestamp(r.createdAt),
      csvTimestamp(r.scheduledFor),
      csvTimestamp(r.deliveredAt),
      r.city,
      r.region,
      r.postalCode,
      // Null means NOT YET PRICED, which is a different fact from free. Rendering it as
      // an empty cell rather than $0.00 keeps that distinction in the buyer's copy too.
      r.priceCents === null ? "" : formatUsdCentsExact(r.priceCents),
      r.closureReason,
      r.proofId ? "yes" : "no",
      r.recipientName,
      csvTimestamp(r.capturedAt),
    ]),
  );
}

/**
 * The chain of custody for the same period.
 *
 * Joined to the order so the buyer can line it up against the deliveries file by
 * reference — an internal order id would be meaningless to them and is one more identifier
 * to leak.
 */
export async function buildCustodyCsv(
  db: Db,
  tenantId: string,
  range: ExportRange,
): Promise<string> {
  const inRange = await db
    .select({ id: orders.id, reference: orders.reference })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        gte(orders.createdAt, range.from),
        lte(orders.createdAt, range.to),
      ),
    );
  if (inRange.length === 0) return emptyCustody();

  const referenceOf = new Map(inRange.map((o) => [o.id, o.reference]));
  const events = await db
    .select({
      orderId: orderEvents.orderId,
      createdAt: orderEvents.createdAt,
      fromStatus: orderEvents.fromStatus,
      toStatus: orderEvents.toStatus,
      note: orderEvents.note,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(orderEvents)
    // LEFT join: the actor may be gone. `order_events` deliberately holds no foreign key
    // to `users`, precisely so the trail survives an account being deleted — and a row
    // whose actor has left must still appear in the export, or the deletion becomes a way
    // to erase someone from the record.
    .leftJoin(users, eq(users.id, orderEvents.actorUserId))
    .where(
      and(
        eq(orderEvents.tenantId, tenantId),
        inArray(orderEvents.orderId, inRange.map((o) => o.id)),
      ),
    )
    .orderBy(asc(orderEvents.createdAt));

  return csvDocument(CUSTODY_HEADER, events.map((e) => [
    referenceOf.get(e.orderId) ?? "",
    csvTimestamp(e.createdAt),
    e.fromStatus ? STATUS_LABELS[e.fromStatus] : "",
    STATUS_LABELS[e.toStatus],
    // "(no longer with the company)" rather than a blank: a blank reads as missing data,
    // and this is a known fact rather than an absent one.
    e.actorName ?? (e.actorEmail ? e.actorEmail : "(account removed)"),
    e.note,
  ]));
}

const CUSTODY_HEADER = [
  "Reference",
  "When (UTC)",
  "From",
  "To",
  "By",
  "Note",
] as const;

function emptyCustody(): string {
  return csvDocument(CUSTODY_HEADER, []);
}

/**
 * Who has looked at the evidence.
 *
 * The document that answers the audit-controls question, and the one to read carefully
 * before sending: it names the operator's own staff. That is the point — a courier proves
 * the record was seen only by people who should have seen it — but it is their data as
 * well as their client's, so it is a deliberate act rather than something attached to
 * every invoice.
 */
export async function buildAccessCsv(
  db: Db,
  tenantId: string,
  range: ExportRange,
): Promise<string> {
  const inRange = await db
    .select({ id: orders.id, reference: orders.reference })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        gte(orders.createdAt, range.from),
        lte(orders.createdAt, range.to),
      ),
    );
  if (inRange.length === 0) return csvDocument(ACCESS_HEADER, []);

  const referenceOf = new Map(inRange.map((o) => [o.id, o.reference]));
  const rows = await db
    .select({
      orderId: accessEvents.orderId,
      createdAt: accessEvents.createdAt,
      actorKind: accessEvents.actorKind,
      action: accessEvents.action,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(accessEvents)
    .leftJoin(users, eq(users.id, accessEvents.actorUserId))
    .where(
      and(
        eq(accessEvents.tenantId, tenantId),
        inArray(accessEvents.orderId, inRange.map((o) => o.id)),
      ),
    )
    .orderBy(asc(accessEvents.createdAt));

  return csvDocument(ACCESS_HEADER, rows.map((r) => [
    referenceOf.get(r.orderId ?? "") ?? "",
    csvTimestamp(r.createdAt),
    r.actorKind === "member" ? "Staff" : "Tracking link",
    // A public link genuinely has nobody behind it, and saying so is more honest than a
    // blank cell that reads as missing data.
    r.actorKind === "member" ? (r.actorName ?? r.actorEmail ?? "(account removed)") : "(no account — link holder)",
    ACTION_LABELS[r.action] ?? r.action,
  ]));
  // IP addresses are deliberately NOT exported. They are kept for OUR audit obligations
  // and they identify the operator's customers; handing a list of them to a third party
  // is a disclosure the courier did not ask to make.
}

const ACCESS_HEADER = ["Reference", "When (UTC)", "Who", "Name", "What they opened"] as const;

/** Read by a procurement officer, not a developer. */
const ACTION_LABELS: Record<string, string> = {
  "proof.photo": "Delivery photograph",
  "proof.signature": "Signature",
  "proof.pdf": "Proof-of-delivery certificate",
  "tracking.view": "Tracking page",
};

export async function buildExport(
  db: Db,
  tenantId: string,
  kind: ExportKind,
  range: ExportRange,
): Promise<string> {
  if (kind === "deliveries") return buildDeliveriesCsv(db, tenantId, range);
  if (kind === "custody") return buildCustodyCsv(db, tenantId, range);
  return buildAccessCsv(db, tenantId, range);
}

/** `porterdirect` appears nowhere: this file is handed to the OPERATOR'S client. */
export function exportFilename(kind: ExportKind, range: ExportRange): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return `${kind}-${day(range.from)}-to-${day(range.to)}.csv`;
}
