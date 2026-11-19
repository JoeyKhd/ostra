import type { HealthReport, MomentNotification, NotificationRecipient } from "@ostra/adapter-sdk";
import {
  defineNotificationContractSuite,
  memoryAdapterContext,
  sampleAccountMail,
  sampleNotification,
  sampleRunnerNotice,
  startFakeSmtpServer,
  suiteRecipient,
} from "@ostra/adapter-sdk/testing";
import type { DeliveredNotification, FakeSmtpOptions, FakeSmtpServer, SmtpReceived } from "@ostra/adapter-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { readMail } from "./read-mail.ts";
import { isLoopbackHost, smtpMessageId, smtpSettingsProblem, SmtpEmailAdapter } from "./smtp-email-adapter.ts";
import type { SmtpEmailAdapterOptions } from "./smtp-email-adapter.ts";

// The SMTP adapter against the fake SMTP server (ticket 13, F-115): the real adapter on nodemailer,
// sending over loopback to a server on `node:net` that speaks STARTTLS (accepted and refused),
// SMTPS and AUTH, on a certificate made at run time (Q186: no network, no new dependency). The
// notification contract suite first, then what's the adapter's own: what reaches the server, that
// a password never crosses in clear, how a 4xx, a 5xx on RCPT and a failed sign-in are told apart,
// and that the password and the mail's words never leave in an error or a log line.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** An environment variable of the test run (the live case's `email.env`). */
const env = (name: string): string | undefined => process.env[name];

const USER = "ostra";
const PASS = "hunter2-very-secret";
const FROM = "ostra@example.com";

const ada = suiteRecipient("ada", { email: true, mention: false });
const grace = suiteRecipient("grace", { email: true, mention: false });
const bad = suiteRecipient("bad", { email: true, mention: false });
const noEmail = suiteRecipient("linus", { email: false, mention: false });

