import type { Db } from "@ostra/db";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId } from "@ostra/protocol";
import type { SecretRef } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import { z } from "zod";

import { choiceLocked, notificationKinds } from "../notifications/choices.ts";
import type { NotificationKind } from "../notifications/choices.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import type { SaveEmailSettings, SaveNotificationPreferences } from "./m3-signatures.ts";

// F-036, F-115 (ticket 37; ADR 0050): a member's choices of which moments notify them where, and the
// install's email (which provider, from whom, with which secret). The signatures are
// `m3-signatures.ts`'s; these are their bodies.

/** The moments a member can choose for: every kind but the test mail. */
export const choosableNotificationKinds: readonly NotificationKind[] = notificationKinds.filter((kind) => kind !== "test");

// ---------- a member's choices ----------

/**
 * Saves a member's choices, each with its `updatedAt`. The panel's can't be turned off
 * (`panel-is-always-on`, and nothing is saved); a choice for the panel set on is a no-op, since the
 * panel is on whatever is stored. The latest choice for a moment and channel wins.
 */
export const saveNotificationPreferences: SaveNotificationPreferences = async (deps, scope, input) => {
  if (input.choices.some((choice) => choice.channel === "panel" && !choice.enabled)) {
    return { ok: false, error: "panel-is-always-on", message: "The panel's notifications can't be turned off" };
  }
  const latest = new Map<string, (typeof input.choices)[number]>();
  for (const choice of input.choices) {
    if (!choiceLocked(choice.channel) && choice.kind !== "test") {
      latest.set(`${choice.kind}:${choice.channel}`, choice);
    }
  }
  await deps.db.$transaction(async (tx) => {
    for (const choice of latest.values()) {
      await tx.notificationPreference.upsert({
        where: { memberId_kind_channel: { memberId: scope.memberId, kind: choice.kind, channel: choice.channel } },
        create: { organizationId: scope.organizationId, memberId: scope.memberId, kind: choice.kind, channel: choice.channel, enabled: choice.enabled },
        update: { enabled: choice.enabled },
      });
    }
  });
  return { ok: true, saved: latest.size };
};

// ---------- the install's email ----------

/** The limits of the email form (working values). */
export const emailLimits = { fromNameMax: 100, hostMax: 255, userMax: 255, secretMax: 4096 } as const;

const fromAddressSchema = z.email().max(320);
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(emailLimits.hostMax)
  .regex(/^[A-Za-z0-9._-]+$/, "a host name");

type EmailSaveError = "forbidden" | "locked-by-settings" | "invalid-input";
type EmailSaveResult = UseCaseResult<{ readonly provider: "off" | "resend" | "smtp" }, EmailSaveError>;

const refuse = (error: EmailSaveError, message: string): EmailSaveResult => ({ ok: false, error, message });

