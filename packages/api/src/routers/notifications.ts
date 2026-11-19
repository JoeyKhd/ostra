import { choosableNotificationKinds, defaultChoice, notificationChannels, notificationKinds, saveNotificationPreferences } from "@ostra/domain";
import { z } from "zod";

import { loadEmailRow, viewEmail } from "../services/email.ts";
import { memberProcedure, router, unwrap } from "../trpc/init.ts";

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

export const notificationsRouter = router({
  preferences: preferencesRouter,
});