const startServer = async (options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> => {
  const server = await startFakeSmtpServer({ auth: { user: USER, pass: PASS }, ...options });
  closers.push(server.close);
  return server;
};

const optionsFor = (server: FakeSmtpServer, extra: Partial<SmtpEmailAdapterOptions> = {}): SmtpEmailAdapterOptions => ({
  host: server.host,
  port: server.port,
  secure: "starttls",
  user: USER,
  password: PASS,
  from: FROM,
  tlsCa: server.cert,
  ...extra,
});

const adapterFor = (server: FakeSmtpServer, extra: Partial<SmtpEmailAdapterOptions> = {}, context = memoryAdapterContext()): SmtpEmailAdapter => {
  const adapter = new SmtpEmailAdapter(optionsFor(server, extra), context);
  closers.push(() => {
    adapter.close();
    return Promise.resolve();
  });
  return adapter;
};

const notify = (recipients: readonly NotificationRecipient[], extra: Partial<MomentNotification> = {}): MomentNotification => ({
  ...sampleNotification(recipients),
  ...extra,
});

/** Everything the server took, the commands it read and the failures' words: where the password must never be. */
const everythingSeen = (server: FakeSmtpServer): string => `${server.commands.join("\n")}\n${server.received.map((mail) => mail.data).join("\n")}`;

/** The words a health report gives for being down. */
const reasonOf = (report: HealthReport): string => (report.status === "ok" ? "" : report.reason);

const headerOf = (mail: SmtpReceived | undefined, name: string): string => (mail === undefined ? "" : (readMail(mail.data).headers[name] ?? ""));

/** The notification's mail as the suite reads it: one delivery per notification, however many messages it took. */
const groupByNotification = (received: readonly SmtpReceived[]): DeliveredNotification[] => {
  const groups = new Map<string, SmtpReceived[]>();
  for (const mail of received) {
    const key = headerOf(mail, "x-ostra-notification");
    groups.set(key, [...(groups.get(key) ?? []), mail]);
  }
  return [...groups.values()].flatMap((mails) => {
    const [first] = mails;
    if (first === undefined) return [];
    const read = readMail(first.data);
    return [{ providerMessageId: read.messageId, to: mails.flatMap((mail) => mail.to), subject: read.subject, html: read.html, text: read.text }];
  });
};

defineNotificationContractSuite({
  name: "smtp, on the fake SMTP server (STARTTLS and AUTH)",
  create: async () => {
    const server = await startFakeSmtpServer({
      auth: { user: USER, pass: PASS },
      requireTls: true,
      rejectRecipients: { [bad.email ?? ""]: "550 5.1.1 No such user" },
    });
    const context = memoryAdapterContext();
    const adapter = new SmtpEmailAdapter(optionsFor(server), context);
    return {
      adapter,
      fixture: {
        logs: () => context.logger.records,
        reachable: ada,
        alsoReachable: grace,
        refused: bad,
        delivered: () => Promise.resolve(groupByNotification(server.received)),
      },
      dispose: async () => {
        adapter.close();
        await server.close();
      },
    };
  },
});

describe("the SMTP email adapter", () => {
  it("F-115: mails an account mail once to its one address, the link in the HTML and the text and never in a log line or the answer", async () => {
    const server = await startServer({ starttls: "offered", rejectRecipients: { "refused-newcomer@example.com": "550 5.1.1 No such user" } });
    const context = memoryAdapterContext();
    const adapter = adapterFor(server, {}, context);
    const mail = sampleAccountMail("newcomer@example.com");
    const sent = await adapter.send(mail);
    if (!sent.ok) throw new Error(sent.error.message);
    expect(await adapter.send(mail)).toEqual(sent);
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.to).toEqual(["newcomer@example.com"]);
    const read = readMail(server.received[0]?.data ?? "");
    expect(read.subject).toBe(mail.rendered.subject);
    expect(read.html).toContain(mail.url);
    expect(read.text).toContain(mail.url);
    const refused = await adapter.send(sampleAccountMail("refused-newcomer@example.com"));
    expect(refused).toMatchObject({ ok: true, value: { refused: [{ memberId: null }] } });
    const surface = JSON.stringify({ sent, refused, logs: context.logger.records });
    for (const secret of [mail.url, "newcomer@example.com"]) {
      expect(surface).not.toContain(secret);
    }
    expect(context.logger.records.length).toBeGreaterThan(0);
  });

  it("F-115: declares the email channel, which can't edit a sent mail, and says so on update", async () => {
    const server = await startServer();
    const adapter = adapterFor(server);
    expect(adapter.name).toBe("smtp");
    expect(adapter.capabilities).toEqual({ channels: ["email"], edits: false });
    expect(await adapter.update(notify([ada]), "any")).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("F-115: with STARTTLS accepted, sends over TLS after signing in, one message per recipient with the rendered parts", async () => {
    const server = await startServer({ starttls: "offered", requireTls: true });
    const notification = notify([ada, grace]);
    const sent = await adapterFor(server, { fromName: "Acme ostra" }).send(notification);
    if (!sent.ok) throw new Error(sent.error.message);
    expect(server.received).toHaveLength(2);
    expect(server.received.map((mail) => mail.to)).toEqual([["ada@example.com"], ["grace@example.com"]]);
    for (const mail of server.received) {
      expect(mail).toMatchObject({ from: FROM, tls: true, user: USER });
      const read = readMail(mail.data);
      expect(read.headers["from"]).toBe(`Acme ostra <${FROM}>`);
      expect(read.subject).toBe(notification.rendered?.subject);
      expect(read.html).toBe(notification.rendered?.html);
      expect(read.text.replaceAll("\r\n", "\n").trimEnd()).toBe(notification.rendered?.text.trimEnd());
    }
    // The ID answered is the first message's.
    expect(sent.value).toEqual({ providerMessageId: readMail(server.received[0]?.data ?? "").messageId, refused: [] });
    expect(server.commands.filter((command) => command.startsWith("STARTTLS"))).not.toHaveLength(0);
  });

  it("F-091: mails both runner notices with the runner's facts in the HTML and the text parts", async () => {
    const server = await startServer({ starttls: "offered", requireTls: true });
    const adapter = adapterFor(server);
    for (const kind of ["runner_joined", "runner_awaiting_approval"] as const) {
      const notice = sampleRunnerNotice(kind, [ada]);
      const sent = await adapter.send(notice.notification);
      if (!sent.ok) throw new Error(sent.error.message);
      const read = readMail(server.received.at(-1)?.data ?? "");
      expect(read.subject).toBe(notice.notification.rendered?.subject);
      for (const fact of notice.facts) {
        expect(read.html).toContain(fact);
        expect(read.text).toContain(fact);
      }
    }
    expect(server.received).toHaveLength(2);
  });

  it("F-115: with STARTTLS refused, sends nothing and never signs in, so the password never crosses in clear", async () => {
    const server = await startServer({ starttls: "refused" });
    const sent = await adapterFor(server).send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(sent.ok ? "" : sent.error.message).toMatch(/TLS/);
    expect(server.received).toEqual([]);
    expect(server.commands.some((command) => command.startsWith("AUTH") || command.startsWith("MAIL"))).toBe(false);
    expect(everythingSeen(server)).not.toContain(PASS);
    expect(everythingSeen(server)).not.toContain(Buffer.from(`\u0000${USER}\u0000${PASS}`).toString("base64"));
  });

  it("F-115: with STARTTLS not offered at all, STARTTLS mode sends nothing either", async () => {
    const server = await startServer({ starttls: "none" });
    const sent = await adapterFor(server).send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(sent.ok ? "" : sent.error.message).toMatch(/TLS/);
    expect(server.received).toEqual([]);
    expect(server.commands.some((command) => command.startsWith("AUTH"))).toBe(false);
  });

  it("F-115: a certificate it doesn't trust stops the send before any sign-in", async () => {
    const server = await startServer({ starttls: "offered" });
    // The server's throwaway certificate isn't among the system's, and no CA was added.
    const adapter = new SmtpEmailAdapter({ ...optionsFor(server), tlsCa: "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----" });
    closers.push(() => {
      adapter.close();
      return Promise.resolve();
    });
    const sent = await adapter.send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(server.received).toEqual([]);
    expect(server.commands.some((command) => command.startsWith("AUTH"))).toBe(false);
  });

  it("F-115: in tls mode (SMTPS), is encrypted from the first byte", async () => {
    const server = await startServer({ implicitTls: true });
    const sent = await adapterFor(server, { secure: "tls" }).send(notify([ada]));
    expect(sent).toMatchObject({ ok: true });
    expect(server.received).toMatchObject([{ to: ["ada@example.com"], tls: true, user: USER }]);
  });

  it("F-115: in none mode, to this machine only, signs in and sends in plain text, even when the server offers STARTTLS", async () => {
    const server = await startServer({ starttls: "offered" });
    const sent = await adapterFor(server, { secure: "none" }).send(notify([ada]));
    expect(sent).toMatchObject({ ok: true });
    expect(server.received).toMatchObject([{ tls: false, user: USER }]);
    expect(server.commands.some((command) => command.startsWith("STARTTLS"))).toBe(false);
  });

  it("F-115: none is refused for a host that isn't this machine, before any connection", async () => {
    const options: SmtpEmailAdapterOptions = { host: "smtp.example.com", port: 25, secure: "none", user: USER, password: PASS, from: FROM };
    expect(smtpSettingsProblem(options)).toMatch(/only allowed to this machine/);
    const adapter = new SmtpEmailAdapter(options, memoryAdapterContext());
    expect(await adapter.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.health()).toMatchObject({ status: "down" });
    adapter.close();
    for (const loopback of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(loopback)).toBe(true);
      expect(smtpSettingsProblem({ ...options, host: loopback })).toBeNull();
    }
    for (const remote of ["smtp.example.com", "10.0.0.5", "127.0.0.1.example.com", "localhost.example.com", "128.0.0.1"]) {
      expect(isLoopbackHost(remote)).toBe(false);
      expect(smtpSettingsProblem({ ...options, host: remote })).not.toBeNull();
    }
    // The encrypted modes are fine to any host.
    expect(smtpSettingsProblem({ ...options, secure: "starttls" })).toBeNull();
    expect(smtpSettingsProblem({ ...options, secure: "tls" })).toBeNull();
  });

  it("F-115: refuses settings that can't work, in words", () => {
    const base: SmtpEmailAdapterOptions = { host: "smtp.example.com", port: 587, secure: "starttls", from: FROM };
    expect(smtpSettingsProblem(base)).toBeNull();
    expect(smtpSettingsProblem({ ...base, host: " " })).toMatch(/host/);
    expect(smtpSettingsProblem({ ...base, port: 0 })).toMatch(/port/);
    expect(smtpSettingsProblem({ ...base, port: 70_000 })).toMatch(/port/);
    expect(smtpSettingsProblem({ ...base, from: "not an address" })).toMatch(/from address/);
    expect(smtpSettingsProblem({ ...base, user: "ostra" })).toMatch(/no password/);
    expect(smtpSettingsProblem({ ...base, password: "x" })).toMatch(/no user/);
    expect(smtpSettingsProblem({ ...base, user: "ostra", password: "x" })).toBeNull();
  });

  it("F-115: sends without a sign-in to a relay that wants none", async () => {
    const server = await startServer({ auth: null, starttls: "offered" });
    const sent = await adapterFor(server, { user: "", password: "" }).send(notify([ada]));
    expect(sent).toMatchObject({ ok: true });
    expect(server.received).toMatchObject([{ user: null, tls: true }]);
  });

  it("F-115: gives each message an ID made from the notification's key and the recipient, the same on a retry", async () => {
    const server = await startServer();
    const context = { logger: memoryAdapterContext().logger, clock: memoryAdapterContext().clock };
    // Without an idempotency store every send goes out, so a retry shows what it would send again.
    const adapter = adapterFor(server, {}, context);
    const notification = notify([ada, grace]);
    expect(await adapter.send(notification)).toMatchObject({ ok: true });
    expect(await adapter.send(notification)).toMatchObject({ ok: true });
    const ids = server.received.map((mail) => readMail(mail.data).messageId);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(smtpMessageId(notification.idempotencyKey, ada.memberId, "example.com"));
    expect(smtpMessageId("other-key", ada.memberId, "example.com")).not.toBe(ids[0]);
    expect(ids[0]).toMatch(/^<ostra\.[0-9a-f]{40}@example\.com>$/);
  });

  it("F-115: marks the mail as machine-sent and groups a notification's messages by a hash of its key", async () => {
    const server = await startServer();
    const notification = notify([ada, grace]);
    expect(await adapterFor(server).send(notification)).toMatchObject({ ok: true });
    const [first, second] = server.received;
    expect(headerOf(first, "auto-submitted")).toBe("auto-generated");
    expect(headerOf(first, "x-ostra-notification")).toBe(headerOf(second, "x-ostra-notification"));
    expect(headerOf(first, "x-ostra-notification")).not.toContain(notification.idempotencyKey);
  });

  it("F-115: mails a notification once when it is sent again with the same key", async () => {
    const server = await startServer();
    const adapter = adapterFor(server);
    const notification = notify([ada, grace]);
    const first = await adapter.send(notification);
    const again = await adapter.send(notification);
    expect(again).toEqual(first);
    expect(server.received).toHaveLength(2);
  });

  it("F-115: reports a recipient with no address, an invalid one or one the server refuses with a 5xx, and still mails the others", async () => {
    const server = await startServer({ rejectRecipients: { "bad@example.com": "550 5.1.1 No such user" } });
    const invalid: NotificationRecipient = { ...suiteRecipient("odd", { email: false, mention: false }), email: "not an address" };
    const sent = await adapterFor(server).send(notify([ada, noEmail, invalid, bad, grace, { ...ada, email: "ADA@example.com" }]));
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.refused.map((refused) => refused.memberId)).toEqual([noEmail.memberId, invalid.memberId, bad.memberId]);
    expect(sent.value.refused.every((refused) => refused.reason.length > 0 && !refused.reason.includes("bad@example.com"))).toBe(true);
    // The same address twice is mailed once.
    expect(server.received.map((mail) => mail.to[0])).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("F-115: with nobody to mail, answers no message ID and everyone refused, connecting never", async () => {
    const server = await startServer();
    const sent = await adapterFor(server).send(notify([noEmail]));
    expect(sent).toEqual({ ok: true, value: { providerMessageId: null, refused: [{ memberId: noEmail.memberId, reason: "the member has no email address" }] } });
    expect(server.commands).toEqual([]);
  });

  it("F-115: a mail with no rendered parts is invalid, before any connection", async () => {
    const server = await startServer();
    const sent = await adapterFor(server).send({ ...notify([ada]), rendered: null });
    expect(sent).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(server.commands).toEqual([]);
  });

  it("F-115: a 4xx reply is retryable, with a time to wait, and the retry mails only who wasn't mailed", async () => {
    const busy: Record<string, string> = { "grace@example.com": "450 4.2.1 Mailbox busy" };
    const server = await startServer({ rejectRecipients: busy });
    const adapter = adapterFor(server);
    const notification = notify([ada, grace]);
    const stopped = await adapter.send(notification);
    expect(stopped).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(stopped.ok ? 0 : stopped.error.retryAfterMs).toBeGreaterThan(0);
    expect(server.received.map((mail) => mail.to[0])).toEqual(["ada@example.com"]);
    // The mailbox frees up. The retry doesn't mail Ada again.
    Reflect.deleteProperty(busy, "grace@example.com");
    const retried = await adapter.send(notification);
    expect(retried).toMatchObject({ ok: true, value: { providerMessageId: readMail(server.received[0]?.data ?? "").messageId, refused: [] } });
    expect(server.received.map((mail) => mail.to[0])).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("F-115: a refused sign-in is the adapter's failure (unauthorized), in words that never hold the password", async () => {
    const server = await startServer();
    const adapter = adapterFor(server, { password: "wrong-password-xyz" });
    const sent = await adapter.send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(JSON.stringify(sent)).not.toContain("wrong-password-xyz");
    expect(server.received).toEqual([]);
    const health = await adapter.health();
    expect(health).toMatchObject({ status: "down" });
    expect(JSON.stringify(health)).not.toContain("wrong-password-xyz");
  });

  it("F-115: a server nobody can reach is unavailable, and health says so in words", async () => {
    const server = await startServer();
    const adapter = adapterFor(server);
    await server.close();
    const sent = await adapter.send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const health = await adapter.health();
    expect(health.status).toBe("down");
    expect(reasonOf(health)).toContain(`${server.host}:${String(server.port)}`);
    expect(JSON.stringify([sent, health])).not.toContain(PASS);
  });

  it("F-115: logs the kind and counts, never an address, the password or a word of the mail", async () => {
    const server = await startServer();
    const context = memoryAdapterContext();
    const notification = notify([ada, noEmail], { subject: "Quiet secret subject" });
    expect(await adapterFor(server, {}, context).send(notification)).toMatchObject({ ok: true });
    expect(await adapterFor(server, { password: "wrong-password-xyz" }, context).send(notify([grace]))).toMatchObject({ ok: false });
    const logged = JSON.stringify(context.logger.records);
    expect(logged).toContain("smtp.sent");
    expect(logged).toContain("smtp.send_failed");
    for (const hidden of [PASS, "wrong-password-xyz", "ada@example.com", "grace@example.com", "Quiet secret subject", notification.body, notification.rendered?.subject ?? "?", String(ada.memberId)]) {
      expect(logged).not.toContain(hidden);
    }
  });
});

describe("the SMTP email adapter's health", () => {
  it("F-115: is ok when the server takes the connection, the TLS and the sign-in", async () => {
    const server = await startServer();
    expect(await adapterFor(server).health()).toEqual({ status: "ok" });
  });

  it("F-115: is down, in words, when STARTTLS is refused or the certificate isn't trusted", async () => {
    const refused = await startServer({ starttls: "refused" });
    const report = await adapterFor(refused).health();
    expect(report.status).toBe("down");
    expect(reasonOf(report)).toMatch(/TLS/);
    const untrusted = await startServer();
    const withoutCa = new SmtpEmailAdapter({ ...optionsFor(untrusted), tlsCa: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" });
    closers.push(() => {
      withoutCa.close();
      return Promise.resolve();
    });
    const untrustedReport = await withoutCa.health();
    expect(untrustedReport.status).toBe("down");
    expect(reasonOf(untrustedReport)).toMatch(/TLS/);
  });

  it("F-115: is down, in words, for a refused sign-in", async () => {
    const server = await startServer();
    const report = await adapterFor(server, { user: "someone-else" }).health();
    expect(report.status).toBe("down");
    expect(reasonOf(report)).toMatch(/user name or password/);
  });
});

describe("the SMTP email adapter, through Resend's SMTP relay", () => {
  const live = (env("RESEND_API_KEY") ?? "") !== "" && (env("EMAIL_FROM") ?? "") !== "";
  it.skipIf(!live)("F-115: sends one mail to Resend's test recipient through smtp.resend.com (live, with email.env)", async () => {
    const adapter = new SmtpEmailAdapter(
      { host: "smtp.resend.com", port: 465, secure: "tls", user: "resend", password: env("RESEND_API_KEY") ?? "", from: env("EMAIL_FROM") ?? "" },
      memoryAdapterContext(),
    );
    try {
      expect(await adapter.health()).toEqual({ status: "ok" });
      const recipient: NotificationRecipient = { ...suiteRecipient("test", { email: false, mention: false }), email: "delivered@resend.dev" };
      const sent = await adapter.send({ ...sampleNotification([recipient]), kind: "test" });
      expect(sent).toMatchObject({ ok: true, value: { refused: [] } });
    } finally {
      adapter.close();
    }
  }, 60_000);
});
