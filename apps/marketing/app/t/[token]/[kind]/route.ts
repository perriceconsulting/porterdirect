/**
 * GET /t/:token/:kind — the evidence image, served from OUR origin.
 *
 * This exists because of a leak that got all the way to a working page. The customer
 * tracking view originally embedded the storage provider's signed URL directly, which put
 * `.../porterdirect-pod/tenants/<tenant-id>/orders/<order-id>/...` into the `src`
 * attribute. The page LOOKED anonymous — the visible text named only the operator — and
 * anyone who viewed source, or right-clicked the photo and copied the link, saw our
 * product name and the operator's internal ids.
 *
 * The e2e asserted against `innerText`, so it could not see an attribute. That is the
 * lesson worth keeping: on a white-label surface, "does our name appear" has to be asked
 * of the whole RESPONSE, not of the words a person reads.
 *
 * Proxying costs a hop the direct URL did not. Worth it here and only here: uploads still
 * go direct from the device because a phone photo exceeds the request body limit, and the
 * operator's own console keeps signed URLs because the operator already knows who we are.
 */
import { createDbClient } from "@porterdirect/db";
import { findOrderByPublicToken, findProof } from "../../../../lib/orders";
import { openEvidence } from "../../../../lib/access-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; kind: string }> },
): Promise<Response> {
  const { token, kind } = await params;
  if (kind !== "photo" && kind !== "signature") {
    return new Response("Not found", { status: 404 });
  }

  const db = createDbClient(process.env.DATABASE_URL);
  const order = await findOrderByPublicToken(db, token);
  // One answer for every miss, so this cannot be used to probe which links exist.
  if (!order) return new Response("Not found", { status: 404 });

  const proof = await findProof(db, order.tenantId, order.id);
  const key = kind === "photo" ? proof?.photoKey : proof?.signatureKey;
  if (!key) return new Response("Not found", { status: 404 });

  // A public link has no identity behind it, and that absence is itself the fact worth
  // recording — "a stranger holding this link opened the photo" is exactly the question
  // an operator gets asked after a dispute. IP and user agent are taken from the request
  // where present and recorded as absent where not, never invented.
  const signed = await openEvidence(db, {
    key,
    accessor: { kind: "public_link", tenantId: order.tenantId },
    action: kind === "photo" ? "proof.photo" : "proof.signature",
    orderId: order.id,
    ipAddress: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent"),
    expiresIn: 120,
  });

  const upstream = await fetch(signed);
  if (!upstream.ok) return new Response("Not found", { status: 404 });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      // Private and short-lived: this is one customer's delivery photograph, and it must
      // never sit in a shared cache where the next request could be served it.
      "Cache-Control": "private, max-age=300",
      // Never echo the upstream host, the bucket, or the object key in a header either.
    },
  });
}
