import * as z from "zod";
import { collectLinks } from "../auth/link-sink.ts";
import type { OstraAuth } from "../auth/create-auth.ts";
import { InvitationId } from "../ids.ts";
import type { UserId } from "../ids.ts";

// The two links an install without a mail server has to hand over by hand.

// ---- Invite link ---------------------------------------------------------

/**
 * An invite is a link the admin copies. better-auth stores the invitation and
 * names it by ID; the page that accepts it is ostra's, so ostra builds the URL.
 * (With a mail server, the same URL would go in the mail.)
 *
 * The ID in the link is the invitation's secret: sign-up checks it together
 * with the invited address (see `INVITATION_HEADER`), so whoever holds the link
 * can claim the invitation, and nobody else can.
 */
export const buildInviteLink = (panelUrl: string, invitationId: InvitationId): string =>
  `${panelUrl.replace(/\/+$/, "")}/accept-invitation/${encodeURIComponent(invitationId)}`;

const inviteLinkSchema = z.url().transform((value, context) => {
  const match = /\/accept-invitation\/([^/?#]+)$/.exec(new URL(value).pathname);
  if (match?.[1] === undefined) {
    context.addIssue({ code: "custom", message: "not an invite link" });
    return z.NEVER;
  }
  const parsed = InvitationId.safeParse(decodeURIComponent(match[1]));
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "not an invitation ID" });
    return z.NEVER;
  }
  return parsed.data;
});

/** The invitation ID in a pasted invite link, or null if it is not one. */
export const parseInviteLink = (link: string): InvitationId | null => {
  const parsed = inviteLinkSchema.safeParse(link);
  return parsed.success ? parsed.data : null;
};

// ---- Reset link ----------------------------------------------------------

export type ResetLinkResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: "unauthenticated" | "not-instance-admin" | "no-such-account" | "no-link-produced";
    };

/**
 * Q54: without a mail server, an admin creates a one-time reset link for a
 * member who forgot their password.
 *
 * Only an instance admin may. An account belongs to every organization its
 * owner has joined, so an organization admin who could reset a password could
 * take over a member's account in organizations they do not administer.
 */
export const createResetLink = async (
  auth: OstraAuth,
  headers: Headers,
  targetUserId: UserId,
  redirectTo: string,
): Promise<ResetLinkResult> => {
  const session = await auth.api.getSession({ headers });
  if (session === null) {
    return { ok: false, reason: "unauthenticated" };
  }
  const permission = await auth.api.userHasPermission({
    body: { userId: session.user.id, permissions: { user: ["set-password"] } },
  });
  if (!permission.success) {
    return { ok: false, reason: "not-instance-admin" };
  }
  const target = await auth.api.getUser({ query: { id: targetUserId }, headers });
  const { links } = await collectLinks(() =>
    auth.api.requestPasswordReset({ body: { email: target.email, redirectTo } }),
  );
  if (links.reset === undefined) {
    return { ok: false, reason: "no-link-produced" };
  }
  if (links.reset.userId !== targetUserId) {
    return { ok: false, reason: "no-such-account" };
  }
  return { ok: true, url: links.reset.url };
};
