import type { MomentNotification, NotificationRecipient } from "@ostra/adapter-sdk";
import {
  defineNotificationContractSuite,
  memoryAdapterContext,
  sampleAccountMail,
  sampleNotification,
  startFakeResendApi,
  suiteRecipient,
} from "@ostra/adapter-sdk/testing";
import type { DeliveredNotification, FakeResendApi, ResendReceived } from "@ostra/adapter-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { ResendEmailAdapter, resendIdempotencyKey } from "./resend-email-adapter.ts";
import type { ResendEmailAdapterOptions } from "./resend-email-adapter.ts";

// The Resend adapter against the fake Resend API (ticket 12, F-115, Q186: no Resend key exists
// yet, so everything but the live case is proved on a fake whose shapes follow Resend's API
// reference). The notification contract suite, then what's the adapter's own: one message per
// recipient with its idempotency key, who is refused and who stops the send, what health says, and
// that the key and the mail's words never leave in an error or a log line.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** An environment variable of the test run (the live case's `email.env`). */
const env = (name: string): string | undefined => process.env[name];

const ada = suiteRecipient("ada", { email: true, mention: false });
const grace = suiteRecipient("grace", { email: true, mention: false });
const bad = suiteRecipient("bad", { email: true, mention: false });
const noEmail = suiteRecipient("linus", { email: false, mention: false });

const FROM = "ostra@example.com";

const start = async (options: { readonly domains?: readonly string[] } = {}): Promise<FakeResendApi> => {
  const api = await startFakeResendApi(options);
  closers.push(api.close);
  return api;
};

const adapterFor = (api: FakeResendApi, extra: Partial<ResendEmailAdapterOptions> = {}, context = memoryAdapterContext()) =>
  new ResendEmailAdapter({ apiKey: api.apiKey, from: FROM, baseUrl: api.url, ...extra }, context);

/** The notification's mail as the suite reads it: one delivery per notification key, however many messages it took. */
const groupByNotification = (received: readonly ResendReceived[]): DeliveredNotification[] => {
  const groups = new Map<string, ResendReceived[]>();
  for (const mail of received) {
    const key = (mail.idempotencyKey ?? mail.id).slice(0, (mail.idempotencyKey ?? mail.id).lastIndexOf(":"));
    groups.set(key, [...(groups.get(key) ?? []), mail]);
  }
  return [...groups.values()].flatMap((mails) => {
    const [first] = mails;
    return first === undefined
      ? []
      : [
          {
            providerMessageId: first.id,
            to: mails.flatMap((mail) => mail.to),
            subject: first.subject,
            html: first.html,
            text: first.text ?? "",
          },
        ];
  });
};

defineNotificationContractSuite({
  name: "resend, on the fake Resend API",
  create: async () => {
    const api = await startFakeResendApi();
    api.refuse.add(bad.email ?? "");
    const context = memoryAdapterContext();
    return {
      adapter: adapterFor(api, {}, context),
      fixture: {
        logs: () => context.logger.records,
        reachable: ada,
        alsoReachable: grace,
        refused: bad,
        rateLimitNext: () => {
          api.rateLimitNext(2);
        },
        delivered: () => Promise.resolve(groupByNotification(api.received)),
      },
      dispose: api.close,
    };
  },
});

const notify = (recipients: readonly NotificationRecipient[], extra: Partial<MomentNotification> = {}): MomentNotification => ({
  ...sampleNotification(recipients),
  ...extra,
});

