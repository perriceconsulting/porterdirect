/**
 * GET /t/:token/proof.pdf — the customer's copy of the certificate.
 *
 * The same document the operator sees, reached by the tracking token instead of a login.
 * This route exists because the receipt email previously linked the CONSOLE route, which
 * requires a session — the customer was emailed a link they could not open. A receipt
 * that only its sender can read is not a receipt.
 *
 * The token is the whole authorization. It resolves to exactly one order through a unique
 * index, and nothing else about the tenant or their other work is reachable from here.
 */
import { eq } from "drizzle-orm";
import { createDbClient, tenants } from "@porterdirect/db";
import { formatAddressLines } from "@porterdirect/contact";
import {
  dropoffAddressOf,
  findOrderByPublicToken,
  findProof,
  pickupAddressOf,
} from "../../../../lib/orders";
import { buildProofPdf } from "../../../../lib/proof-pdf";
import { presignProofDownload } from "../../../../lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fetchBytes(key: string | null): Promise<Uint8Array | null> {
  if (!key) return null;
  try {
    const res = await fetch(await presignProofDownload(key, 120));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    // A missing image must not deny the certificate — the row is the record.
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const db = createDbClient(process.env.DATABASE_URL);

  const order = await findOrderByPublicToken(db, token);
  // One answer for every miss, so this cannot be used to probe which links exist.
  if (!order) return new Response("Not found", { status: 404 });

  const proof = await findProof(db, order.tenantId, order.id);
  if (!proof) return new Response("Not found", { status: 404 });

  const [tenant] = await db
    .select({ name: tenants.name, host: tenants.primaryHost })
    .from(tenants)
    .where(eq(tenants.id, order.tenantId))
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
      // `attachment` here, unlike the console's `inline`: a customer following a link
      // from an email wants the file kept, where an operator wants a look before sending.
      "Content-Disposition": `attachment; filename="delivery-${order.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
