import { randomUUID } from "node:crypto";

import type { NotificationAdapter, SecretRef } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { renderNeedsYouEmail } from "@ostra/domain";
import type { EmailFromSettings, ServerAdapters } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId } from "@ostra/protocol";

// F-115 (ticket 37): the install's email as the panel sees it. Two sources: the settings
// (`OSTRA_EMAIL_PROVIDER` set), which lock the panel's choice, and the `email_settings` row an
// instance admin edits. This module resolves the one in effect, reads its secrets from the secret
// store, and sends the test mail through the adapter a build supplies. A secret is read here only
// to hand it to the adapter: it is never returned, never logged.

export type EmailProviderName = "off" | "resend" | "smtp";

/** What an email adapter is built from. Holds secrets: never logged. */
export type EmailConfig =
  | { readonly provider: "resend"; readonly fromAddress: string; readonly fromName: string; readonly apiKey: string }
  | {
      readonly provider: "smtp";
      readonly fromAddress: string;
      readonly fromName: string;
      readonly host: string;
      readonly port: number;
      readonly secure: "starttls" | "tls" | "none";
      readonly user: string | null;
      readonly password: string | null;
    };

/**
 * Builds the adapter that sends mail for a configuration, or `null` when this build has none for the
 * provider. `apps/web` supplies the real ones (Resend, SMTP); a test supplies a fake.
 */
export type EmailDirectory = { readonly adapterFor: (config: EmailConfig) => NotificationAdapter | null };

/** A directory with no adapters: a build that ships none. */
export const noEmailDirectory: EmailDirectory = { adapterFor: () => null };

/** The settings that lock the panel's choice when `OSTRA_EMAIL_PROVIDER` is set. */
export const lockingSettingNames = (email: EmailFromSettings): readonly string[] => {
  if (email.source === "panel") {
    return [];
  }
  switch (email.provider) {
    case "off":
      return ["OSTRA_EMAIL_PROVIDER"];
    case "resend":
      return ["OSTRA_EMAIL_PROVIDER", "OSTRA_EMAIL_FROM", "OSTRA_EMAIL_FROM_NAME", "OSTRA_RESEND_API_KEY"];
    case "smtp":
      return ["OSTRA_EMAIL_PROVIDER", "OSTRA_EMAIL_FROM", "OSTRA_EMAIL_FROM_NAME", "OSTRA_SMTP_HOST", "OSTRA_SMTP_PORT", "OSTRA_SMTP_SECURE", "OSTRA_SMTP_USER", "OSTRA_SMTP_PASSWORD"];
    default:
      return email satisfies never;
  }
};

/** The effective email without its secrets, as the page shows it. A secret is only "set" or "not set". */
export type EmailView = {
  readonly provider: EmailProviderName;
  readonly source: "panel" | "settings";
  readonly fromAddress: string | null;
  readonly fromName: string | null;
  readonly resend: { readonly apiKey: "set" | "not-set" };
  readonly smtp: {
    readonly host: string | null;
    readonly port: number | null;
    readonly secure: "starttls" | "tls" | "none" | null;
    readonly user: string | null;
    readonly password: "set" | "not-set";
  };
  /** Whether the provider has what it needs to send. */
  readonly ready: boolean;
};

type EmailRow = {
  readonly provider: EmailProviderName;
  readonly fromAddress: string | null;
  readonly fromName: string | null;
  readonly resendApiKeySecretRef: string | null;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly smtpSecure: "starttls" | "tls" | "none" | null;
  readonly smtpUser: string | null;
  readonly smtpPasswordSecretRef: string | null;
  readonly secretsOrganizationId: string | null;
};

const emptyRow: EmailRow = {
  provider: "off",
  fromAddress: null,
  fromName: null,
  resendApiKeySecretRef: null,
  smtpHost: null,
  smtpPort: null,
  smtpSecure: null,
  smtpUser: null,
  smtpPasswordSecretRef: null,
  secretsOrganizationId: null,
};

export const loadEmailRow = async (db: Db): Promise<EmailRow & { readonly lockedBySettings: boolean; readonly lastTestAt: Date | null; readonly lastTestResult: string | null }> => {
  const row = await db.emailSettings.findUnique({ where: { id: "instance" } });
  return row ?? { ...emptyRow, lockedBySettings: false, lastTestAt: null, lastTestResult: null };
};

const setOrNot = (value: string | null): "set" | "not-set" => (value === null || value === "" ? "not-set" : "set");

/** The email in effect: the settings' when they set it, the saved row's otherwise. */
export const viewEmail = (settings: EmailFromSettings, row: EmailRow): EmailView => {
  if (settings.source === "settings") {
    switch (settings.provider) {
      case "off":
        return { provider: "off", source: "settings", fromAddress: null, fromName: null, resend: { apiKey: "not-set" }, smtp: { host: null, port: null, secure: null, user: null, password: "not-set" }, ready: false };
      case "resend":
        return {
          provider: "resend",
          source: "settings",
          fromAddress: settings.from,
          fromName: settings.fromName,
          resend: { apiKey: setOrNot(settings.apiKey) },
          smtp: { host: null, port: null, secure: null, user: null, password: "not-set" },
          ready: settings.apiKey !== "",
        };
      case "smtp":
        return {
          provider: "smtp",
          source: "settings",
          fromAddress: settings.from,
          fromName: settings.fromName,
          resend: { apiKey: "not-set" },
          smtp: { host: settings.host, port: settings.port, secure: settings.secure, user: settings.user, password: setOrNot(settings.password) },
          ready: settings.host !== "",
        };
      default:
        return settings satisfies never;
    }
  }
  const ready =
    row.provider === "resend"
      ? row.fromAddress !== null && row.resendApiKeySecretRef !== null
      : row.provider === "smtp"
        ? row.fromAddress !== null && row.smtpHost !== null && row.smtpPort !== null && row.smtpSecure !== null
        : false;
  return {
    provider: row.provider,
    source: "panel",
    fromAddress: row.fromAddress,
    fromName: row.fromName ?? settings.fromName,
    resend: { apiKey: setOrNot(row.resendApiKeySecretRef) },
    smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, user: row.smtpUser, password: setOrNot(row.smtpPasswordSecretRef) },
    ready,
  };
};

