import { randomBytes, randomUUID } from "node:crypto";

import { ResendEmailAdapter } from "@ostra/adapter-email-resend";
import { SmtpEmailAdapter } from "@ostra/adapter-email-smtp";
import { readMail } from "@ostra/adapter-email-smtp/read-mail";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { startFakeResendApi, startFakeSmtpServer } from "@ostra/adapter-sdk/testing";
import type { FakeResendApi, FakeSmtpServer } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { accountTokenHash, membershipVerificationIdentifier } from "@ostra/domain";
import type { Clock, EmailFromSettings } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import { organizationIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeSecretStore } from "../testing/fake-adapters.ts";
import { createEmailChannel } from "../notifications/email.ts";
import type { EmailAdapterFactories } from "../notifications/email.ts";
import { accountMailSendHandler } from "./account-mail.ts";
import type { AccountMailDeps } from "./account-mail.ts";

// Ticket 19 (F-002, F-115, ADR 0053): `account-mail.send`, against a real database and queue, with
// the real Resend adapter on the fake Resend API and the real SMTP adapter on the fake SMTP server.
// Each purpose sends one mail with its link in both parts; a replay sends nothing twice; a record
// that's no longer pending sends nothing; and the link is in no log line, job payload or delivery row.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let resend: FakeResendApi;
let smtp: FakeSmtpServer;
let organizationId: OrganizationId;
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
const PUBLIC_URL = "https://ostra.example";
const now = Date.now();
const clock: Clock = { now: () => now };
const REFUSED = "nobody@refused.example";

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  organizationId = organizationIdSchema.parse(fixture.a.organization.id);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  resend = await startFakeResendApi();
  smtp = await startFakeSmtpServer({ starttls: "offered", auth: { user: "ostra", pass: "relay-password" }, rejectRecipients: { [REFUSED]: "550 5.1.1 No such user" } });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await resend.close();
  await smtp.close();
  await test.dispose();
});

const factories: EmailAdapterFactories = {
  resend: (options, context) => new ResendEmailAdapter({ ...options, baseUrl: resend.url }, context),
  smtp: (options, context) => new SmtpEmailAdapter({ ...options, tlsCa: smtp.cert }, context),
};

type Provider = "resend" | "smtp";

const fromSettings = (provider: Provider | "off"): EmailFromSettings => {
  switch (provider) {
    case "off":
      return { source: "settings", provider: "off" };
    case "resend":
      return { source: "settings", provider: "resend", from: "ostra@mail.example", fromName: "ostra", apiKey: resend.apiKey };
    case "smtp":
      return { source: "settings", provider: "smtp", from: "ostra@mail.example", fromName: "ostra", host: "127.0.0.1", port: smtp.port, secure: "starttls", user: "ostra", password: "relay-password" };
    default:
      return provider satisfies never;
  }
};

const depsFor = (provider: Provider | "off"): AccountMailDeps & { readonly close: () => void } => {
  const channel = createEmailChannel({ db: test.db, secretStore: new FakeSecretStore(), clock, logger, publicUrl: PUBLIC_URL, stallMinutes: 30, fromSettings: fromSettings(provider), factories });
  return { db: test.db, clock, logger, publicUrl: PUBLIC_URL, accountSender: channel.accountSender, verificationHours: 24, close: channel.close };
};

type Purpose = "invitation" | "email_verification" | "password_reset";

const contextFor = (purpose: Purpose, recordId: string, retryCount = 0): JobContext<"account-mail.send"> => ({
  job: "account-mail.send",
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  retryCount,
  payload: { organizationId, purpose, recordId },
  logger,
});

const send = async (provider: Provider | "off", purpose: Purpose, recordId: string, retryCount = 0): Promise<"ok" | "threw"> => {
  const deps = depsFor(provider);
  try {
    await accountMailSendHandler(deps)(contextFor(purpose, recordId, retryCount));
    return "ok";
  } catch {
    return "threw";
  } finally {
    deps.close();
  }
};

/** A mail as the person gets it, from whichever fake took it: its subject and both parts. */
type Received = { readonly to: string; readonly subject: string; readonly text: string; readonly html: string };

