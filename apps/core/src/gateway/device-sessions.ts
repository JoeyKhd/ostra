import type { Db, Tx } from "@ostra/db";
import { deviceSessionIdSchema } from "@ostra/domain";
import type { DeviceSessionId, DeviceSessionOwner } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";

// The member's device session, as a personal runner presents it at `POST /runner/v1/register`
// (ADR 0029, Q115). better-auth's device flow hands the runner a full session token of the member
// who approved the code (spike 9, Surprise 5); with the bearer plugin it's that session's token.
// Core checks it against the session table better-auth keeps, and revokes it by deleting the row,
// which is what better-auth's own revoke does. Never logged.

export type DeviceSessions = {
  /** Who the session belongs to, in its active organization; `null` when it's unknown or expired. */
  readonly verify: (token: string) => Promise<DeviceSessionOwner | null>;
  /**
   * Revokes the session in the caller's transaction, so it goes only if the runner was created.
   * `false` when no session was left to revoke: another register used it first (Q115).
   */
  readonly revokeInTx: (tx: Tx, sessionId: DeviceSessionId) => Promise<boolean>;
};

export const postgresDeviceSessions = (db: Db, now: () => number = Date.now): DeviceSessions => ({
  verify: async (token) => {
    if (token.length < 16 || token.length > 512) {
      return null;
    }
    const session = await db.authSession.findUnique({
      where: { token },
      select: { id: true, userId: true, expiresAt: true, activeOrganizationId: true },
    });
    if (session === null || session.expiresAt.getTime() <= now()) {
      return null;
    }
    // The session's active organization; a device session often has none, and then the member's
    // only organization is the one (with several, the member picks one in the panel first).
    const memberships = await db.member.findMany({
      where: {
        userId: session.userId,
        ...(session.activeOrganizationId === null ? {} : { organizationId: session.activeOrganizationId }),
      },
      select: { id: true, organizationId: true },
      take: 2,
    });
    const [member, another] = memberships;
    if (member === undefined || another !== undefined) {
      return null;
    }
    return {
      sessionId: deviceSessionIdSchema.parse(session.id),
      memberId: memberIdSchema.parse(member.id),
      organizationId: organizationIdSchema.parse(member.organizationId),
    };
  },
  revokeInTx: async (tx, sessionId) => {
    // A register racing this one waits here on the row, and finds it gone once the first commits.
    const revoked = await tx.authSession.deleteMany({ where: { id: sessionId } });
    return revoked.count === 1;
  },
});
