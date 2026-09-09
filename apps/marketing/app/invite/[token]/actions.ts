"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isRedirectError } from "@porterdirect/auth";
import { createDbClient } from "@porterdirect/db";
import { getAuth } from "../../../lib/auth";
import type { TenantRole } from "@porterdirect/auth";
import { InvitationError, acceptInvitation } from "../../../lib/invitations";
import { homePathForRole } from "../../../lib/console";

/**
 * Accept an invitation as the signed-in user.
 *
 * The email match happens inside `acceptInvitation`, not here, so there is exactly one
 * place that decides whether a link belongs to the person holding it.
 */
export async function acceptInvitationAction(data: FormData): Promise<void> {
  // FormData values are string | File; String(File) is "[object Object]", which
  // would then be hashed and looked up as a token.
  const raw = data.get("token");
  const token = typeof raw === "string" ? raw : "";
  if (!token) redirect("/signin");

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect(`/signin?next=${encodeURIComponent(`/invite/${token}`)}`);

  const db = createDbClient(process.env.DATABASE_URL);

  let tenantId: string;
  let role: TenantRole;
  try {
    const result = await acceptInvitation(db, {
      token,
      userId: session.user.id,
      userEmail: session.user.email,
    });
    tenantId = result.tenantId;
    role = result.role;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof InvitationError) {
      redirect(`/invite/${token}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  // Routed by role. Accepting the invitation that brought you onto the platform is a
  // driver's first experience of it, and it used to be a dispatcher's console.
  redirect(homePathForRole(role, tenantId));
}
