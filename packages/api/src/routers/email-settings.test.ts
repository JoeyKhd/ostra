import { saveEmailSettings } from "@ostra/domain";
import type { EmailFromSettings } from "@ostra/domain";
import { userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeMailAdapter } from "../testing/fake-adapters.ts";
import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { noEmailDirectory } from "../services/email.ts";
import type { EmailConfig } from "../services/email.ts";

// F-115, ticket 37: the install's email. Only an instance admin reads or changes it; a key or a
// password goes to the secret store and comes back only as "set"; settings that lock it refuse a
// save; the test mail goes to the admin's own address and its result is kept.

let harness: ApiHarness;
const mail = new FakeMailAdapter();
const configs: EmailConfig[] = [];

const RESEND_KEY = "re_live_0123456789abcdefghijklmnop";
const SMTP_PASSWORD = "smtp-password-0123456789";

beforeAll(async () => {
  harness = await createApiHarness({
    email: {
      adapterFor: (config) => {
        configs.push(config);
        return mail;
      },
    },
  });
  // The first admin is the instance admin (Q102): organization A's admin here.
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
});

afterAll(async () => {
  await harness.dispose();
});

const instanceAdmin = () => harness.as(harness.fixture.a.admin);

/** A caller whose requests see other settings (for the locked cases). */
const withSettings = async (email: EmailFromSettings) => {
  const context = await harness.contextOf(harness.fixture.a.admin);
  return harness.callerFor({ ...context, deps: { ...context.deps, settings: { ...context.deps.settings, email } } });
};

/** The error a procedure rejects with, to read its code and words. */
const rejection = async (call: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof TRPCError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("the call did not reject");
};

const everything = (value: unknown): string => JSON.stringify(value);

const secretValues = (): string[] => [...harness.fakes.secretStore.entries.values()].map((entry) => entry.value);

