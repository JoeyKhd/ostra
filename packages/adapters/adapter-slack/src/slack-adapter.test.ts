import { createAdapterRegistry } from "@ostra/adapter-sdk";
import type { MomentNotification, NotificationRecipient } from "@ostra/adapter-sdk";
import {
  defineNotificationContractSuite,
  memoryAdapterContext,
  sampleNotification,
  startFakeSlack,
  suiteRecipient,
} from "@ostra/adapter-sdk/testing";
import type { DeliveredNotification, FakeSlack, FakeSlackMessage, FakeSlackOptions } from "@ostra/adapter-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  SlackNotificationAdapter,
  slackAuthorizeUrl,
  slackCheck,
  slackExchangeCode,
  slackLookupByEmail,
  slackRefresh,
} from "./index.ts";

// The Slack adapter against the fake Slack Web API (F-057, ticket 03; spec section 4.3). The
// notification contract suite first, then what is Slack's own: the `D…` channel and `ts` in the
// provider ID, a member Slack doesn't know, the error table, the literal words, the edit in place,
// and that the token, a code and a state never reach a log line, an error or a `SendResult`.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const WORKSPACE_USERS = [
  { email: "ada@example.com", id: "U0ADA" },
  { email: "grace@example.com", id: "U0GRACE" },
] as const;

const start = async (options: FakeSlackOptions = {}): Promise<FakeSlack> => {
  const api = await startFakeSlack({ users: WORKSPACE_USERS, ...options });
  closers.push(api.close);
  return api;
};

/** A recipient carrying the workspace user ID ticket 04's `NotificationRecipient.slackUserId` holds. */
type SlackRecipient = NotificationRecipient & { readonly slackUserId: string | null };

const slackRecipient = (name: string, slackUserId: string | null): SlackRecipient => ({
  ...suiteRecipient(name, { email: true, mention: false }),
  slackUserId,
});

const adapterFor = (api: FakeSlack, context = memoryAdapterContext()): SlackNotificationAdapter =>
  new SlackNotificationAdapter({ apiUrl: api.apiUrl, token: api.token }, context);

const messageIdOf = (message: FakeSlackMessage): string => `slack:${message.channel}:${message.ts}`;

/**
 * What the fake's store says the channel delivered, as the contract suite reads it: one entry per
 * send. The suite sends several recipients one notification whose text is the same for each, so
 * messages carrying the same text are one delivery with several conversations.
 */
const deliveredFrom = (api: FakeSlack): readonly DeliveredNotification[] => {
  const groups = new Map<string, DeliveredNotification>();
  for (const message of api.messages()) {
    const existing = groups.get(message.text);
    groups.set(
      message.text,
      existing === undefined
        ? { providerMessageId: messageIdOf(message), to: [message.channel], subject: "", html: null, text: message.text }
        : { ...existing, to: [...existing.to, message.channel] },
    );
  }
  return [...groups.values()];
};

defineNotificationContractSuite({
  name: "slack, on the fake Slack Web API",
  create: async () => {
    // The suite shares one fake across its cases; `dispose` closes it, not the per-test `afterEach`.
    const api = await startFakeSlack({ users: WORKSPACE_USERS });
    const context = memoryAdapterContext();
    return {
      adapter: adapterFor(api, context),
      fixture: {
        reachable: slackRecipient("ada", "U0ADA"),
        alsoReachable: slackRecipient("grace", "U0GRACE"),
        refused: slackRecipient("nobody", "U0NOBODY"),
        rateLimitNext: () => {
          api.rateLimitNext(1);
        },
        delivered: () => Promise.resolve(deliveredFrom(api)),
        logs: () => context.logger.records,
      },
      dispose: api.close,
    };
  },
});

