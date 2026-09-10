/**
 * GET /dashboard/[tenantId]/exports?kind=…&from=…&to=… — the export pack, as CSV.
 *
 * Authorized the same way every console surface is: the request PROPOSES a tenant and the
 * database decides whether this user belongs to it. `orders:read:all` rather than a
 * settings permission, because this is a fleet-wide read of customer data — a driver
 * confined to their own assigned work must not be able to download every delivery the
 * company has ever made.
 *
 * AND THE EXPORT IS ITSELF LOGGED. Downloading a period's custody trail is the largest
 * single read of protected information the product offers, so it writes an audit row like
 * any other access, and fails closed if it cannot. It would be strange to sell an access
 * log that could not see the one action that copies everything out.
 */
import { NextResponse } from "next/server";
import { createDbClient } from "@porterdirect/db";
import { authorize, resolveConsoleMembership } from "@porterdirect/auth";
import { requireUserId } from "../../../../lib/console";
import { recordAccess } from "../../../../lib/access-log";
import {
  buildExport,
  exportFilename,
  isExportKind,
  type ExportRange,
} from "../../../../lib/export-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A UTF-8 byte order mark, constructed rather than typed.
 *
 * Excel on Windows — which is what a procurement team opens this in — otherwise guesses
 * the local codepage and renders accented names and street addresses as mojibake. Every
 * other reader ignores it.
 *
 * HOW it is written matters as much as the mark itself. A literal U+FEFF in source is an
 * invisible character: ESLint's `no-irregular-whitespace` rejects it outside a string,
 * and inside one it silently survives every reformat and diff while being unreadable to
 * whoever maintains this next. `String.fromCharCode` keeps this file pure ASCII, so the
 * intent is legible and nothing in the toolchain can mangle it.
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

/** A day, parsed strictly. An unparseable date must not silently become "now". */
function parseDay(value: string | null, endOfDay: boolean): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<Response> {
  const { tenantId } = await params;
  const userId = await requireUserId();
  const url = new URL(request.url);

  const kind = url.searchParams.get("kind") ?? "";
  if (!isExportKind(kind)) {
    return NextResponse.json({ error: "Unknown export." }, { status: 400 });
  }

  const from = parseDay(url.searchParams.get("from"), false);
  const to = parseDay(url.searchParams.get("to"), true);
  if (!from || !to) {
    return NextResponse.json({ error: "Give a from and to date, as YYYY-MM-DD." }, { status: 400 });
  }
  if (from.getTime() > to.getTime()) {
    // Refused rather than silently swapped: a reversed range usually means the person
    // typed the wrong box, and quietly "fixing" it hands them a document covering a
    // period they did not ask for.
    return NextResponse.json({ error: "The from date is after the to date." }, { status: 400 });
  }

  const db = createDbClient(process.env.DATABASE_URL);
  const membership = await resolveConsoleMembership(db, userId, tenantId);
  // "Not a member" and "no such tenant" answer identically.
  if (!membership) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    authorize(membership, tenantId, "orders:read:all");
  } catch {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const range: ExportRange = { from, to };

  // Logged BEFORE the document is built. If the audit write fails, no export is produced —
  // the same fail-closed rule as every other evidence read, applied to the biggest one.
  await recordAccess(db, {
    accessor: { kind: "member", tenantId, userId },
    action: "export.pack",
    // Not about one order: this covers a period, and pinning it to a single order id would
    // make the log claim something narrower than what actually happened.
    orderId: null,
    objectKey: `${kind}:${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`,
    ipAddress: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent"),
  });

  const csv = await buildExport(db, tenantId, kind, range);

  return new Response(UTF8_BOM + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(kind, range)}"`,
      // Never cached: it is customer data, and a shared cache serving it to the next
      // request is the whole tenant-bleed problem with a file attached.
      "Cache-Control": "private, no-store",
    },
  });
}