describe("email.settings", () => {
  it("F-115: only an instance admin reads or changes the install's email", async () => {
    const { a, b } = harness.fixture;
    // An organization admin who is not the instance admin, and plain members.
    for (const who of [b.admin, a.member, a.insider]) {
      const caller = await harness.as(who);
      await expect(caller.email.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.email.settings.save({ provider: "off" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.email.sendTest()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(harness.anonymous().email.settings.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await harness.test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } })).toMatchObject({ provider: "off" });
  });

  it("F-115: the use case refuses a caller who is not the instance admin, whatever called it", async () => {
    const { a } = harness.fixture;
    const refused = await saveEmailSettings(
      { db: harness.test.db, ...harness.deps.ports },
      { userId: userIdSchema.parse(a.member.userId), memberId: a.member.id, organizationId: a.organization.id, instanceAdmin: false },
      { provider: "off" },
    );
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("F-115: starts off, and says so to every member", async () => {
    const admin = await instanceAdmin();
    const initial = await admin.email.settings.get();
    expect(initial).toMatchObject({ provider: "off", source: "panel", lockedBySettings: false, lockedBy: [], ready: false, delaySeconds: 120, lastTest: null, lastAudit: null });
    expect(initial.adminAddress).toContain("admin-a");
    for (const who of [harness.fixture.a.member, harness.fixture.b.admin]) {
      expect(await (await harness.as(who)).email.status()).toEqual({ on: false, provider: "off" });
    }
  });

  it("F-115: saves Resend with its key in the secret store, and the key never comes back", async () => {
    const admin = await instanceAdmin();
    const saved = await admin.email.settings.save({ provider: "resend", fromAddress: "ostra@example.com", fromName: "ostra", apiKey: RESEND_KEY });
    expect(saved).toEqual({ provider: "resend" });

    const row = await harness.test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } });
    expect(row.resendApiKeySecretRef).toMatch(/^fake:/);
    expect(everything(row)).not.toContain(RESEND_KEY);
    expect(row.secretsOrganizationId).toBe(harness.fixture.a.organization.id);
    const stored = [...harness.fakes.secretStore.entries.values()].filter((entry) => entry.purpose === "email-resend-api-key");
    expect(stored.map((entry) => entry.value)).toEqual([RESEND_KEY]);

    const view = await admin.email.settings.get();
    expect(view).toMatchObject({ provider: "resend", fromAddress: "ostra@example.com", fromName: "ostra", resend: { apiKey: "set" }, ready: true });
    expect(everything(view)).not.toContain(RESEND_KEY);
    expect(await (await harness.as(harness.fixture.a.member)).email.status()).toEqual({ on: true, provider: "resend" });

    // The audit entry names the provider and says a secret changed, never the value.
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "email.settings-saved" } });
    expect(audit.data).toEqual({ provider: "resend", secretChanged: true });
    expect(everything(audit)).not.toContain(RESEND_KEY);
    expect(view.lastAudit).toMatchObject({ action: "email.settings-saved", actorName: "admin-a" });
    expect(everything(harness.logs)).not.toContain(RESEND_KEY);
  });

  it("F-115: saving without a new key keeps the stored one; a new key replaces it and deletes the old secret", async () => {
    const admin = await instanceAdmin();
    const before = await harness.test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } });
    await admin.email.settings.save({ provider: "resend", fromAddress: "mail@example.com", fromName: "ostra mail", apiKey: null });
    const kept = await harness.test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } });
    expect(kept).toMatchObject({ resendApiKeySecretRef: before.resendApiKeySecretRef, fromAddress: "mail@example.com", fromName: "ostra mail" });

    const replacement = "re_live_replacement_key_9876543210";
    await admin.email.settings.save({ provider: "resend", fromAddress: "mail@example.com", fromName: "ostra mail", apiKey: replacement });
    const replaced = await harness.test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } });
    expect(replaced.resendApiKeySecretRef).not.toBe(before.resendApiKeySecretRef);
    expect(secretValues()).toContain(replacement);
    expect(secretValues()).not.toContain(RESEND_KEY);
  });

  it("F-115: SMTP keeps its password as a secret too, and a user-less server stores none", async () => {
    const admin = await instanceAdmin();
    await admin.email.settings.save({ provider: "smtp", fromAddress: "ostra@example.com", fromName: "ostra", host: "smtp.example.com", port: 587, secure: "starttls", user: "mailer", password: SMTP_PASSWORD });
    const view = await admin.email.settings.get();
    expect(view).toMatchObject({ provider: "smtp", smtp: { host: "smtp.example.com", port: 587, secure: "starttls", user: "mailer", password: "set" }, ready: true });
    expect(everything(view)).not.toContain(SMTP_PASSWORD);
    expect(secretValues()).toContain(SMTP_PASSWORD);

    await admin.email.settings.save({ provider: "smtp", fromAddress: "ostra@example.com", fromName: "ostra", host: "relay.local", port: 25, secure: "none", user: null, password: null });
    const open = await admin.email.settings.get();
    expect(open).toMatchObject({ smtp: { host: "relay.local", port: 25, secure: "none", user: null, password: "not-set" } });
    expect(secretValues()).not.toContain(SMTP_PASSWORD);
  });

  it("F-115: refuses what the provider can't send with, and says why", async () => {
    const admin = await instanceAdmin();
    await admin.email.settings.save({ provider: "off" });
    expect(await rejection(admin.email.settings.save({ provider: "smtp", fromAddress: "ostra@example.com", fromName: "ostra", host: "relay.local", port: 25, secure: "none", user: "mailer", password: null }))).toMatchObject({ code: "BAD_REQUEST", message: "SMTP with a user needs a password" });
    await expect(admin.email.settings.save({ provider: "resend", fromAddress: "not an address", fromName: "ostra", apiKey: RESEND_KEY })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // With no key ever stored, Resend asks for one.
    await harness.test.db.emailSettings.update({ where: { id: "instance" }, data: { resendApiKeySecretRef: null, secretsOrganizationId: null } });
    expect(await rejection(admin.email.settings.save({ provider: "resend", fromAddress: "ostra@example.com", fromName: "ostra", apiKey: null }))).toMatchObject({ code: "BAD_REQUEST", message: "Resend needs an API key" });
    expect(await admin.email.settings.save({ provider: "off" })).toEqual({ provider: "off" });
    expect(await (await harness.as(harness.fixture.a.member)).email.status()).toEqual({ on: false, provider: "off" });
  });

  it("F-115: settings that choose the provider lock the page: a save is refused and the names that lock it come back", async () => {
    const locked = await withSettings({
      source: "settings",
      provider: "smtp",
      from: "ostra@corp.example",
      fromName: "Corp ostra",
      host: "smtp.corp.example",
      port: 465,
      secure: "tls",
      user: "svc",
      password: "locked-secret-value",
    });
    const view = await locked.email.settings.get();
    expect(view).toMatchObject({ provider: "smtp", source: "settings", lockedBySettings: true, ready: true, smtp: { host: "smtp.corp.example", port: 465, secure: "tls", user: "svc", password: "set" } });
    expect(view.lockedBy).toEqual(expect.arrayContaining(["OSTRA_EMAIL_PROVIDER", "OSTRA_SMTP_HOST", "OSTRA_SMTP_PASSWORD"]));
    expect(view.settingValues).toMatchObject({ OSTRA_EMAIL_PROVIDER: "smtp", OSTRA_SMTP_HOST: "smtp.corp.example", OSTRA_SMTP_PORT: "465" });
    expect(everything(view)).not.toContain("locked-secret-value");
    const refusal = await rejection(locked.email.settings.save({ provider: "off" }));
    expect(refusal.code).toBe("PRECONDITION_FAILED");
    expect(refusal.message).toContain("OSTRA_EMAIL_PROVIDER");

    // A row that core marked locked refuses a save in the use case too, whatever the router saw.
    await harness.test.db.emailSettings.update({ where: { id: "instance" }, data: { lockedBySettings: true } });
    const admin = await instanceAdmin();
    await expect(admin.email.settings.save({ provider: "off" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await harness.test.db.emailSettings.update({ where: { id: "instance" }, data: { lockedBySettings: false } });
  });

  it("F-115: the delay in effect is the instance's saved one, else the setting's", async () => {
    const admin = await instanceAdmin();
    expect((await admin.email.settings.get()).delaySeconds).toBe(120);
    await harness.test.db.instanceSetting.upsert({ where: { id: "instance" }, create: { id: "instance", emailDelaySeconds: 45 }, update: { emailDelaySeconds: 45 } });
    expect((await admin.email.settings.get()).delaySeconds).toBe(45);
    await harness.test.db.instanceSetting.update({ where: { id: "instance" }, data: { emailDelaySeconds: null } });
  });
});

describe("email.sendTest", () => {
  it("F-115: says mail is off when it is, and keeps the result", async () => {
    const admin = await instanceAdmin();
    await admin.email.settings.save({ provider: "off" });
    const result = await admin.email.sendTest();
    expect(result).toMatchObject({ ok: false, words: "Mail is off on this install" });
    expect((await admin.email.settings.get()).lastTest).toMatchObject({ ok: false, words: "Mail is off on this install" });
    expect(mail.sent).toHaveLength(0);
  });

  it("F-115: sends the test mail to the admin's own address through the provider's adapter, with the key it was saved with", async () => {
    const admin = await instanceAdmin();
    await admin.email.settings.save({ provider: "resend", fromAddress: "ostra@example.com", fromName: "ostra", apiKey: RESEND_KEY });
    const before = mail.sent.length;
    const result = await admin.email.sendTest();
    expect(result).toMatchObject({ ok: true, words: "Sent. Check the inbox." });
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } });
    expect(result.sentTo).toBe(account.email);

    expect(mail.sent).toHaveLength(before + 1);
    const sent = mail.sent.at(-1);
    expect(sent).toMatchObject({ kind: "test", recipients: [{ memberId: harness.fixture.a.admin.id, email: account.email }] });
    expect(sent?.rendered?.subject).toBeTruthy();
    expect(sent?.rendered?.html).toContain("localhost:3000");
    expect(sent?.rendered?.text).toContain("localhost:3000");
    // The adapter was built from the saved configuration, with the key read from the secret store.
    expect(configs.at(-1)).toEqual({ provider: "resend", fromAddress: "ostra@example.com", fromName: "ostra", apiKey: RESEND_KEY });

    const view = await admin.email.settings.get();
    expect(view.lastTest).toMatchObject({ ok: true });
    expect(everything(view)).not.toContain(RESEND_KEY);
    expect(await harness.test.db.auditEntry.count({ where: { action: "email.test-sent" } })).toBeGreaterThan(0);
    expect(everything(harness.logs)).not.toContain(RESEND_KEY);
  });

  it("F-115: reports a provider's refusal in words, without its key", async () => {
    const admin = await instanceAdmin();
    mail.failWith = { code: "unauthorized", message: "The provider refused the credential" };
    const refused = await admin.email.sendTest();
    expect(refused).toMatchObject({ ok: false, words: "The provider refused the credential" });
    expect((await admin.email.settings.get()).lastTest).toMatchObject({ ok: false, words: "The provider refused the credential" });
    expect(everything(refused)).not.toContain(RESEND_KEY);

    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } });
    mail.refuse.add(account.email);
    const bounced = await admin.email.sendTest();
    expect(bounced.ok).toBe(false);
    expect(bounced.words).toContain("refused the address");
    mail.refuse.clear();
  });

  it("F-115: a build with no adapter for the provider says so", async () => {
    const admin = await instanceAdmin();
    await admin.email.settings.save({ provider: "smtp", fromAddress: "ostra@example.com", fromName: "ostra", host: "relay.local", port: 25, secure: "none", user: null, password: null });
    const context = await harness.contextOf(harness.fixture.a.admin);
    const bare = harness.callerFor({ ...context, deps: { ...context.deps, email: noEmailDirectory } });
    expect(await bare.email.sendTest()).toMatchObject({ ok: false, words: "This build has no SMTP adapter" });
  });
});