const refOf = (value: string | null): SecretRef | null => {
  if (value === null) {
    return null;
  }
  const parsed = secretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * Saves the install's email (F-115): instance admins only, refused while settings lock it. A new
 * key or password goes into the secret store and only its reference is kept; leaving it `null` keeps
 * the stored one. The audit entry names the provider, never a value. The secrets of the install's
 * email live in the saving admin's organization namespace (`secretsOrganizationId`): a later save by
 * an admin of another organization re-enters them.
 */
export const saveEmailSettings: SaveEmailSettings = async (deps, actor, input) => {
  if (!actor.instanceAdmin) {
    return refuse("forbidden", "Only an instance admin may change the install's email");
  }
  const store = deps.adapters.secretStore;
  const organizationId = actor.organizationId;

  // Checked before any secret is stored.
  if (input.provider !== "off") {
    if (!fromAddressSchema.safeParse(input.fromAddress).success) {
      return refuse("invalid-input", "The from address isn't an email address");
    }
    const name = input.fromName.trim();
    if (name === "" || name.length > emailLimits.fromNameMax) {
      return refuse("invalid-input", `The from name is 1 to ${String(emailLimits.fromNameMax)} characters`);
    }
  }
  if (input.provider === "smtp") {
    if (!hostSchema.safeParse(input.host).success) {
      return refuse("invalid-input", "The SMTP host isn't a host name");
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
      return refuse("invalid-input", "The SMTP port is a number from 1 to 65535");
    }
    if (input.user !== null && (input.user.trim() === "" || input.user.length > emailLimits.userMax)) {
      return refuse("invalid-input", "The SMTP user is empty or too long");
    }
  }
  const secretText = input.provider === "resend" ? input.apiKey : input.provider === "smtp" ? input.password : null;
  if (secretText !== null && (secretText === "" || secretText.length > emailLimits.secretMax)) {
    return refuse("invalid-input", "The key or password is empty or too long");
  }

  const row = await deps.db.emailSettings.upsert({ where: { id: "instance" }, create: { id: "instance" }, update: {} });
  if (row.lockedBySettings) {
    return refuse("locked-by-settings", "Settings lock the install's email: change OSTRA_EMAIL_PROVIDER to change it here");
  }
  const storedOrganization = row.secretsOrganizationId === null ? null : organizationIdSchema.parse(row.secretsOrganizationId);
  // Another organization's namespace holds the stored secrets: a save that sends mail re-enters them.
  const foreign = input.provider !== "off" && storedOrganization !== null && storedOrganization !== organizationId;
  const oldResend = refOf(row.resendApiKeySecretRef);
  const oldSmtp = refOf(row.smtpPasswordSecretRef);

  // What the new row keeps: a stored secret stays unless this save replaces it.
  let resendRef: SecretRef | null = foreign ? null : oldResend;
  let smtpRef: SecretRef | null = foreign ? null : oldSmtp;
  const created: SecretRef[] = [];
  const replaced: { readonly ref: SecretRef; readonly organizationId: OrganizationId }[] = [];
  const replace = (ref: SecretRef | null): void => {
    if (ref !== null && storedOrganization !== null) {
      replaced.push({ ref, organizationId: storedOrganization });
    }
  };
  if (foreign) {
    replace(oldResend);
    replace(oldSmtp);
  }
  const putSecret = async (purpose: string, value: string): Promise<SecretRef | null> => {
    const put = await store.put({ organizationId, purpose }, value);
    if (!put.ok) {
      return null;
    }
    created.push(put.value);
    return put.value;
  };

  if (input.provider === "resend") {
    if (input.apiKey !== null) {
      const ref = await putSecret("email-resend-api-key", input.apiKey);
      if (ref === null) {
        return refuse("invalid-input", "The secret store refused the key");
      }
      if (!foreign) {
        replace(oldResend);
      }
      resendRef = ref;
    } else if (resendRef === null) {
      return refuse("invalid-input", "Resend needs an API key");
    }
  }
  if (input.provider === "smtp") {
    if (input.user === null) {
      // No sign-in: a stored password goes with it.
      if (!foreign) {
        replace(oldSmtp);
      }
      smtpRef = null;
    } else if (input.password !== null) {
      const ref = await putSecret("email-smtp-password", input.password);
      if (ref === null) {
        return refuse("invalid-input", "The secret store refused the password");
      }
      if (!foreign) {
        replace(oldSmtp);
      }
      smtpRef = ref;
    } else if (smtpRef === null) {
      return refuse("invalid-input", "SMTP with a user needs a password");
    }
  }

  const common = {
    resendApiKeySecretRef: resendRef,
    smtpPasswordSecretRef: smtpRef,
    secretsOrganizationId: resendRef === null && smtpRef === null ? null : foreign || storedOrganization === null ? organizationId : storedOrganization,
  };
  try {
    await deps.db.$transaction(async (tx) => {
      switch (input.provider) {
        case "off":
          await tx.emailSettings.update({ where: { id: "instance" }, data: { provider: "off" } });
          break;
        case "resend":
          await tx.emailSettings.update({
            where: { id: "instance" },
            data: { provider: "resend", fromAddress: input.fromAddress, fromName: input.fromName.trim(), ...common },
          });
          break;
        case "smtp":
          await tx.emailSettings.update({
            where: { id: "instance" },
            data: {
              provider: "smtp",
              fromAddress: input.fromAddress,
              fromName: input.fromName.trim(),
              smtpHost: input.host,
              smtpPort: input.port,
              smtpSecure: input.secure,
              smtpUser: input.user,
              ...common,
            },
          });
          break;
        default:
          input satisfies never;
      }
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: { kind: "member", id: actor.memberId },
        action: "email.settings-saved",
        entity: "email-settings",
        entityId: null,
        // The provider's name and which secret changed: never a value.
        data: { provider: input.provider, secretChanged: created.length > 0 },
      });
    });
  } catch (error) {
    // The row didn't change: the secrets stored for it would be orphans.
    await Promise.all(created.map((ref) => store.delete(organizationId, ref)));
    throw error;
  }
  await Promise.all(replaced.map((old) => store.delete(old.organizationId, old.ref)));
  return { ok: true, provider: input.provider };
};

/** The outcome of "Send a test mail", in words and IDs: kept on the row and shown on the page. */
export type EmailTestOutcome = { readonly ok: true } | { readonly ok: false; readonly words: string };

/** The stored form of a test's outcome: `sent`, or `failed: <words>`. */
export const emailTestResultText = (outcome: EmailTestOutcome): string => (outcome.ok ? "sent" : `failed: ${outcome.words}`.slice(0, 500));

/** Reads a stored test result back. */
export const readEmailTestResult = (text: string | null): EmailTestOutcome | null => {
  if (text === null) {
    return null;
  }
  return text === "sent" ? { ok: true } : { ok: false, words: text.replace(/^failed:\s*/, "") };
};

/** Records a test mail's outcome and an audit entry (who, when, whether it went), in one transaction. */
export const recordEmailTest = async (
  deps: Pick<Ports, "audit" | "clock"> & { readonly db: Db },
  actor: { readonly organizationId: OrganizationId; readonly memberId: MemberId },
  outcome: EmailTestOutcome,
): Promise<void> => {
  await deps.db.$transaction(async (tx) => {
    await tx.emailSettings.upsert({
      where: { id: "instance" },
      create: { id: "instance", lastTestAt: new Date(deps.clock.now()), lastTestResult: emailTestResultText(outcome) },
      update: { lastTestAt: new Date(deps.clock.now()), lastTestResult: emailTestResultText(outcome) },
    });
    await deps.audit.recordInTx(tx, {
      organizationId: actor.organizationId,
      projectId: null,
      actor: { kind: "member", id: memberIdSchema.parse(actor.memberId) },
      action: "email.test-sent",
      entity: "email-settings",
      entityId: null,
      data: { ok: outcome.ok },
    });
  });
};
