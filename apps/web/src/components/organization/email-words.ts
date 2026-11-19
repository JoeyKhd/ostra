import type { SaveEmailSettingsInput } from "@ostra/domain";

import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { shortDate } from "../account/notification-words";

// The email settings' pure parts (email-settings.md, F-115, ADR 0050): the form as a draft against
// the saved settings, its checks, what `.save` takes, and the panel's words.

export type EmailProvider = SaveEmailSettingsInput["provider"];
export type SmtpSecurity = "starttls" | "tls" | "none";

/** The saved settings as ticket 37's `email.settings.get` returns them: a secret is only set or not. */
export type SavedEmail = {
  readonly provider: EmailProvider;
  readonly fromAddress: string | null;
  readonly fromName: string | null;
  readonly resendKeySet: boolean;
  readonly smtp: { readonly host: string | null; readonly port: number | null; readonly secure: SmtpSecurity | null; readonly user: string | null; readonly passwordSet: boolean };
};

/** The form. A secret is `null` until the admin chooses to replace it: then the stored one stays. */
export type EmailDraft = {
  readonly provider: EmailProvider;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly apiKey: string | null;
  readonly host: string;
  readonly port: string;
  readonly secure: SmtpSecurity;
  readonly user: string;
  readonly password: string | null;
};

export const draftOf = (saved: SavedEmail): EmailDraft => ({
  provider: saved.provider,
  fromAddress: saved.fromAddress ?? "",
  fromName: saved.fromName ?? "",
  apiKey: saved.resendKeySet ? null : "",
  host: saved.smtp.host ?? "",
  port: String(saved.smtp.port ?? 587),
  secure: saved.smtp.secure ?? "starttls",
  user: saved.smtp.user ?? "",
  password: saved.smtp.passwordSet ? null : "",
});

/** Whether the form differs from what's saved: a typed secret always does. */
export const isEdited = (draft: EmailDraft, saved: SavedEmail): boolean => {
  const base = draftOf(saved);
  if (draft.provider !== base.provider) return true;
  if (draft.provider === "off") return false;
  const sender = draft.fromAddress !== base.fromAddress || draft.fromName !== base.fromName;
  if (draft.provider === "resend") return sender || (draft.apiKey !== null && draft.apiKey !== "");
  return sender || draft.host !== base.host || draft.port !== base.port || draft.secure !== base.secure || draft.user !== base.user || (draft.password !== null && draft.password !== "");
};

export type EmailField = "host" | "port" | "security" | "fromAddress" | "apiKey";
export type EmailProblems = Readonly<Partial<Record<EmailField, MessageKey>>>;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV6 = /^\[?[0-9a-f:]+\]?$/i;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A mail server on this machine: the only one `none` (no TLS) may reach (ticket 13). */
export const isLoopback = (host: string): boolean => {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
};

/** Each field's problem, in the order the page shows them; empty when the form can be saved. */
export const problemsOf = (draft: EmailDraft, saved: SavedEmail): EmailProblems => {
  const problems: Partial<Record<EmailField, MessageKey>> = {};
  if (draft.provider === "off") return problems;
  if (draft.provider === "resend") {
    if (draft.apiKey === null) {
      // The stored key stays.
    } else if (draft.apiKey.trim() === "") {
      if (!saved.resendKeySet) problems.apiKey = "email.invalid.apiKeyMissing";
    } else if (!draft.apiKey.trim().startsWith("re_")) {
      problems.apiKey = "email.invalid.apiKey";
    }
  }
  if (draft.provider === "smtp") {
    const host = draft.host.trim();
    if (host === "" || host.includes("://") || !(HOST.test(host) || IPV6.test(host))) problems.host = "email.invalid.host";
    const port = Number(draft.port);
    if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65_535) problems.port = "email.invalid.port";
    if (draft.secure === "none" && !isLoopback(host)) problems.security = "email.invalid.security";
  }
  if (!ADDRESS.test(draft.fromAddress.trim())) problems.fromAddress = "email.invalid.fromAddress";
  return problems;
};

const blankToNull = (text: string | null): string | null => {
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
};

/** What `email.settings.save` takes (ticket 21's `SaveEmailSettingsInput`): an untouched secret is `null`. */
export const saveInputOf = (draft: EmailDraft): SaveEmailSettingsInput => {
  switch (draft.provider) {
    case "off":
      return { provider: "off" };
    case "resend":
      return { provider: "resend", fromAddress: draft.fromAddress.trim(), fromName: draft.fromName.trim(), apiKey: blankToNull(draft.apiKey) };
    case "smtp":
      return {
        provider: "smtp",
        fromAddress: draft.fromAddress.trim(),
        fromName: draft.fromName.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        secure: draft.secure,
        user: blankToNull(draft.user),
        password: blankToNull(draft.password),
      };
    default:
      return draft.provider satisfies never;
  }
};

export const providerName = (provider: Exclude<EmailProvider, "off">): string => t(provider === "resend" ? "email.resend" : "email.smtp");

/** `today, 14:02`, or `12 Nov, 14:02` on another day. */
export const whenText = (at: number, now: number): string => {
  const day = new Date(at).toDateString() === new Date(now).toDateString() ? null : shortDate(at);
  return day === null ? t("email.today", { time: formatClock(at) }) : `${day}, ${formatClock(at)}`;
};

/** The last email audit entry, in words (`Switched to SMTP by Alex Kim, 19 Nov`). */
export type EmailChange = { readonly what: "smtp" | "resend" | "off" | "sender"; readonly by: string; readonly at: number };

export const lastChangeText = (change: EmailChange | null): string =>
  change === null ? t("email.neverChanged") : t(`email.change.${change.what}` satisfies MessageKey, { name: change.by, date: shortDate(change.at) });

/** The lock line's settings, each one that's set (`OSTRA_EMAIL_PROVIDER, OSTRA_EMAIL_FROM and OSTRA_SMTP_HOST`). */
export const settingsList = (names: readonly string[]): string => {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
};
