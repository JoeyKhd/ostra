import { choosableNotificationKinds, defaultChoice, markNotificationRead, notificationChannels, notificationKinds, saveNotificationPreferences } from "@ostra/domain";
import { notificationIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { loadEmailRow, viewEmail } from "../services/email.ts";
import { memberProcedure, router, unwrap } from "../trpc/init.ts";
import { boardProjectIds } from "./home-board.ts";
import { loadNeedsYouViews } from "./needs-you-view.ts";

// F-036, F-115 (tickets 36 and 37; ADR 0050): a member's notifications. `preferences` is their own
// choices of which moments reach them where; the rest of the router is the "Needs you" page's list
// and the sidebar's count.

const kindSchema = z.enum(notificationKinds).exclude(["test"]);
const channelSchema = z.enum(notificationChannels);

const preferencesRouter = router({
  /**
   * The member's own choices for every moment and channel, with the default for those they never
   * changed, and what the page needs around them: whether mail is on for the install, the connected
   * tracker, the mail's delay, and when they last saved.
   */
  get: memberProcedure.query(async ({ ctx }) => {
    const { db, settings } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [saved, row, tracker, instance, account, lastSaved] = await Promise.all([
      db.notificationPreference.findMany({ where: { memberId: ctx.scope.memberId, organizationId } }),
      loadEmailRow(db),
      db.connection.findFirst({ where: { organizationId, kind: "linear", state: "active" }, select: { externalWorkspaceName: true } }),
      db.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } }),
      db.user.findUniqueOrThrow({ where: { id: ctx.user.userId }, select: { email: true } }),
      db.notificationPreference.aggregate({ where: { memberId: ctx.scope.memberId, organizationId }, _max: { updatedAt: true } }),
    ]);
    const email = viewEmail(settings.email, row);
    return {
      choices: choosableNotificationKinds.flatMap((kind) =>
        notificationChannels.map((channel) => {
          const choice = saved.find((candidate) => candidate.kind === kind && candidate.channel === channel);
          return {
            kind,
            channel,
            enabled: channel === "panel" ? true : (choice?.enabled ?? defaultChoice(kind, channel)),
            /** Whether the member changed it: the page shows the default marked as such otherwise. */
            saved: choice !== undefined,
            /** The panel is always on. */
            locked: channel === "panel",
            default: defaultChoice(kind, channel),
          };
        }),
      ),
      /** Whether the install sends mail. Off, the email column is shown disabled. */
      emailOn: email.provider !== "off" && email.ready,
      /** The member's own address, where mail would go. */
      emailAddress: account.email,
      /** The connected tracker, or `null`: the ticket column then has nothing to comment on. */
      tracker: tracker === null ? null : { kind: "linear" as const, name: "Linear", workspace: tracker.externalWorkspaceName },
      /** How long a needs-you mail waits, in seconds: the instance's saved delay, or the setting's. */
      emailDelaySeconds: instance?.emailDelaySeconds ?? settings.emailDelaySeconds,
      /** When the member last saved a choice, or `null` when they never have. */
      lastSavedAt: lastSaved._max.updatedAt?.getTime() ?? null,
      /** Whether the viewer can change the install's email (a link to its page). */
      isInstanceAdmin: ctx.user.instanceAdmin,
    };
  }),

  /** Saves the member's choices. The panel's can't be turned off; another member's are never touched. */
  save: memberProcedure
    .input(z.strictObject({ choices: z.array(z.strictObject({ kind: kindSchema, channel: channelSchema, enabled: z.boolean() })).max(choosableNotificationKinds.length * notificationChannels.length) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const saved = await saveNotificationPreferences({ db, ...ports }, ctx.scope, { choices: input.choices });
      const result = unwrap(saved, { "panel-is-always-on": "BAD_REQUEST" });
      return { saved: result.saved };
    }),
});

/** The Open tab shows at most this many (it is a list that empties); Done pages by cursor. */
const OPEN_TAB_MAX = 200;
const DONE_PAGE = 50;

const doneCursor = z.string().regex(/^\d+:.+$/);

