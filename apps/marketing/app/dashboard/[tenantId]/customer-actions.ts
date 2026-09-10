"use server";

/**
 * Inviting a customer.
 *
 * The console had a "Customer accounts" panel with a signup-mode toggle and no way to
 * actually invite anybody — a setting for a feature with no door, which is the same
 * failure as `/drive` existing and being unreachable.
 *
 * `tenant:settings` rather than `members:manage`: opening a customer account is a
 * commercial decision about who the firm deals with, not a change to who can operate the
 * platform. A customer holds no permission, so this cannot escalate anything.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "@porterdirect/auth";
import { requireConsole } from "../../../lib/console";
import {
  CustomerAccountError,
  inviteCustomer,
  revokeCustomerInvitation,
  setCustomerStatus,
} from "../../../lib/customers";
import { sendEmail } from "../../../lib/email";

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function inviteCustomerAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  const { db, tenant, userId } = await requireConsole(tenantId, "tenant:settings");
  const base = `/dashboard/${tenantId}`;
  const email = field(data, "email");

  let token: string;
  try {
    const result = await inviteCustomer(db, {
      tenantId,
      email,
      companyName: field(data, "companyName") || null,
      invitedByUserId: userId,
    });
    token = result.token;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof CustomerAccountError) {
      redirect(`${base}?customerError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  // The raw token exists only here and in the message. It is never persisted and never
  // logged — the stored form is a SHA-256, so a database dump is not a set of working keys.
  const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  try {
    await sendEmail({
      to: email,
      // The OPERATOR'S name, not ours. This is the first thing their client reads.
      subject: `${tenant.name} has set you up to book deliveries online`,
      text:
        `${tenant.name} has given you an account to book and track deliveries.\n\n` +
        `${origin}/portal/invite/${token}\n\n` +
        `This link works once and expires in seven days. It only works when signed in as ${email}.`,
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    // The invitation EXISTS whether or not the mail went. Reporting failure without
    // saying that would send the operator round to create a second one, which the
    // "already invited" rule would then refuse — a confusing dead end built out of a
    // transient mail problem.
    console.error("[customer-invite] send failed:", err instanceof Error ? err.message : err);
    redirect(
      `${base}?customerError=${encodeURIComponent(
        "The invitation was created but the email could not be sent. Withdraw it and try again.",
      )}`,
    );
  }

  revalidatePath(base);
  redirect(`${base}?customerInvited=${encodeURIComponent(email)}`);
}

export async function revokeCustomerInvitationAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  const invitationId = field(data, "invitationId");
  if (!tenantId || !invitationId) redirect("/dashboard");

  const { db } = await requireConsole(tenantId, "tenant:settings");
  // Scoped by tenant inside the delete, so one operator cannot withdraw another's.
  await revokeCustomerInvitation(db, tenantId, invitationId);

  revalidatePath(`/dashboard/${tenantId}`);
  redirect(`/dashboard/${tenantId}`);
}

/**
 * Block or unblock a customer account.
 *
 * Blocking rather than deleting, deliberately: the row carries the provenance of every job
 * they ever booked, and removing it would erase who asked for that work.
 */
export async function setCustomerStatusAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  const customerId = field(data, "customerId");
  const status = field(data, "status");
  if (!tenantId || !customerId) redirect("/dashboard");
  if (status !== "active" && status !== "blocked") redirect(`/dashboard/${tenantId}`);

  const { db } = await requireConsole(tenantId, "tenant:settings");
  await setCustomerStatus(db, tenantId, customerId, status);

  revalidatePath(`/dashboard/${tenantId}`);
  redirect(`/dashboard/${tenantId}`);
}