describe("the Slack notification adapter", () => {
  it("F-057/c8: is built per delivery, registered nowhere, and sends once per idempotency key", async () => {
    const api = await start();
    const registry = createAdapterRegistry();
    const adapter = adapterFor(api);
    // A notification adapter registers nothing: core builds one for a delivery from the token.
    expect(registry.list("notification")).toEqual([]);
    expect(adapter.capabilities).toEqual({ channels: ["slack"], edits: true });
    expect(await adapter.health()).toEqual({ status: "ok" });
    const notification = sampleNotification([slackRecipient("ada", "U0ADA")]);
    const first = await adapter.send(notification);
    expect(first.ok).toBe(true);
    expect(await adapter.send(notification)).toEqual(first);
    expect(api.messages()).toHaveLength(1);
  });

  it("F-057/c5: posts to the member's U ID and returns the DM's D channel and the message's ts", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const sent = await adapter.send(sampleNotification([slackRecipient("ada", "U0ADA")]));
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.providerMessageId).toMatch(/^slack:D[A-Za-z0-9]+:\d+\.\d+$/);
    const [message] = api.messages();
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.channel.startsWith("D")).toBe(true);
    expect(sent.value.providerMessageId).toBe(messageIdOf(message));
  });

  it("F-057/c5: a member with no Slack ID is refused in words, the others still get theirs, and an unknown U ID is refused too", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const ada = slackRecipient("ada", "U0ADA");
    const grace = slackRecipient("grace", "U0GRACE");
    const nobody = slackRecipient("nobody", null);
    const sent = await adapter.send(sampleNotification([ada, nobody, grace]));
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.refused).toEqual([{ memberId: nobody.memberId, reason: "The member has no Slack account" }]);
    expect(api.messages()).toHaveLength(2);
    const ghost = slackRecipient("ghost", "U0GHOST");
    const partial = await adapter.send(sampleNotification([ghost, ada]));
    if (!partial.ok) throw new Error(partial.error.message);
    expect(partial.value.refused).toHaveLength(1);
    expect(partial.value.refused[0]?.memberId).toBe(ghost.memberId);
    expect(partial.value.refused[0]?.reason.length).toBeGreaterThan(0);
    expect(api.messages()).toHaveLength(3);
  });

  it("F-057/c5: the exported lookup finds a workspace user by address and refuses an unknown one", async () => {
    const api = await start();
    const found = await slackLookupByEmail({ apiUrl: api.apiUrl, token: api.token, email: "ada@example.com" });
    expect(found).toMatchObject({ ok: true, value: { id: "U0ADA", teamId: api.team.id, isBot: false, deleted: false } });
    const absent = await slackLookupByEmail({ apiUrl: api.apiUrl, token: api.token, email: "nobody@example.com" });
    expect(absent).toMatchObject({ ok: false, error: { code: "not-found" } });
    const checked = await slackCheck({ apiUrl: api.apiUrl, token: api.token });
    expect(checked).toMatchObject({ ok: true, value: { team: api.team.name, teamId: api.team.id, userId: api.bot.userId } });
  });

  it("F-057/c6: update edits the bot's own DM in place through chat.update", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const notification = sampleNotification([slackRecipient("ada", "U0ADA")]);
    const sent = await adapter.send(notification);
    if (!sent.ok) throw new Error(sent.error.message);
    const id = sent.value.providerMessageId;
    if (id === null) throw new Error("the send returned no message ID");
    const changed: MomentNotification = { ...notification, body: "Answered: approved once. Open it again.", state: "answered" };
    expect(await adapter.update(changed, id)).toEqual({ ok: true, value: undefined });
    expect(api.messages()).toHaveLength(1);
    const [message] = api.messages();
    expect(message?.text).toBe(changed.body);
    const [edit] = api.edits();
    expect(edit?.id).toBe(message?.id);
    expect(edit?.channel).toBe(message?.channel);
    expect(edit?.ts).toBe(message?.ts);
  });

  it("F-057/c6: a U ID is never used for an update, a gone message is not-found, and a malformed ID is invalid-input", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const notification = sampleNotification([slackRecipient("ada", "U0ADA")]);
    const sent = await adapter.send(notification);
    if (!sent.ok) throw new Error(sent.error.message);
    const changed: MomentNotification = { ...notification, body: "Answered.", state: "answered" };
    expect(await adapter.update(changed, "slack:U0ADA:123.456")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.update(changed, "not-a-message-id")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const channel = api.messages()[0]?.channel;
    expect(channel).toBeDefined();
    if (channel === undefined) return;
    expect(await adapter.update(changed, `slack:${channel}:999.999`)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(api.edits()).toHaveLength(0);
  });

  it("F-057/c7: a 429 answers rate-limited with the fake's Retry-After, and the next send goes out", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const notification = sampleNotification([slackRecipient("ada", "U0ADA")]);
    api.rateLimitNext(2);
    const limited = await adapter.send(notification);
    expect(limited).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 2000 } });
    expect(api.messages()).toHaveLength(0);
    expect((await adapter.send(notification)).ok).toBe(true);
    expect(api.messages()).toHaveLength(1);
  });

  it("F-057/c7: invalid_auth and token_expired are unauthorized", async () => {
    const api = await start();
    const wrong = new SlackNotificationAdapter({ apiUrl: api.apiUrl, token: "xoxb-wrong" }, memoryAdapterContext());
    const refused = await wrong.send(sampleNotification([slackRecipient("ada", "U0ADA")]));
    expect(refused).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(refused.ok ? "" : refused.error.message).not.toContain("xoxb-wrong");
    const adapter = adapterFor(api);
    api.expireToken();
    const expired = await adapter.send(sampleNotification([slackRecipient("ada", "U0ADA")]));
    expect(expired).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(expired.ok ? "" : expired.error.message).toContain("token_expired");
  });

  it("F-057/c7: internal_error is retryable and missing_scope is not", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    api.failNext("internal_error");
    expect(await adapter.send(sampleNotification([slackRecipient("ada", "U0ADA")]))).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    api.scopes.delete("chat:write");
    expect(await adapter.send(sampleNotification([slackRecipient("ada", "U0ADA")]))).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("F-057/c7: health says ok for the bot's token and down with Slack's code for another", async () => {
    const api = await start();
    expect(await adapterFor(api).health()).toEqual({ status: "ok" });
    const wrong = new SlackNotificationAdapter({ apiUrl: api.apiUrl, token: "xoxb-wrong" });
    const report = await wrong.health();
    expect(report.status).toBe("down");
    expect(report.status === "down" ? report.reason : "").toContain("invalid_auth");
    expect(JSON.stringify(report)).not.toContain("xoxb-wrong");
  });

  it("F-057/c4: the post's text is the notification's body, mrkdwn and both unfurl flags are false, and Slack's characters arrive literally", async () => {
    const api = await start();
    const adapter = adapterFor(api);
    const special = "*bold* <https://evil.example|a link> @channel\nsecond line";
    const notification: MomentNotification = {
      ...sampleNotification([slackRecipient("ada", "U0ADA")]),
      body: `An approval needs you: ${special}\n\nThe agent asks to run pnpm add zod. Open it: https://ostra.example/t/task-1`,
    };
    const sent = await adapter.send(notification);
    if (!sent.ok) throw new Error(sent.error.message);
    const [message] = api.messages();
    expect(message?.text).toBe(notification.body);
    expect(message?.mrkdwn).toBe(false);
    expect(message?.unfurlLinks).toBe(false);
    expect(message?.unfurlMedia).toBe(false);
  });

  it("F-057/c2: no token, code or state reaches a log record, an error message or a SendResult", async () => {
    const api = await start();
    const context = memoryAdapterContext();
    const adapter = adapterFor(api, context);
    const notification = sampleNotification([slackRecipient("ada", "U0ADA")]);
    const returned: unknown[] = [];
    returned.push(await adapter.send(notification));
    returned.push(await adapter.send(notification));
    returned.push(await adapter.health());
    api.failNext("invalid_auth");
    returned.push(await adapter.send({ ...notification, idempotencyKey: `${notification.idempotencyKey}:again` }));
    returned.push(await adapter.update(notification, "not-a-message-id"));
    const code = api.issueCode();
    returned.push(
      await slackExchangeCode({
        apiUrl: api.apiUrl,
        clientId: api.clientId,
        clientSecret: "not-the-client-secret",
        code,
      }),
    );
    const state = "state-for-the-consent-page";
    const authorize = slackAuthorizeUrl({ apiUrl: api.apiUrl, clientId: api.clientId, state, redirectUri: api.redirectUrl });
    expect(authorize).toContain(state);
    const surface = JSON.stringify({ returned, logs: context.logger.records });
    for (const secret of [api.token, code, api.clientSecret, "not-the-client-secret", state]) {
      expect(surface).not.toContain(secret);
    }
    expect(context.logger.records.length).toBeGreaterThan(0);
  });

  it("F-057/c2: the exported OAuth calls exchange a code and rotate a refresh token, and a reused one is refused in words", async () => {
    const api = await start();
    api.rotate(true);
    const code = api.issueCode();
    const install = await slackExchangeCode({
      apiUrl: api.apiUrl,
      clientId: api.clientId,
      clientSecret: api.clientSecret,
      code,
      redirectUri: api.redirectUrl,
    });
    if (!install.ok) throw new Error(install.error.message);
    expect(install.value.refreshToken).not.toBeNull();
    expect(install.value.botUserId).toBe(api.bot.userId);
    expect(install.value.team).toEqual(api.team);
    const refreshToken = install.value.refreshToken;
    if (refreshToken === null) throw new Error("the exchange returned no refresh token");
    const refreshed = await slackRefresh({
      apiUrl: api.apiUrl,
      clientId: api.clientId,
      clientSecret: api.clientSecret,
      refreshToken,
    });
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(refreshed.value.accessToken).not.toBe(install.value.accessToken);
    expect(refreshed.value.refreshToken).not.toBe(refreshToken);
    const reused = await slackRefresh({
      apiUrl: api.apiUrl,
      clientId: api.clientId,
      clientSecret: api.clientSecret,
      refreshToken,
    });
    expect(reused).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    expect(reused.ok ? "" : reused.error.message).toContain("invalid_refresh_token");
    // A successful exchange legitimately answers tokens; what must stay clean is the refusal.
    const surface = JSON.stringify({ reused, authorize: slackAuthorizeUrl({ apiUrl: api.apiUrl, clientId: api.clientId }) });
    for (const secret of [install.value.accessToken, refreshToken, api.clientSecret, code]) {
      expect(surface).not.toContain(secret);
    }
  });
});
