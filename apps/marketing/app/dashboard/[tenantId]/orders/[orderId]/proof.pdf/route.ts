/**
 * GET /dashboard/:tenantId/orders/:orderId/proof.pdf — the delivery certificate.
 *
 * A route handler rather than a stored file. The PDF is DERIVED from the proof row and
 * the two images, so generating it on demand means there is exactly one copy of the
 * truth: correcting a recipient's name corrects every future certificate, where a stored
 * PDF would quietly keep the old one and nothing would say which was right.
 *
 * Authorized like any other tenant-scoped read, and scoped by BOTH ids — an order id is
 * not a capability.
 */
import { eq } from "drizzle-orm";
import { createDbClient, tenants } from "@porterdirect/db";
import { authorize, can, resolveConsoleMembership } from "@porterdirect/auth";
import { formatAddressLines } from "@porterdirect/contact";
import { requireUserId } from "../../../../../../lib/console";
import {
  dropoffAddressOf,
  findOrder,
  findProof,
  pickupAddressOf,
} from "../../../../../../lib/orders";
import { buildProofPdf } from "../../../../../../lib/proof-pdf";
import { presignProofDownload } from "../../../../../../lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fetch one object's bytes through a short-lived signed URL. Never throws the request. */
async function fetchBytes(key: string | null): Promise<Uint8Array | null> {
  if (!key) return null;
  try {
    const res = await fetch(await presignProofDownload(key, 120));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    // A missing image must not deny the certificate. The row is the record; the pictures
    // support it, and a receipt that refuses to exist because one image is unreachable is
    // worse than one that says "not captured".
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string; orderId: string }> },
): Promise<Response> {
  const { tenantId, orderId } = await params;
  const userId = await requireUserId();

  const db = createDbClient(process.env.DATABASE_URL);
  const membership = await resolveConsoleMembership(db, userId, tenantId);
  // "Not a member" and "no such tenant" answer identically: confirming a tenant exists is
  // itself information.
  if (!membership) return new Response("Not found", { status: 404 });
  authorize(membership, tenantId, "orders:read:assigned");

  const order = await findOrder(db, tenantId, orderId);
  if (!order) return new Response("Not found", { status: 404 });

  // Same rule as the order page: a driver may only reach their own work.
  const mayView = can(membership.role, "orders:read:all") || order.assignedUserId === userId;
  if (!mayView) return new Response("Not found", { status: 404 });

  const proof = await findProof(db, tenantId, orderId);
  if (!proof) return new Response("No proof of delivery has been recorded", { status: 404 });

  // Scoped in the WHERE clause. Selecting every tenant and picking one in JavaScript is
  // the shape this codebase keeps recording as the way a leak gets written.
  const [tenant] = await db
    .select({ name: tenants.name, host: tenants.primaryHost })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return new Response("Not found", { status: 404 });

  const [signature, photo] = await Promise.all([
    fetchBytes(proof.signatureKey),
    fetchBytes(proof.photoKey),
  ]);

  const pdf = await buildProofPdf({
    operatorName: tenant.name,
    operatorDomain: tenant.host,
    reference: order.reference,
    customerName: `${order.customerFirstName} ${order.customerLastName}`,
    pickupLines: formatAddressLines(pickupAddressOf(order)),
    dropoffLines: formatAddressLines(dropoffAddressOf(order)),
    recipientName: proof.recipientName,
    capturedAt: proof.capturedAt,
    lat: proof.capturedLat,
    lng: proof.capturedLng,
    accuracyM: proof.capturedAccuracyM,
    signature,
    photo,
  });

  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so it opens in the browser's viewer — an operator usually wants to LOOK
      // at it before sending it on. The filename carries the reference so a saved copy is
      // identifiable without opening it.
      "Content-Disposition": `inline; filename="proof-${order.reference}.pdf"`,
      // Never cached by a shared proxy: this is a tenant's customer's evidence.
      "Cache-Control": "private, no-store",
    },
  });
}