const mailSince = (provider: Provider, base: number): readonly Received[] =>
  provider === "resend"
    ? resend.received.slice(base).map((mail) => ({ to: mail.to.join(","), subject: mail.subject, text: mail.text ?? "", html: mail.html ?? "" }))
    : smtp.received.slice(base).map((mail) => {
        const read = readMail(mail.data);
        return { to: mail.to.join(","), subject: read.subject, text: read.text, html: read.html };
      });

const countOf = (provider: Provider): number => (provider === "resend" ? resend.received.length : smtp.received.length);

let counter = 0;
const address = (label: string): string => {
  counter += 1;
  return `${label}-${String(counter)}@example.com`;
};

const newInvitation = async (overrides: { readonly email?: string; readonly status?: string; readonly revokedAt?: Date; readonly expiresAt?: Date } = {}): Promise<string> => {
  const id = randomBytes(16).toString("hex");
  await test.db.invitation.create({
    data: {
      id,
      organizationId,
      email: overrides.email ?? address("invitee"),
      role: "member",
      status: overrides.status ?? "pending",
      expiresAt: overrides.expiresAt ?? new Date(now + 7 * 86_400_000),
      inviterId: fixture.a.admin.userId,
      ...(overrides.revokedAt === undefined ? {} : { revokedAt: overrides.revokedAt }),
    },
  });
  return id;
};

/** An account that accepted an invitation with email on: its membership waits for verification. */
const pendingMembership = async (state: "pending_verification" | "active" = "pending_verification"): Promise<{ readonly memberId: string; readonly invitationId: string; readonly email: string }> => {
  const email = address("joiner");
  const user = await test.db.user.create({ data: { id: randomUUID(), name: "Joiner", email, username: `joiner-${String(counter)}` } });
  const memberId = randomUUID();
  await test.db.member.create({ data: { id: memberId, organizationId, userId: user.id, role: "member", createdAt: new Date(now), state } });
  const invitationId = await newInvitation({ email, status: "accepted" });
  await test.db.invitation.update({ where: { id: invitationId }, data: { acceptedAt: new Date(now), acceptedUserId: user.id } });
  return { memberId, invitationId, email };
};

const resetGrant = async (overrides: { readonly usedAt?: Date } = {}): Promise<{ readonly grantId: string; readonly email: string; readonly userId: string }> => {
  const userId = fixture.a.member.userId;
  const grant = await test.db.resetLinkGrant.create({
    data: { userId, kind: "self_service", tokenHash: `pending:${randomUUID()}`, expiresAt: new Date(now + 24 * 3_600_000), ...(overrides.usedAt === undefined ? {} : { usedAt: overrides.usedAt }) },
  });
  const user = await test.db.user.findUniqueOrThrow({ where: { id: userId } });
  return { grantId: grant.id, email: user.email, userId };
};

const deliveryOf = (purpose: Purpose, recordId: string) => test.db.accountMailDelivery.findUnique({ where: { purpose_recordId: { purpose, recordId } } });

/** The button's link, which the mail must carry in both its parts. */
const linkIn = (mail: Received): string => /href="([^"]+)"/.exec(mail.html)?.[1]?.replaceAll("&amp;", "&") ?? "";

/**
 * Nothing outside the mail itself holds the link: no log line holds its secret part, and no job row
 * or delivery row holds the link. An invitation's secret is its ID, which the payload and the
 * delivery row name as their record (spec 5.4: the payload is the record's ID), as the invitation's
 * own row does; a verification's or a reset's token is in neither.
 */
const expectLinkNowhereElse = async (link: string, secret: string, secretIsRecordId: boolean): Promise<void> => {
  expect(secret.length).toBeGreaterThan(15);
  expect(link).toContain(secret);
  expect(JSON.stringify(records)).not.toContain(secret);
  const deliveries = JSON.stringify(await test.db.accountMailDelivery.findMany());
  const jobRows = JSON.stringify(await test.db.$queryRaw<{ data: string }[]>`SELECT coalesce(data::text, '') || coalesce(output::text, '') AS data FROM pgboss.job`);
  for (const stored of [deliveries, jobRows]) {
    expect(stored).not.toContain(link);
    if (!secretIsRecordId) {
      expect(stored).not.toContain(secret);
    }
  }
};

