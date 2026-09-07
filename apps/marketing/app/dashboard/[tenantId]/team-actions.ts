"use server";

/**
 * Team actions: invite, and withdraw an invite.
 *
 * Both re-resolve the tenant and re-authorize. The role being granted is checked against
 * the INVITER's role separately from "may they manage members at all" — those are
 * different questions, and collapsing them is how an ops user invites themselves an
 * owner account.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { RoleEscalationError, isRedirectError, type TenantRole } from "@porterdirect/auth";
import { requireConsole } from "../../../lib/console";
import { InvitationError, createInvitation, revokeInvitation } from "../../../lib/invitations";
import { sendEmail } from "../../../lib/email";

const ROLES: readonly TenantRole[] = ["owner", "ops", "dispatcher", "driver"];

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function inviteMemberAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  const { db, tenant, membership, userId } = await requireConsole(tenantId, "members:manage");
  const back = `/dashboard/${tenantId}`;

  const role = field(data, "role") as TenantRole;
  if (!ROLES.includes(role)) redirect(`${back}?error=${encodeURIComponent("Choose a role.")}`);

  let token: string;
  let email: string;
  try {
    const result = await createInvitation(db, {
      tenantId,
      inviterRole: membership.role,
      inviterUserId: userId,
      email: field(data, "email"),
      role,
    });
    token = result.token;
    email = result.invitation.email;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof RoleEscalationError || err instanceof InvitationError) {
      redirect(`${back}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  try {
    await sendEmail({
      to: email,
      subject: `You have been invited to ${tenant.name} on PorterDirect`,
      text:
        `You have been invited to join ${tenant.name} as a ${role}.\n\n` +
        `${origin}/invite/${token}\n\n` +
        `This link works once and expires in seven days. It only works when signed in ` +
        `as ${email}.`,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    // The invite row exists but the mail did not go. Say so — silently reporting
    // success would leave someone waiting for a message that will never arrive.
    console.error("[invite] send failed:", err instanceof Error ? err.message : err);
    redirect(
      `${back}?error=${encodeURIComponent(
        `Invite created for ${email}, but the email could not be sent. Withdraw it and try again once email is configured.`,
      )}`,
    );
  }

  revalidatePath(back);
  redirect(`${back}?invited=${encodeURIComponent(email)}`);
}

export async function revokeInvitationAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  const invitationId = field(data, "invitationId");
  if (!tenantId || !invitationId) redirect("/dashboard");

  const { db } = await requireConsole(tenantId, "members:manage");
  await revokeInvitation(db, { tenantId, invitationId });

  revalidatePath(`/dashboard/${tenantId}`);
  redirect(`/dashboard/${tenantId}`);
}
