import { revokeCliSession, unlinkGitHubUser } from "@ostra/domain";
import { cliSessionIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { githubLinkAvailable } from "../services/github-link.ts";
import { memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-103, F-119 (ticket 39): the signed-in member's own account page. Everything here is about the
// caller and nobody else: another member's CLI sessions and GitHub link are not reachable by ID or
// otherwise. A token, a hash and a GitHub token are in no output.

const cliSessionsRouter = router({
  /**
   * The member's CLI sessions that still work, newest first: the machine's name, when it was made,
   * when it last read, when it ends. `days` is `OSTRA_CLI_SESSION_DAYS`, and `serverUrl` the panel's
   * address, for the `ostra login --server` line.
   */
  list: memberProcedure.query(async ({ ctx }) => {
    const { db, ports, settings } = ctx.deps;
    const rows = await db.cliSession.findMany({
      where: { userId: ctx.user.userId, revokedAt: null, expiresAt: { gt: new Date(ports.clock.now()) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return {
      sessions: rows.map((row) => ({
        id: cliSessionIdSchema.parse(row.id),
        name: row.name,
        createdAt: row.createdAt.getTime(),
        lastUsedAt: row.lastUsedAt?.getTime() ?? null,
        expiresAt: row.expiresAt.getTime(),
      })),
      days: settings.cliSessionDays,
      serverUrl: settings.publicUrl,
    };
  }),

  /** Revokes one of the member's own sessions, at once: its next request is refused with 401. */
  revoke: memberProcedure.input(z.strictObject({ sessionId: cliSessionIdSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await revokeCliSession({ db, ...ports }, { userId: ctx.user.userId }, { sessionId: input.sessionId });
    const revoked = unwrap(result, { "not-found": "NOT_FOUND", "not-yours": "FORBIDDEN" });
    return { sessionId: revoked.sessionId };
  }),
});

const githubRouter = router({
  /**
   * The member's verified GitHub link, and whether linking is possible at all: `connected` is false
   * when the install has no GitHub App with an OAuth client, and the page then says so.
   */
  get: memberProcedure.query(async ({ ctx }) => {
    const user = await ctx.deps.db.user.findUniqueOrThrow({ where: { id: ctx.user.userId }, select: { githubUserId: true, githubLogin: true, githubLinkedAt: true } });
    return {
      connected: await githubLinkAvailable(ctx, ctx.scope.organizationId),
      link:
        user.githubUserId === null || user.githubLogin === null
          ? null
          : { login: user.githubLogin, githubUserId: user.githubUserId, linkedAt: user.githubLinkedAt?.getTime() ?? 0 },
    };
  }),

  /** Unlinks the member's GitHub account: later commits credit their ostra name and email again. */
  unlink: memberProcedure.mutation(async ({ ctx }) => {
    const { db, ports } = ctx.deps;
    const result = await unlinkGitHubUser({ db, ...ports }, { userId: ctx.user.userId });
    unwrap(result, { "not-linked": "CONFLICT" });
    return { unlinked: true as const };
  }),
});

export const accountRouter = router({
  cliSessions: cliSessionsRouter,
  github: githubRouter,

  /**
   * What the device page names about a code the caller opened: a runner's or the CLI's, and the
   * machine's name the CLI sent. Only for the member whose page claimed the code (the plugin's
   * verify step does); any other code is not found.
   */
  deviceRequest: memberProcedure.input(z.strictObject({ userCode: z.string().min(4).max(64) })).query(async ({ ctx, input }) => {
    const code = input.userCode.replaceAll(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const row = await ctx.deps.db.deviceCode.findFirst({ where: { userCode: code, userId: ctx.user.userId }, select: { purpose: true, machineName: true } });
    if (row === null) {
      return { purpose: null, machineName: null };
    }
    return { purpose: row.purpose, machineName: row.machineName };
  }),
});