describe("each purpose, through Resend and SMTP", () => {
  const providers = ["resend", "smtp"] as const;

  it.each(providers)("F-002, F-115: an invitation sends one mail, its link in both parts, through %s", async (provider) => {
    const email = address("sam");
    const invitationId = await newInvitation({ email });
    // Through the real queue, so its payload row is there to search.
    await test.db.$transaction((tx) => jobs.enqueueInTx(tx, "account-mail.send", { organizationId, purpose: "invitation", recordId: invitationId }));
    const base = countOf(provider);
    expect(await send(provider, "invitation", invitationId)).toBe("ok");
    const mails = mailSince(provider, base);
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    if (mail === undefined) {
      throw new Error("no mail");
    }
    expect(mail.to).toContain(email);
    const link = linkIn(mail);
    expect(link).toBe(`${PUBLIC_URL}/invite/${invitationId}`);
    expect(mail.text).toContain(link);
    expect(mail.subject).toContain(fixture.a.organization.name);
    expect(await deliveryOf("invitation", invitationId)).toMatchObject({ state: "sent", attempts: 1, adapter: provider, error: null });
    await expectLinkNowhereElse(link, invitationId, true);
  });

  it.each(providers)("F-002, F-115: a membership's verification sends one mail whose link holds a token ostra keeps only hashed, through %s", async (provider) => {
    const pending = await pendingMembership();
    const base = countOf(provider);
    expect(await send(provider, "email_verification", pending.memberId)).toBe("ok");
    const mails = mailSince(provider, base);
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    if (mail === undefined) {
      throw new Error("no mail");
    }
    expect(mail.to).toContain(pending.email);
    const link = linkIn(mail);
    expect(link.startsWith(`${PUBLIC_URL}/invite/${pending.invitationId}?verify=`)).toBe(true);
    expect(mail.text).toContain(link);
    const token = new URL(link).searchParams.get("verify") ?? "";
    const row = await test.db.verification.findFirst({ where: { identifier: membershipVerificationIdentifier(accountTokenHash(token)) } });
    expect(row?.value).toBe(pending.memberId);
    // The token itself is in no row of ostra's.
    expect(await test.db.verification.count({ where: { identifier: { contains: token } } })).toBe(0);
    await expectLinkNowhereElse(link, token, false);
  });

  it.each(providers)("F-002, F-115: a reset sends one mail whose token better-auth's reset takes and the grant keeps only hashed, through %s", async (provider) => {
    const grant = await resetGrant();
    const base = countOf(provider);
    expect(await send(provider, "password_reset", grant.grantId)).toBe("ok");
    const mails = mailSince(provider, base);
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    if (mail === undefined) {
      throw new Error("no mail");
    }
    expect(mail.to).toContain(grant.email);
    const link = linkIn(mail);
    expect(link.startsWith(`${PUBLIC_URL}/reset/new?token=`)).toBe(true);
    expect(mail.text).toContain(link);
    const token = new URL(link).searchParams.get("token") ?? "";
    expect((await test.db.verification.findFirst({ where: { identifier: `reset-password:${token}` } }))?.value).toBe(grant.userId);
    expect((await test.db.resetLinkGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).tokenHash).toBe(accountTokenHash(token));
    await expectLinkNowhereElse(link, token, false);
  });

  it.each(providers)("F-002, F-115: a replayed job sends nothing twice, through %s", async (provider) => {
    const invitationId = await newInvitation();
    const base = countOf(provider);
    expect(await send(provider, "invitation", invitationId)).toBe("ok");
    expect(await send(provider, "invitation", invitationId)).toBe("ok");
    expect(await send(provider, "invitation", invitationId, 1)).toBe("ok");
    expect(mailSince(provider, base)).toHaveLength(1);
    expect(await deliveryOf("invitation", invitationId)).toMatchObject({ state: "sent", attempts: 1 });
  });
});

