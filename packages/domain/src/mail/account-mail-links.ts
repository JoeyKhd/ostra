import { createHash, randomBytes } from "node:crypto";

import type { Tx } from "@ostra/db";

// The bearer links of the account mails (F-002, ADR 0053; ticket 19). Each is made when its mail is
// sent, held in memory for the send, and never written to a log line, an error, a job's payload or
// the delivery row. An invitation's link is its ID, which is the secret (ADR 0053). A membership's
// verification and a reset each get a fresh token of 256 random bits: only its SHA-256 is kept by
// ostra, and the reset's own row is the one better-auth's `/reset-password` checks (ADR 0003).

/** The SHA-256 of a token, hex: what ostra keeps of a verification or reset token. */
export const accountTokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const freshToken = (): string => randomBytes(32).toString("base64url");

const base = (publicUrl: string): string => publicUrl.replace(/\/+$/, "");

/** The invitation's page (`/invite/[invitation-id]`, ticket 32). */
export const invitationLink = (publicUrl: string, invitationId: string): string => `${base(publicUrl)}/invite/${encodeURIComponent(invitationId)}`;

/** The verification link: the invitation's page with the token (ticket 22 verifies it there). */
export const verificationLink = (publicUrl: string, invitationId: string, token: string): string =>
  `${invitationLink(publicUrl, invitationId)}?verify=${encodeURIComponent(token)}`;

/** The reset link's page (`/reset/new`, ticket 32), where better-auth's reset takes the token. */
export const resetLink = (publicUrl: string, token: string): string => `${base(publicUrl)}/reset/new?token=${encodeURIComponent(token)}`;

/** The `Verification` row's identifier for a membership's verification token: by its hash, never the token. */
export const membershipVerificationIdentifier = (tokenHash: string): string => `ostra-membership-verification:${tokenHash}`;

/**
 * A new verification token for a pending membership, replacing any earlier one: the newest mail's
 * link is the one that works. Its row holds the token's hash as the identifier and the membership's
 * ID as the value. Returns the token, for the link only.
 */
export const mintMembershipVerification = async (tx: Tx, input: { readonly memberId: string; readonly expiresAt: Date }): Promise<string> => {
  const token = freshToken();
  await tx.verification.deleteMany({ where: { identifier: { startsWith: "ostra-membership-verification:" }, value: input.memberId } });
  await tx.verification.create({
    data: { id: randomBytes(16).toString("hex"), identifier: membershipVerificationIdentifier(accountTokenHash(token)), value: input.memberId, expiresAt: input.expiresAt },
  });
  return token;
};

/**
 * A new token for a reset link's grant: better-auth's own reset row (`reset-password:<token>`, the
 * account's ID as its value, the grant's expiry), and the grant's hash of it. An earlier token of
 * the same account is dropped, so only the newest mailed link resets. Returns the token, for the link only.
 */
export const mintPasswordReset = async (tx: Tx, input: { readonly grantId: string; readonly userId: string; readonly expiresAt: Date }): Promise<string> => {
  const token = freshToken();
  await tx.verification.deleteMany({ where: { identifier: { startsWith: "reset-password:" }, value: input.userId } });
  await tx.verification.create({ data: { id: randomBytes(16).toString("hex"), identifier: `reset-password:${token}`, value: input.userId, expiresAt: input.expiresAt } });
  await tx.resetLinkGrant.update({ where: { id: input.grantId }, data: { tokenHash: accountTokenHash(token) } });
  return token;
};