export const notificationsRouter = router({
  preferences: preferencesRouter,

  /**
   * The member's own notifications for the Needs you page (ticket 36): `open` is every open one,
   * read or not; `done` is the answered and dismissed ones, newest first, paged by cursor. A
   * notification of a project the member can no longer open, and a test mail, never show. Each row
   * carries its item as Home shows it, what an inline answer needs, how a closed one ended, and the
   * member's own deliveries that failed.
   */
  list: memberProcedure
    .input(z.strictObject({ tab: z.enum(["open", "done"]), cursor: z.string().max(200).optional() }))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const { organizationId, memberId } = ctx.scope;
      const projectIds = (await boardProjectIds(db, ctx.scope, undefined)) ?? [];
      const base = { organizationId, memberId, kind: { not: "test" as const }, projectId: { in: [...projectIds] }, needsYouItemId: { not: null } };
      const where = input.tab === "open" ? { ...base, state: "open" as const } : { ...base, state: { in: ["answered" as const, "dismissed" as const] } };
      const after = input.tab === "done" && input.cursor !== undefined && doneCursor.safeParse(input.cursor).success ? input.cursor : null;
      const split = after === null ? -1 : after.indexOf(":");
      const afterAt = after === null ? null : new Date(Number(after.slice(0, split)));
      const afterId = after === null ? null : after.slice(split + 1);
      const take = input.tab === "open" ? OPEN_TAB_MAX : DONE_PAGE + 1;

      const [total, unread, rows] = await Promise.all([
        db.notification.count({ where: { ...base, state: "open" } }),
        db.notification.count({ where: { ...base, state: "open", readAt: null } }),
        db.notification.findMany({
          where: {
            ...where,
            ...(afterAt === null || afterId === null ? {} : { AND: [{ OR: [{ updatedAt: { lt: afterAt } }, { updatedAt: afterAt, id: { lt: afterId } }] }] }),
          },
          orderBy: [{ [input.tab === "open" ? "createdAt" : "updatedAt"]: "desc" }, { id: "desc" }],
          take,
          include: {
            needsYouItem: { include: { task: { select: { id: true, projectId: true, ticketKey: true, title: true, driverMemberId: true, agentProfileId: true, updatedAt: true, repos: { select: { prNumber: true } } } } } },
            deliveries: { where: { error: { not: null }, state: { in: ["pending", "failed"] } }, select: { channel: true, state: true, error: true, attempts: true } },
          },
        }),
      ]);
      const page = input.tab === "done" ? rows.slice(0, DONE_PAGE) : rows;
      const withItem = page.flatMap((row) => (row.needsYouItem === null ? [] : [{ row, item: row.needsYouItem }]));
      const views = await loadNeedsYouViews({ db }, ctx.scope, withItem.map((entry) => entry.item), Date.now());
      const last = page.at(-1);
      return {
        tab: input.tab,
        /** Every open notification, read or not: the Open tab's count. */
        total,
        /** How many of them are unread. */
        unread,
        rows: withItem.flatMap((entry, index) => {
          const view = views[index];
          return view === undefined
            ? []
            : [
                {
                  notificationId: notificationIdSchema.parse(entry.row.id),
                  kind: entry.row.kind,
                  read: entry.row.readAt !== null,
                  readAt: entry.row.readAt?.getTime() ?? null,
                  state: entry.row.state,
                  createdAt: entry.row.createdAt.getTime(),
                  view,
                  /** This member's deliveries that didn't go: the page says so under the row. */
                  failedDeliveries: entry.row.deliveries.map((delivery) => ({ channel: delivery.channel, state: delivery.state, error: delivery.error ?? "", attempts: delivery.attempts })),
                },
              ];
        }),
        nextCursor: input.tab === "done" && rows.length > DONE_PAGE && last !== undefined ? `${String(last.updatedAt.getTime())}:${last.id}` : null,
      };
    }),

  /** Marks the member's own notifications read (a mail still waiting for each is then skipped); other members' are never touched. */
  markRead: memberProcedure.input(z.strictObject({ ids: z.array(notificationIdSchema).min(1).max(OPEN_TAB_MAX) })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await markNotificationRead({ db, clock: ports.clock, notices: ports.notices }, ctx.scope, { notificationIds: input.ids });
    return { marked: result.marked };
  }),

  /** The sidebar's count: the member's open, unread notifications of projects they can open. */
  unreadCount: memberProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const projectIds = (await boardProjectIds(db, ctx.scope, undefined)) ?? [];
    const count = await db.notification.count({
      where: { organizationId: ctx.scope.organizationId, memberId: ctx.scope.memberId, state: "open", readAt: null, kind: { not: "test" }, projectId: { in: [...projectIds] }, needsYouItemId: { not: null } },
    });
    return { count };
  }),
});