describe("the Resend email adapter", () => {
  it("F-115/c1: mails an account mail once to its one address, the link in the HTML and the text and never in a log line, an error or the answer", async () => {
    const api = await start();
    api.refuse.add("refused-newcomer@example.com");
    const context = memoryAdapterContext();
    const adapter = adapterFor(api, {}, context);
    const mail = sampleAccountMail("newcomer@example.com");
    const sent = await adapter.send(mail);
    if (!sent.ok) throw new Error(sent.error.message);
    expect(await adapter.send(mail)).toEqual(sent);
    expect(api.received).toHaveLength(1);
    expect(api.received[0]).toMatchObject({ to: ["newcomer@example.com"], subject: mail.rendered.subject });
    expect(api.received[0]?.html).toContain(mail.url);
    expect(api.received[0]?.text).toContain(mail.url);
    expect(sent.value).toEqual({ providerMessageId: api.received[0]?.id, refused: [] });
    const refused = await adapter.send(sampleAccountMail("refused-newcomer@example.com"));
    expect(refused).toMatchObject({ ok: true, value: { refused: [{ memberId: null }] } });
    api.rateLimitNext(2);
    const limited = sampleAccountMail("newcomer@example.com");
    const failed = await adapter.send(limited);
    expect(failed).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    const surface = JSON.stringify({ refused, failed, logs: context.logger.records });
    for (const secret of [mail.url, limited.url, "newcomer@example.com"]) {
      expect(surface).not.toContain(secret);
    }
    expect(context.logger.records.length).toBeGreaterThan(0);
  });

  it("F-115: declares the email channel, which can't edit a sent mail, and says so on update", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    expect(adapter.name).toBe("resend");
    expect(adapter.capabilities).toEqual({ channels: ["email"], edits: false });
    expect(await adapter.update(notify([ada]), "any")).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("F-115/c2: sends the rendered subject, HTML and text from the configured name and address, one message per recipient", async () => {
    const api = await start();
    const notification = notify([ada, grace]);
    const sent = await adapterFor(api, { fromName: "Acme ostra" }).send(notification);
    if (!sent.ok) throw new Error(sent.error.message);
    expect(api.received).toHaveLength(2);
    expect(api.received.map((mail) => mail.to)).toEqual([["ada@example.com"], ["grace@example.com"]]);
    for (const mail of api.received) {
      expect(mail).toMatchObject({
        from: "Acme ostra <ostra@example.com>",
        subject: notification.rendered?.subject,
        html: notification.rendered?.html,
        text: notification.rendered?.text,
      });
    }
    // The ID answered is the first message's.
    expect(sent.value).toEqual({ providerMessageId: api.received[0]?.id, refused: [] });
  });

  it("F-115/c2: sets Resend's idempotency key from the notification's key and the recipient, so a retry mails nobody twice", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const notification = notify([ada, grace]);
    expect(await adapter.send(notification)).toMatchObject({ ok: true });
    expect(api.received.map((mail) => mail.idempotencyKey)).toEqual([
      `${notification.idempotencyKey}:${ada.memberId}`,
      `${notification.idempotencyKey}:${grace.memberId}`,
    ]);
    const again = await adapter.send(notification);
    expect(again).toMatchObject({ ok: true, value: { providerMessageId: api.received[0]?.id } });
    expect(api.received).toHaveLength(2);
    expect(api.calls()).toBe(4);
  });

  it("F-115: keeps an idempotency key within Resend's length, the same each time", () => {
    const long = `notify:${"x".repeat(400)}`;
    const key = resendIdempotencyKey(long, "member-1");
    expect(key.length).toBeLessThanOrEqual(256);
    expect(resendIdempotencyKey(long, "member-1")).toBe(key);
    expect(resendIdempotencyKey(long, "member-2")).not.toBe(key);
    expect(resendIdempotencyKey("short", "member-1")).toBe("short:member-1");
  });

  it("F-115/c2: reports a recipient with no address, an invalid one or one Resend refuses, and still mails the others; one address once", async () => {
    const api = await start();
    api.refuse.add("bad@example.com");
    const invalid: NotificationRecipient = { ...suiteRecipient("odd", { email: false, mention: false }), email: "not an address" };
    const twin: NotificationRecipient = { ...suiteRecipient("twin", { email: false, mention: false }), email: "ADA@example.com" };
    const sent = await adapterFor(api).send(notify([noEmail, invalid, bad, ada, twin, grace]));
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.refused.map((refused) => refused.memberId)).toEqual([noEmail.memberId, invalid.memberId, bad.memberId]);
    for (const refused of sent.value.refused) {
      expect(refused.reason.length).toBeGreaterThan(0);
      expect(refused.reason).not.toContain("@");
    }
    expect(api.received.map((mail) => mail.to[0])).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("F-115: with nobody to mail, answers no message ID and everyone refused, calling Resend never", async () => {
    const api = await start();
    const sent = await adapterFor(api).send(notify([noEmail]));
    expect(sent).toEqual({ ok: true, value: { providerMessageId: null, refused: [{ memberId: noEmail.memberId, reason: "the member has no email address" }] } });
    expect(api.calls()).toBe(0);
  });

  it("F-115: a mail with no rendered parts is invalid, before any call", async () => {
    const api = await start();
    expect(await adapterFor(api).send(notify([ada], { rendered: null }))).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(api.calls()).toBe(0);
  });

  it("F-115/c2: turns Resend's 429 into rate-limited with its retry time, the default without one, and a used-up quota into a long wait", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    api.rateLimitNext(7);
    expect(await adapter.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 7000 } });
    api.failNext(429, "rate_limit_exceeded");
    expect(await adapter.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 1000 } });
    api.failNext(429, "daily_quota_exceeded");
    const quota = await adapter.send(notify([ada]));
    expect(quota).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    expect(quota.ok ? 0 : quota.error.retryAfterMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it("F-115/c2: a refused key is the adapter's failure, in words that never hold the key", async () => {
    const api = await start();
    const secret = "re_live_never_in_a_message_9f8e7d6c";
    const context = memoryAdapterContext();
    const adapter = adapterFor(api, { apiKey: secret }, context);
    const sent = await adapter.send(notify([ada]));
    expect(sent).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(JSON.stringify(context.logger.records)).not.toContain(secret);
    expect(await adapter.health()).toEqual({ status: "down", reason: "Resend refused the API key" });
    expect(api.received).toEqual([]);
  });

  it("F-115: an unverified sender domain is the adapter's failure (forbidden), not a recipient's", async () => {
    const api = await start();
    api.enforceDomains = true;
    const sent = await adapterFor(api, { from: "ostra@stranger.test" }).send(notify([ada, grace]));
    expect(sent).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(sent.ok ? "" : sent.error.message).toContain("domain isn't verified");
    expect(api.received).toEqual([]);
  });

  it("F-115: an outage, or a Resend nobody can reach, is unavailable", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    api.failNext(503, "application_error");
    expect(await adapter.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    api.failNext(500, "internal_server_error");
    expect(await adapter.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const gone = await start();
    const unreachable = adapterFor(gone);
    await gone.close();
    expect(await unreachable.send(notify([ada]))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await unreachable.health()).toEqual({ status: "down", reason: "Resend couldn't be reached or failed" });
  });

  it("F-115/c2: a send that stops half way names its error, and the retry mails only who wasn't mailed", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const notification = notify([ada, grace]);
    // Ada's message goes; Grace's, the second call, meets the rate limit.
    api.failNext(429, "rate_limit_exceeded", 1);
    const stopped = await adapter.send(notification);
    expect(stopped).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    expect(api.received.map((mail) => mail.to[0])).toEqual(["ada@example.com"]);
    // The retry sends Ada's key again, which Resend answers without mailing her twice.
    const retried = await adapter.send(notification);
    expect(retried).toMatchObject({ ok: true, value: { providerMessageId: api.received[0]?.id } });
    expect(api.received.map((mail) => mail.to[0])).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("F-115: logs the kind and counts, never an address, the key or a word of the mail", async () => {
    const api = await start();
    const context = memoryAdapterContext();
    const notification = notify([ada, noEmail], { subject: "Quiet secret subject" });
    expect(await adapterFor(api, {}, context).send(notification)).toMatchObject({ ok: true });
    const logged = JSON.stringify(context.logger.records);
    expect(logged).toContain("resend.sent");
    for (const hidden of [api.apiKey, "ada@example.com", "Quiet secret subject", notification.body, notification.rendered?.subject ?? "?", String(ada.memberId)]) {
      expect(logged).not.toContain(hidden);
    }
  });

  it("F-115: never reads the environment: its key and address are the constructor's", async () => {
    const api = await start();
    const decoy = await start();
    const saved = { key: env("RESEND_API_KEY"), url: env("RESEND_BASE_URL") };
    process.env["RESEND_API_KEY"] = decoy.apiKey;
    process.env["RESEND_BASE_URL"] = decoy.url;
    try {
      expect(await adapterFor(api).send(notify([ada]))).toMatchObject({ ok: true });
    } finally {
      for (const [name, value] of [
        ["RESEND_API_KEY", saved.key],
        ["RESEND_BASE_URL", saved.url],
      ] as const) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
    expect(api.received).toHaveLength(1);
    expect(decoy.calls()).toBe(0);
  });
});

describe("the Resend email adapter's health", () => {
  it("F-115: is ok with a valid key and a verified domain", async () => {
    const api = await start();
    expect(await adapterFor(api).health()).toEqual({ status: "ok" });
  });

  it("F-115: is ok for a sending-only key, which can't list domains but can send, and for Resend's own test sender", async () => {
    const api = await start();
    api.restrictedKey = true;
    expect(await adapterFor(api).health()).toEqual({ status: "ok" });
    api.restrictedKey = false;
    expect(await adapterFor(api, { from: "onboarding@resend.dev" }).health()).toEqual({ status: "ok" });
  });

  it("F-115/c2: is down, in words, for a domain that isn't set up, isn't verified yet or isn't an address", async () => {
    const api = await start();
    expect(await adapterFor(api, { from: "ostra@stranger.test" }).health()).toEqual({
      status: "down",
      reason: "the domain stranger.test isn't set up in Resend, so it won't send from it",
    });
    api.domains.push({ name: "pending.example", status: "pending" });
    expect(await adapterFor(api, { from: "ostra@pending.example" }).health()).toEqual({
      status: "down",
      reason: "the domain pending.example isn't verified in Resend yet (it is pending)",
    });
    expect(await adapterFor(api, { from: "not an address" }).health()).toEqual({ status: "down", reason: "the from address isn't an email address" });
  });

  it("F-115: is degraded at the rate limit, and down when Resend answers something unreadable", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    api.failNext(429, "rate_limit_exceeded");
    expect(await adapter.health()).toEqual({ status: "degraded", reason: "Resend's rate limit is reached" });
    api.failNext(500, "internal_server_error");
    expect(await adapter.health()).toEqual({ status: "down", reason: "Resend couldn't be reached or failed" });
  });
});

// ---------- the live case ----------

// Runs only with `email.env` loaded (`set -a; . ~/.config/ostra-dev/email.env; set +a`): it sends one
// mail to Resend's test recipient and reads its delivery back from Resend's API. There is no key
// yet (ticket 51, step 1), so the same send-and-read-back runs, always, against the fake: the case
// itself is proved, and only the real Resend waits for the maintainer's key.

const readBack = async (baseUrl: string, apiKey: string, id: string): Promise<unknown> => {
  const response = await fetch(`${baseUrl}/emails/${id}`, { headers: { authorization: `Bearer ${apiKey}` } });
  return response.json();
};

const sendAndReadBack = async (options: { readonly baseUrl: string; readonly apiKey: string; readonly from: string; readonly to: string }) => {
  const adapter = new ResendEmailAdapter({ apiKey: options.apiKey, from: options.from, baseUrl: options.baseUrl }, memoryAdapterContext());
  const recipient: NotificationRecipient = { ...suiteRecipient("test", { email: false, mention: false }), email: options.to };
  const notification: MomentNotification = { ...sampleNotification([recipient]), kind: "test" };
  const sent = await adapter.send(notification);
  if (!sent.ok || sent.value.providerMessageId === null) throw new Error(sent.ok ? "no message ID" : sent.error.message);
  return { notification, id: sent.value.providerMessageId, delivery: await readBack(options.baseUrl, options.apiKey, sent.value.providerMessageId) };
};

describe("the Resend email adapter: the live case's send and read-back", () => {
  it("F-115/c2: sends one mail to the test recipient and reads its delivery back (on the fake)", async () => {
    const api = await start();
    const { notification, id, delivery } = await sendAndReadBack({ baseUrl: api.url, apiKey: api.apiKey, from: FROM, to: "delivered@resend.dev" });
    expect(delivery).toMatchObject({ id, to: ["delivered@resend.dev"], subject: notification.rendered?.subject, last_event: "delivered" });
  });

  const live = (env("RESEND_API_KEY") ?? "") !== "" && (env("EMAIL_FROM") ?? "") !== "";
  it.skipIf(!live)("F-115: sends one mail to Resend's test recipient and reads its delivery back (live, with email.env)", async () => {
    const { notification, id, delivery } = await sendAndReadBack({
      baseUrl: "https://api.resend.com",
      apiKey: env("RESEND_API_KEY") ?? "",
      from: env("EMAIL_FROM") ?? "",
      to: "delivered@resend.dev",
    });
    expect(id.length).toBeGreaterThan(0);
    expect(delivery).toMatchObject({ id, subject: notification.rendered?.subject });
  }, 60_000);
});
