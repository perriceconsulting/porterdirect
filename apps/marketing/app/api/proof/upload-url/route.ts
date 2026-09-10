/**
 * POST /api/proof/upload-url — mint a short-lived, single-object upload URL.
 *
 * This endpoint hands out write access to object storage, so it authorizes BEFORE it
 * signs anything. The checks, in the order they matter:
 *
 *   1. Signed in at all.
 *   2. A member of the tenant named in the request — resolved by lookup, never trusted
 *      from the body. A tenant id in a request is attacker-controlled; membership is
 *      what makes it real.
 *   3. Holds a permission that covers updating this job.
 *   4. The order exists WITHIN that tenant, so a valid member of tenant A cannot mint a
 *      key under tenant B's prefix by naming B's order.
 *
 * The signed URL is good for one object, one content type, one declared length, for five
 * minutes. Everything the caller could otherwise choose is decided here.
 */
import { NextResponse } from "next/server";
import { createDbClient } from "@porterdirect/db";
import { authorize, resolveConsoleMembership } from "@porterdirect/auth";
import { findOrder } from "../../../../lib/orders";
import { requireUserId } from "../../../../lib/console";
import {
  MAX_PROOF_BYTES,
  StorageNotConfiguredError,
  isAllowedContentType,
  presignProofUpload,
} from "../../../../lib/storage";
import { recordStorageObject } from "../../../../lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireUserId();

  let body: {
    tenantId?: unknown;
    orderId?: unknown;
    kind?: unknown;
    contentType?: unknown;
    contentLength?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const kind = body.kind === "photo" || body.kind === "signature" ? body.kind : null;
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const contentLength = typeof body.contentLength === "number" ? body.contentLength : NaN;

  if (!tenantId || !orderId || !kind) {
    return NextResponse.json({ error: "tenantId, orderId and kind are required." }, { status: 400 });
  }
  if (!isAllowedContentType(contentType)) {
    // Allowlist, not denylist: this decides what can be written into a bucket we serve back.
    return NextResponse.json({ error: "Unsupported image type." }, { status: 400 });
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > MAX_PROOF_BYTES) {
    return NextResponse.json(
      { error: `File must be between 1 byte and ${MAX_PROOF_BYTES / (1024 * 1024)}MB.` },
      { status: 400 },
    );
  }

  const db = createDbClient(process.env.DATABASE_URL);

  const membership = await resolveConsoleMembership(db, userId, tenantId);
  // "Not a member" and "no such tenant" answer identically — confirming a tenant exists
  // is itself information.
  if (!membership) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    authorize(membership, tenantId, "orders:update:assigned");
  } catch {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  // Scoped by BOTH ids, so naming another tenant's order cannot place a key under this
  // tenant's prefix — or reveal that the order exists.
  const order = await findOrder(db, tenantId, orderId);
  if (!order) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    const { url, key } = await presignProofUpload({
      tenantId,
      orderId,
      kind,
      contentType,
      contentLength,
    });

    // Recorded BEFORE the URL is handed out, and this ordering is the whole point.
    //
    // The moment this response leaves, an object we cannot see can appear in the bucket:
    // the device PUTs directly, and nothing reports back. If the ledger row were written
    // afterwards — at proof-capture, say — then every upload whose order failed to save,
    // whose driver closed the app, or whose request we never heard about again would be
    // PHI in our bucket that nothing could name. That is the exact condition this table
    // exists to end, so the row goes first and may legitimately describe an object that
    // never arrives. A ledger entry with no object is harmless; an object with no ledger
    // entry is the reportable one.
    await recordStorageObject(db, {
      tenantId,
      orderId,
      key,
      kind,
      contentType,
      byteSize: contentLength,
    });

    return NextResponse.json({ url, key }, { status: 200 });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      // A configuration failure, not the caller's fault. The message names the missing
      // VARIABLES, never their values.
      console.error(`[proof-upload] ${err.message}`);
      return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
    }
    console.error(
      `[proof-upload] presign failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "Could not prepare the upload." }, { status: 500 });
  }
}
