"use server";

/**
 * Accepting a customer invitation.
 *
 * Built with the driver dead-end already in mind rather than after being bitten by it a
 * second time: almost everyone opening one of these links has never used the product, so
 * CREATING an account is the primary path and signing in is the alternative. The team
 * invite shipped the other way round and was unusable by every driver.
 *
 * And the ordering lesson from the orphaned signup: the invitation, the address match and
 * the password are all checked BEFORE the account is created. A refusal that leaves a user
 * row behind also makes the address unusable on the retry, because it is then "already
 * registered".
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { classifyAuthError, isRedirectError } from "@porterdirect/auth";
import { createDbClient } from "@porterdirect/db";
import { getAuth } from "../../../../lib/auth";
import {
  CustomerAccountError,
  acceptCustomerInvitation,
  findCustomerInvitationByToken,
} from "../../../../lib/customers";
import { validatePassword } from "../../../../lib/password";

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Accept as the person already signed in. */
export async function acceptCustomerInviteAction(data: FormData): Promise<void> {
  const token = field(data, "token");
  if (!token) redirect("/signin");

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect(`/signin?next=${encodeURIComponent(`/portal/invite/${token}`)}`);

  const db = createDbClient(process.env.DATABASE_URL);
  let tenantId: string;
  try {
    const result = await acceptCustomerInvitation(db, {
      token,
      userId: session.user.id,
      userEmail: session.user.email,
    });
    tenantId = result.tenantId;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof CustomerAccountError) {
      redirect(`/portal/invite/${token}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect(`/portal/${tenantId}`);
}

/** Create an account and accept, in one step — the ordinary path. */
export async function acceptCustomerInviteWithNewAccountAction(data: FormData): Promise<void> {
  const token = field(data, "token");
  if (!token) redirect("/signin");

  const back = (message: string): never => {
    redirect(`/portal/invite/${token}?error=${encodeURIComponent(message)}`);
  };

  const firstName = field(data, "firstName");
  const lastName = field(data, "lastName");
  const email = field(data, "email");
  const password = data.get("password");
  if (!firstName || !lastName || !email || typeof password !== "string" || !password) {
    back("Fill in every field to create your account.");
  }

  const db = createDbClient(process.env.DATABASE_URL);

  const invitation = await findCustomerInvitationByToken(db, token);
  if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() < Date.now()) {
    back("This invitation link is not valid. Ask the company that sent it for a new one.");
  }
  if (invitation!.email !== email.toLowerCase()) {
    // Says the address is wrong without naming the invited one — the page discloses
    // nothing to whoever holds a forwarded link.
    back("That email address does not match this invitation.");
  }

  const passwordProblem = await validatePassword(password as string, { email });
  if (passwordProblem) back(passwordProblem);

  let userId: string;
  try {
    const result = await getAuth().api.signUpEmail({
      body: {
        email,
        password: password as string,
        name: [firstName, lastName].filter(Boolean).join(" "),
        firstName,
        lastName,
      },
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    const failure = classifyAuthError(err);
    if (failure === "email-taken") {
      back("An account already exists for that address. Sign in instead, then open this link again.");
    }
    console.error("[customer-invite]", err instanceof Error ? err.message : err);
    back("Could not create your account. Try again.");
  }

  let tenantId: string;
  try {
    // Through the SAME function the signed-in path uses, so one place decides whether a
    // link belongs to the person holding it.
    const result = await acceptCustomerInvitation(db, { token, userId: userId!, userEmail: email });
    tenantId = result.tenantId;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof CustomerAccountError) back(err.message);
    throw err;
  }

  redirect(`/portal/${tenantId}`);
}

/** Sign out and come back here, for someone signed in as the wrong account. */
export async function signOutAndReturnToCustomerInviteAction(data: FormData): Promise<void> {
  const raw = data.get("token");
  const token = typeof raw === "string" ? raw : "";
  // Fixed prefix, and the token checked against the alphabet it is minted from — a form
  // value interpolated into a redirect is the classic open-redirect shape.
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(token);

  await getAuth().api.signOut({ headers: await headers() });
  redirect(safe ? `/portal/invite/${token}` : "/signin");
}
