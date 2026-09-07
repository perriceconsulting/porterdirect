/**
 * GET /api/me — who is asking, which tenant they are asking about, and as what role.
 *
 * The tenant comes from the HOST, never from the request. Every field below is derived
 * server-side from the session cookie plus the Host header, so a client cannot widen its
 * own scope by asking differently.
 *
 * Status codes carry meaning:
 *   404 — this host belongs to no tenant. Not a redirect to a default tenant; there
 *         isn't one, because a fallback would serve one licensee's data on another's.
 *   401 — no session.
 *   403 — signed in, but not a member of THIS tenant. Distinct from 401 on purpose:
 *         "you are nobody here" is a different fact from "you are nobody".
 */
import { NextResponse } from "next/server";
import { getRequestContext } from "../../../lib/auth";
import { permissionsFor } from "@porterdirect/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const { tenant, userId, membership } = await getRequestContext();

  if (!tenant) {
    return NextResponse.json({ error: "No tenant for this host" }, { status: 404 });
  }
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!membership) {
    return NextResponse.json(
      { error: "Not a member of this tenant" },
      { status: 403 },
    );
  }

  return NextResponse.json(
    {
      userId,
      tenant: { id: tenant.id, name: tenant.name },
      role: membership.role,
      permissions: permissionsFor(membership.role),
    },
    // Never cached, and never stored by a shared cache: this response is identity.
    { status: 200, headers: { "cache-control": "private, no-store" } },
  );
}