export type LoadedEmailConfig = { readonly ok: true; readonly config: EmailConfig } | { readonly ok: false; readonly words: string };

const refOf = (value: string | null): SecretRef | null => {
  if (value === null) {
    return null;
  }
  const parsed = secretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The configuration to send with, secrets read from the store; or why there is none, in words. */
export const loadEmailConfig = async (settings: EmailFromSettings, row: EmailRow, secretStore: ServerAdapters["secretStore"]): Promise<LoadedEmailConfig> => {
  if (settings.source === "settings") {
    switch (settings.provider) {
      case "off":
        return { ok: false, words: "Mail is off on this install" };
      case "resend":
        return { ok: true, config: { provider: "resend", fromAddress: settings.from, fromName: settings.fromName, apiKey: settings.apiKey } };
      case "smtp":
        return {
          ok: true,
          config: { provider: "smtp", fromAddress: settings.from, fromName: settings.fromName, host: settings.host, port: settings.port, secure: settings.secure, user: settings.user, password: settings.password },
        };
      default:
        return settings satisfies never;
    }
  }
  const namespace: OrganizationId | null = row.secretsOrganizationId === null ? null : organizationIdSchema.parse(row.secretsOrganizationId);
  const read = async (ref: SecretRef | null): Promise<string | null> => {
    if (ref === null || namespace === null) {
      return null;
    }
    const value = await secretStore.get(namespace, ref);
    return value.ok ? value.value : null;
  };
  switch (row.provider) {
    case "off":
      return { ok: false, words: "Mail is off on this install" };
    case "resend": {
      const apiKey = await read(refOf(row.resendApiKeySecretRef));
      if (row.fromAddress === null || apiKey === null) {
        return { ok: false, words: "Resend isn't set up yet: it needs a from address and an API key" };
      }
      return { ok: true, config: { provider: "resend", fromAddress: row.fromAddress, fromName: row.fromName ?? "ostra", apiKey } };
    }
    case "smtp": {
      if (row.fromAddress === null || row.smtpHost === null || row.smtpPort === null || row.smtpSecure === null) {
        return { ok: false, words: "SMTP isn't set up yet: it needs a from address, a host, a port and a security" };
      }
      const hasPassword = row.smtpPasswordSecretRef !== null;
      const password = await read(refOf(row.smtpPasswordSecretRef));
      if (hasPassword && password === null) {
        return { ok: false, words: "The SMTP password can't be read from the secret store" };
      }
      return {
        ok: true,
        config: {
          provider: "smtp",
          fromAddress: row.fromAddress,
          fromName: row.fromName ?? "ostra",
          host: row.smtpHost,
          port: row.smtpPort,
          secure: row.smtpSecure,
          user: row.smtpUser,
          password,
        },
      };
    }
    default:
      return row.provider satisfies never;
  }
};

export type TestMailResult = { readonly ok: true; readonly words: string } | { readonly ok: false; readonly words: string };

/**
 * Sends the test mail to one address through the adapter for the configuration in effect, and says
 * what happened in words. Never throws for a provider's refusal; the words hold no secret and no
 * vendor body.
 */
export const sendTestMail = async (input: {
  readonly directory: EmailDirectory;
  readonly config: EmailConfig;
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly memberId: MemberId;
  readonly address: string;
  readonly publicUrl: string;
}): Promise<TestMailResult> => {
  const adapter = input.directory.adapterFor(input.config);
  if (adapter === null) {
    return { ok: false, words: `This build has no ${input.config.provider === "resend" ? "Resend" : "SMTP"} adapter` };
  }
  const rendered = renderNeedsYouEmail({
    detail: { kind: "test" },
    organizationName: input.organizationName,
    projectName: null,
    task: null,
    reason: "driver",
    publicUrl: input.publicUrl,
  });
  const sent = await adapter.send({
    organizationId: input.organizationId,
    memberIds: [input.memberId],
    title: rendered.subject,
    body: rendered.text,
    url: input.publicUrl,
    idempotencyKey: `email-test:${randomUUID()}`,
    kind: "test",
    recipients: [{ memberId: input.memberId, email: input.address, trackerMention: null }],
    subject: "Test mail",
    rendered,
  });
  if (!sent.ok) {
    return { ok: false, words: sent.error.message };
  }
  const refused = sent.value.refused[0];
  if (refused !== undefined) {
    return { ok: false, words: `The server refused the address: ${refused.reason}` };
  }
  return { ok: true, words: "Sent. Check the inbox." };
};

/**
 * Whether the install's email is set up and ready (F-002, ADR 0053): invitations then verify the
 * address, and "Forgot your password?" mails a reset link. Read at each use, so saving the email page
 * takes effect at once.
 */
export const accountMailIsOn = async (db: Db, settings: EmailFromSettings): Promise<boolean> => viewEmail(settings, await loadEmailRow(db)).ready;
