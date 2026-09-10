"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isRedirectError } from "@porterdirect/auth";
import { createDbClient } from "@porterdirect/db";
import { getAuth } from "../../../lib/auth";
import type { TenantRole } from "@porterdirect/auth";
import { InvitationError, acceptInvitation, findInvitationByToken } from "../../../lib/invitations";
import { homePathForRole } from "../../../lib/console";
import { validatePassword } from "../../../lib/password";
import { classifyAuthError } from "@porterdirect/auth";

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

/**
 * Create an account AND accept the invitation, in one step.
 *
 * This exists because the invite flow was a dead end for exactly the people it is for.
 * An invited driver received a link, was told to "sign in to accept", and had no account
 * — the only other route off the sign-in page was "Start a subscription", which is the
 * OPERATOR path: it would have created them their own tenant and sent them to Stripe.
 * So the entire team-invite feature was unusable by every driver, which is all of them.
 * Same class as `/drive` existing and being unreachable: a surface nobody can get to is
 * not built.
 *
 * The account is deliberately created WITHOUT a tenant of its own. Membership comes from
 * the invitation and nowhere else, so nothing here can mint an owner.
 *
 * ORDER IS LOAD-BEARING, and it is the lesson from the orphaned-signup bug: the
 * invitation, the address match and the password are ALL checked before the account is
 * created. Getting this wrong leaves a user row with no membership, and — worse — makes
 * the address unusable on the retry, because it is then "already registered".
 */
export async function acceptInviteWithNewAccountAction(data: FormData): Promise<void> {
  const field = (key: string): string => {
    const v = data.get(key);
    return typeof v === "string" ? v.trim() : "";
  };

  const token = field("token");
  if (!token) redirect("/signin");

  const back = (message: string): never => {
    redirect(`/invite/${token}?error=${encodeURIComponent(message)}`);
  };

  const firstName = field("firstName");
  const lastName = field("lastName");
  const email = field("email");
  const password = data.get("password");
  if (!firstName || !lastName || !email || typeof password !== "string" || !password) {
    back("Fill in every field to create your account.");
  }

  const db = createDbClient(process.env.DATABASE_URL);

  // 1. Is the invitation real, and is it theirs? Checked first, so a bad link never
  //    creates an account.
  const invitation = await findInvitationByToken(db, token);
  if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() < Date.now()) {
    back("This invitation link is not valid. Ask whoever invited you for a new one.");
  }
  if (invitation!.email !== email.toLowerCase()) {
    // Says the address is wrong WITHOUT naming the invited one. The person holding a
    // legitimate link already knows it — the email that carried the link says so — and
    // whoever holds a forwarded one learns nothing new.
    back("That email address does not match this invitation.");
  }

  // 2. Same password policy as every other way into the product. An invitation is not a
  //    route to a weaker password.
  const passwordProblem = await validatePassword(password as string, { email });
  if (passwordProblem) back(passwordProblem);

  // 3. Only now create the account.
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
    if (failure === "weak-password") back("Choose a stronger password.");
    console.error("[invite-signup]", err instanceof Error ? err.message : err);
    back("Could not create your account. Try again.");
  }

  // 4. And accept, through the SAME function the signed-in path uses — one place decides
  //    whether a link belongs to the person holding it.
  let tenantId: string;
  let role: TenantRole;
  try {
    const result = await acceptInvitation(db, { token, userId: userId!, userEmail: email });
    tenantId = result.tenantId;
    role = result.role;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof InvitationError) back(err.message);
    throw err;
  }

  redirect(homePathForRole(role, tenantId));
}
