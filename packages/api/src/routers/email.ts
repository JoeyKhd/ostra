import { readEmailTestResult, recordEmailTest, saveEmailSettings } from "@ostra/domain";
import type { SaveEmailSettingsInput, ServerSettings } from "@ostra/domain";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadEmailConfig, loadEmailRow, lockingSettingNames, sendTestMail, viewEmail } from "../services/email.ts";
import { instanceAdminProcedure, memberProcedure, publicProcedure, router, unwrap } from "../trpc/init.ts";

// F-115 (ticket 37; ADR 0050): the install's email. `status` is for every member (the panel says
// "Mail is off on this install" from it); the rest is the instance admin's. A key or a password is
// written to the secret store and shown back only as "set" or "not set". Settings that lock the
// email (`OSTRA_EMAIL_PROVIDER`) refuse a save, and the page shows the names that lock it.

const fromFields = {
  fromAddress: z.string().trim().min(1).max(320),
  fromName: z.string().trim().min(1).max(100),
} as const;

const saveInput = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("off") }),
  z.strictObject({ provider: z.literal("resend"), ...fromFields, apiKey: z.string().min(1).max(4096).nullable() }),
  z.strictObject({
    provider: z.literal("smtp"),
    ...fromFields,
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    secure: z.enum(["starttls", "tls", "none"]),
    user: z.string().trim().min(1).max(255).nullable(),
    password: z.string().min(1).max(4096).nullable(),
  }),
]);

export const emailRouter = router({
  /**
   * Whether the install sends account mail, for the pages before sign-in (F-002, ticket 32): the
   * sign-in page's "Forgot your password?", `/reset` and `/reset/new`. One boolean, nothing of the
   * settings behind it.
   */
  on: publicProcedure.output(z.object({ on: z.boolean() })).query(async ({ ctx }) => ({ on: await ctx.deps.emailOn() })),

  /** Whether the install sends mail: the panel's "Mail is off on this install" comes from it. For any member. */
  status: memberProcedure.query(async ({ ctx }) => {
    const row = await loadEmailRow(ctx.deps.db);
    const view = viewEmail(ctx.deps.settings.email, row);
    return { on: view.provider !== "off" && view.ready, provider: view.provider };
  }),

  settings: router({
    /** The install's email in effect, with every secret as "set" or "not set" (instance admin). */
    get: instanceAdminProcedure.query(async ({ ctx }) => {
      const { db, settings } = ctx.deps;
      const row = await loadEmailRow(db);
      const view = viewEmail(settings.email, row);
      const locking = lockingSettingNames(settings.email);
      const [instance, lastAudit, account] = await Promise.all([
        db.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } }),
        db.auditEntry.findFirst({
          where: { organizationId: ctx.scope.organizationId, action: { startsWith: "email." } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        db.user.findUniqueOrThrow({ where: { id: ctx.user.userId }, select: { email: true } }),
      ]);
      const actorId = lastAudit?.actorId ?? null;
      const actor = actorId === null ? null : await db.member.findFirst({ where: { id: actorId, organizationId: ctx.scope.organizationId }, select: { user: { select: { name: true } } } });
      const test = readEmailTestResult(row.lastTestResult);
      return {
        ...view,
        /** Settings chose the provider: the page shows these names and refuses a save. */
        lockedBySettings: locking.length > 0 || row.lockedBySettings,
        lockedBy: locking,
        /** The delay in effect, in seconds: the instance's saved one, or `OSTRA_EMAIL_DELAY_SECONDS`. */
        delaySeconds: instance?.emailDelaySeconds ?? settings.emailDelaySeconds,
        /** The non-secret settings that are set, by name: what the page shows beside the locked form. */
        settingValues: settingValuesOf(settings.email),
        lastTest: row.lastTestAt === null ? null : { at: row.lastTestAt.getTime(), ok: test?.ok ?? false, words: test === null ? "" : test.ok ? "Sent." : test.words },
        lastAudit: lastAudit === null ? null : { action: lastAudit.action, at: lastAudit.createdAt.getTime(), actorName: actor?.user.name ?? null },
        /** The test mail goes here: the admin's own address. */
        adminAddress: account.email,
      };
    }),

    /** Saves the email (instance admin; refused while settings lock it). Secrets go to the secret store. */
    save: instanceAdminProcedure.input(saveInput).mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      if (settings.email.source === "settings") {
        throw lockedError();
      }
      const saved = await saveEmailSettings(
        { db, ...ports },
        { userId: ctx.user.userId, memberId: ctx.scope.memberId, organizationId: ctx.scope.organizationId, instanceAdmin: ctx.user.instanceAdmin },
        input satisfies SaveEmailSettingsInput,
      );
      const result = unwrap(saved, { forbidden: "FORBIDDEN", "locked-by-settings": "PRECONDITION_FAILED", "invalid-input": "BAD_REQUEST" });
      return { provider: result.provider };
    }),
  }),

  /** Sends the test mail to the admin's own address, and says what happened in words (instance admin). */
  sendTest: instanceAdminProcedure.mutation(async ({ ctx }) => {
    const { db, ports, settings, email } = ctx.deps;
    const row = await loadEmailRow(db);
    const [account, organization] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: ctx.user.userId }, select: { email: true } }),
      db.organization.findUniqueOrThrow({ where: { id: ctx.scope.organizationId }, select: { name: true } }),
    ]);
    const loaded = await loadEmailConfig(settings.email, row, ports.adapters.secretStore);
    const outcome = loaded.ok
      ? await sendTestMail({
          directory: email,
          config: loaded.config,
          organizationId: ctx.scope.organizationId,
          organizationName: organization.name,
          memberId: ctx.scope.memberId,
          address: account.email,
          publicUrl: settings.publicUrl,
        })
      : ({ ok: false, words: loaded.words } as const);
    await recordEmailTest({ db, ...ports }, { organizationId: ctx.scope.organizationId, memberId: ctx.scope.memberId }, outcome.ok ? { ok: true } : { ok: false, words: outcome.words });
    ctx.deps.logger.info("email.test_sent", { organizationId: ctx.scope.organizationId, ok: outcome.ok });
    return { ok: outcome.ok, words: outcome.words, sentTo: account.email };
  }),
});

const lockedError = (): TRPCError =>
  new TRPCError({ code: "PRECONDITION_FAILED", message: "Settings lock the install's email: change OSTRA_EMAIL_PROVIDER to change it here" });

/** The non-secret settings that are set, by their names. */
const settingValuesOf = (email: ServerSettings["email"]): Readonly<Record<string, string>> => {
  if (email.source === "panel") {
    return {};
  }
  switch (email.provider) {
    case "off":
      return { OSTRA_EMAIL_PROVIDER: "off" };
    case "resend":
      return { OSTRA_EMAIL_PROVIDER: "resend", OSTRA_EMAIL_FROM: email.from, OSTRA_EMAIL_FROM_NAME: email.fromName };
    case "smtp":
      return {
        OSTRA_EMAIL_PROVIDER: "smtp",
        OSTRA_EMAIL_FROM: email.from,
        OSTRA_EMAIL_FROM_NAME: email.fromName,
        OSTRA_SMTP_HOST: email.host,
        OSTRA_SMTP_PORT: String(email.port),
        OSTRA_SMTP_SECURE: email.secure,
        ...(email.user === null ? {} : { OSTRA_SMTP_USER: email.user }),
      };
    default:
      return email satisfies never;
  }
};