describe("records no longer pending", () => {
  it("F-002: a revoked invitation sends nothing", async () => {
    const invitationId = await newInvitation({ status: "canceled", revokedAt: new Date(now - 1_000) });
    const base = countOf("smtp");
    expect(await send("smtp", "invitation", invitationId)).toBe("ok");
    expect(mailSince("smtp", base)).toHaveLength(0);
    expect(await deliveryOf("invitation", invitationId)).toMatchObject({ state: "skipped", error: "the invitation was revoked" });
  });

  it("F-002: an expired or accepted invitation sends nothing", async () => {
    const expired = await newInvitation({ expiresAt: new Date(now - 1_000) });
    const accepted = await newInvitation({ status: "accepted" });
    const base = countOf("smtp");
    expect(await send("smtp", "invitation", expired)).toBe("ok");
    expect(await send("smtp", "invitation", accepted)).toBe("ok");
    expect(mailSince("smtp", base)).toHaveLength(0);
    expect(await deliveryOf("invitation", expired)).toMatchObject({ state: "skipped", error: "the invitation expired" });
    expect(await deliveryOf("invitation", accepted)).toMatchObject({ state: "skipped", error: "the invitation was accepted" });
  });

  it("F-002: a membership already verified sends nothing", async () => {
    const verified = await pendingMembership("active");
    const base = countOf("smtp");
    expect(await send("smtp", "email_verification", verified.memberId)).toBe("ok");
    expect(mailSince("smtp", base)).toHaveLength(0);
    expect(await deliveryOf("email_verification", verified.memberId)).toMatchObject({ state: "skipped", error: "the membership is verified" });
  });

  it("F-002: a reset link already used sends nothing", async () => {
    const grant = await resetGrant({ usedAt: new Date(now - 1_000) });
    const base = countOf("smtp");
    expect(await send("smtp", "password_reset", grant.grantId)).toBe("ok");
    expect(mailSince("smtp", base)).toHaveLength(0);
    expect(await deliveryOf("password_reset", grant.grantId)).toMatchObject({ state: "skipped", error: "the reset link was used" });
  });

  it("F-002: another organization's record sends nothing", async () => {
    const otherInvitation = randomBytes(16).toString("hex");
    await test.db.invitation.create({
      data: { id: otherInvitation, organizationId: fixture.b.organization.id, email: address("stranger"), role: "member", status: "pending", expiresAt: new Date(now + 86_400_000), inviterId: fixture.b.admin.userId },
    });
    const base = countOf("smtp");
    expect(await send("smtp", "invitation", otherInvitation)).toBe("ok");
    expect(mailSince("smtp", base)).toHaveLength(0);
  });
});

describe("mail off and failures", () => {
  it("F-115: with email off, nothing is sent and the row says so", async () => {
    const invitationId = await newInvitation();
    const before = { resend: countOf("resend"), smtp: countOf("smtp") };
    expect(await send("off", "invitation", invitationId)).toBe("ok");
    expect(countOf("resend")).toBe(before.resend);
    expect(countOf("smtp")).toBe(before.smtp);
    expect(await deliveryOf("invitation", invitationId)).toMatchObject({ state: "skipped", error: "email is off" });
  });

  it("F-002: a refused address fails for good, with the provider's words on the row for the invitation's admin", async () => {
    const invitationId = await newInvitation({ email: REFUSED });
    expect(await send("smtp", "invitation", invitationId)).toBe("ok");
    const row = await deliveryOf("invitation", invitationId);
    expect(row?.state).toBe("failed");
    expect(row?.error).toMatch(/^the mail provider refused the address: /);
    expect(row?.error).not.toContain(invitationId);
  });

  it("F-115: a provider that's down is retried with the queue's backoff, and the mail goes once it's back", async () => {
    const invitationId = await newInvitation();
    const down: EmailAdapterFactories = { ...factories, resend: (options, context) => new ResendEmailAdapter({ ...options, baseUrl: "http://127.0.0.1:1" }, context) };
    const channel = createEmailChannel({ db: test.db, secretStore: new FakeSecretStore(), clock, logger, publicUrl: PUBLIC_URL, stallMinutes: 30, fromSettings: fromSettings("resend"), factories: down });
    const deps: AccountMailDeps = { db: test.db, clock, logger, publicUrl: PUBLIC_URL, accountSender: channel.accountSender, verificationHours: 24 };
    await expect(accountMailSendHandler(deps)(contextFor("invitation", invitationId))).rejects.toThrow("will be tried again");
    channel.close();
    const waiting = await deliveryOf("invitation", invitationId);
    expect(waiting).toMatchObject({ state: "pending", attempts: 1 });
    expect(waiting?.error).not.toBeNull();
    const base = countOf("resend");
    expect(await send("resend", "invitation", invitationId, 1)).toBe("ok");
    expect(mailSince("resend", base)).toHaveLength(1);
    expect(await deliveryOf("invitation", invitationId)).toMatchObject({ state: "sent", attempts: 2, error: null });
  });
});
