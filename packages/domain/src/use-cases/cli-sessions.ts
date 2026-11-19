import { createHash, randomBytes } from "node:crypto";

import type { Db } from "@ostra/db";
import { cliSessionIdSchema, cliSessionMessages, memberIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import type { CliHttpErrorCode, CliSessionId, MemberId, OrganizationId, UserId } from "@ostra/protocol";

import type { Clock } from "../ports.ts";
import type { RevokeCliSession, StartCliSession } from "./m3-signatures.ts";

// CLI sessions (F-103, ADR 0051; ticket 39): a member's `ostra login`. The session is a random token
// the CLI is shown once; only its SHA-256 is stored. It reads branch names and clone URLs for
// `ostra checkout` and nothing else: it is no login session, and no tRPC procedure accepts it. A
// token and its hash are never logged or audited: IDs only.

/** The prefix every CLI token carries (the protocol's `cliSessionTokenSchema`). */
export const CLI_TOKEN_PREFIX = "ostra_cli_";

/** How long a session lasts unless the caller says (`OSTRA_CLI_SESSION_DAYS`). */
export const DEFAULT_CLI_SESSION_DAYS = 30;

const DAY_MS = 86_400_000;

/** The stored form of a token. */
export const hashCliToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const startCliSession: StartCliSession = async (deps, input) => {
  const token = `${CLI_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = deps.clock.now();
  const expiresAt = now + (input.sessionDays ?? DEFAULT_CLI_SESSION_DAYS) * DAY_MS;
  return deps.db.$transaction(async (tx) => {
    const member = await tx.member.findFirst({ where: { id: input.memberId, userId: input.userId }, select: { id: true, organizationId: true } });
    if (member === null) {
      throw new Error("a CLI session needs a member of the user");
    }
    const created = await tx.cliSession.create({
      data: {
        organizationId: member.organizationId,
        memberId: member.id,
        userId: input.userId,
        tokenHash: hashCliToken(token),
        name: input.machineName.trim().slice(0, 128) || "unnamed machine",
        createdAt: new Date(now),
        expiresAt: new Date(expiresAt),
      },
      select: { id: true },
    });
    const sessionId = cliSessionIdSchema.parse(created.id);
    await deps.audit.recordInTx(tx, {
      organizationId: organizationIdSchema.parse(member.organizationId),
      projectId: null,
      actor: { kind: "member", id: member.id },
      action: "cli-session.started",
      entity: "member",
      entityId: memberIdSchema.parse(member.id),
      data: { sessionId },
    });
    return { ok: true, sessionId, token, expiresAt } as const;
  });
};

export const revokeCliSession: RevokeCliSession = async (deps, actor, input) =>
  deps.db.$transaction(async (tx) => {
    const session = await tx.cliSession.findUnique({ where: { id: input.sessionId } });
    // Another account's session does not exist for the caller.
    if (session?.userId !== actor.userId) {
      return { ok: false, error: "not-found", message: "No such CLI session" } as const;
    }
    if (session.revokedAt === null) {
      await tx.cliSession.update({ where: { id: session.id }, data: { revokedAt: new Date(deps.clock.now()) } });
      await deps.audit.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(session.organizationId),
        projectId: null,
        actor: { kind: "member", id: session.memberId },
        action: "cli-session.revoked",
        entity: "member",
        entityId: memberIdSchema.parse(session.memberId),
        data: { sessionId: input.sessionId },
      });
    }
    return { ok: true, sessionId: input.sessionId } as const;
  });

/** Who a CLI request acts as. */
export type CliSessionCaller = {
  readonly sessionId: CliSessionId;
  readonly userId: UserId;
  readonly memberId: MemberId;
  readonly organizationId: OrganizationId;
};

export type ResolveCliSessionResult =
  | { readonly ok: true; readonly caller: CliSessionCaller }
  | { readonly ok: false; readonly code: Extract<CliHttpErrorCode, `session-${string}`>; readonly message: string };

/** `lastUsedAt` is written at most this often, so a busy CLI does not write on every call. */
const LAST_USED_GRANULARITY_MS = 60_000;

/**
 * The session behind a CLI token, or why there is none: missing (no token, or one nobody holds),
 * expired, or revoked. The messages are the ones the CLI prints.
 */
export const resolveCliSession = async (deps: { readonly db: Db; readonly clock: Clock }, authorization: string | null): Promise<ResolveCliSessionResult> => {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token?.startsWith(CLI_TOKEN_PREFIX)) {
    return { ok: false, code: "session-missing", message: cliSessionMessages["session-missing"] };
  }
  const row = await deps.db.cliSession.findUnique({ where: { tokenHash: hashCliToken(token) } });
  if (row === null) {
    return { ok: false, code: "session-missing", message: cliSessionMessages["session-missing"] };
  }
  if (row.revokedAt !== null) {
    return { ok: false, code: "session-revoked", message: cliSessionMessages["session-revoked"] };
  }
  const now = deps.clock.now();
  if (row.expiresAt.getTime() <= now) {
    return { ok: false, code: "session-expired", message: cliSessionMessages["session-expired"] };
  }
  if (row.lastUsedAt === null || now - row.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS) {
    await deps.db.cliSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastUsedAt: new Date(now) } });
  }
  return {
    ok: true,
    caller: { sessionId: cliSessionIdSchema.parse(row.id), userId: userIdSchema.parse(row.userId), memberId: memberIdSchema.parse(row.memberId), organizationId: organizationIdSchema.parse(row.organizationId) },
  };
};
