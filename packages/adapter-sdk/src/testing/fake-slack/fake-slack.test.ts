import { afterEach, describe, expect, it } from "vitest";

import { startFakeSlack } from "./fake-slack.ts";
import type { FakeSlack, FakeSlackOptions } from "./fake-slack.ts";

// The fake Slack Web API's own cases (F-057/c5, c6 and c7; ticket 02): auth, a lookup by address,
// a DM opened and reused, an edit in place, rate limits, an expired token and rotating refresh
// tokens, and the authorize page. Everything goes over loopback through `fetch`; each fake opens
// one port and closes it.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const slack = async (options: FakeSlackOptions = {}): Promise<FakeSlack> => {
  const fake = await startFakeSlack(options);
  closers.push(fake.close);
  return fake;
};

const field = (body: unknown, name: string): unknown => (typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined);

const post = (fake: FakeSlack, method: string, body: Readonly<Record<string, unknown>>, token = fake.token) =>
  fetch(`${fake.apiUrl}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (fake: FakeSlack, method: string, query: Readonly<Record<string, string>>, token = fake.token) =>
  fetch(`${fake.apiUrl}/${method}?${new URLSearchParams(query).toString()}`, { headers: { authorization: `Bearer ${token}` } });

const oauth = (fake: FakeSlack, fields: Readonly<Record<string, string>>) =>
  fetch(`${fake.apiUrl}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const exchange = async (fake: FakeSlack, code: string): Promise<unknown> => (await oauth(fake, { client_id: fake.clientId, client_secret: fake.clientSecret, code, redirect_uri: fake.redirectUrl })).json();

describe("the fake Slack Web API", () => {
  it("F-057/c6: a post answers its D channel and ts, and a second post to the same user reuses it", async () => {
    const fake = await slack();
    const sam = fake.addUser({ email: "sam@acme.test", name: "sam" });

    const first: unknown = await (await post(fake, "chat.postMessage", { channel: sam.id, text: "one", mrkdwn: false, unfurl_links: false, unfurl_media: false })).json();
    expect(first).toMatchObject({ ok: true });
    const channel = field(first, "channel");
    const ts = field(first, "ts");
    expect(channel).toEqual(expect.stringMatching(/^D/));
    expect(ts).toEqual(expect.stringMatching(/^\d+\.\d{6}$/));

    const second: unknown = await (await post(fake, "chat.postMessage", { channel: sam.id, text: "two" })).json();
    expect(field(second, "channel")).toBe(channel);
    expect(field(second, "ts")).not.toBe(ts);
    expect(fake.messages()).toMatchObject([
      { channel, ts, text: "one", mrkdwn: false, unfurlLinks: false, unfurlMedia: false, id: `${String(channel)}:${String(ts)}` },
      { channel, text: "two", mrkdwn: true },
    ]);
    expect(fake.messages().map((message) => message.tokenDigest)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(fake.calls().filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    expect(fake.calls().every((call) => call.tokenDigest !== fake.token)).toBe(true);

    const byDm: unknown = await (await post(fake, "chat.postMessage", { channel, text: "three" })).json();
    expect(field(byDm, "channel")).toBe(channel);
  });

  it("F-057/c6: chat.update edits in place, refuses a U ID for a DM and another bot's message", async () => {
    const fake = await slack();
    const sam = fake.addUser({ email: "sam@acme.test" });
    const posted: unknown = await (await post(fake, "chat.postMessage", { channel: sam.id, text: "before" })).json();
    const channel = field(posted, "channel");
    const ts = field(posted, "ts");

    const edited: unknown = await (await post(fake, "chat.update", { channel, ts, text: "after" })).json();
    expect(edited).toMatchObject({ ok: true, channel, ts });
    expect(fake.messages().map((message) => message.text)).toEqual(["after"]);
    expect(fake.edits()).toMatchObject([{ id: `${String(channel)}:${String(ts)}`, text: "after" }]);

    const userAsChannel: unknown = await (await post(fake, "chat.update", { channel: sam.id, ts, text: "after" })).json();
    expect(userAsChannel).toMatchObject({ ok: false, error: "channel_not_found" });

    const other = fake.seedOtherBotMessage({ channel: String(channel), text: "another bot's" });
    const foreign: unknown = await (await post(fake, "chat.update", { channel, ts: other.ts, text: "mine now" })).json();
    expect(foreign).toMatchObject({ ok: false, error: "cant_update_message" });

    const gone: unknown = await (await post(fake, "chat.update", { channel, ts: "1.000001", text: "gone" })).json();
    expect(gone).toMatchObject({ ok: false, error: "message_not_found" });
  });

  it("F-057/c5: a known address resolves; unknown, deactivated, missing scope and custom bot refuse", async () => {
    const fake = await slack();
    const sam = fake.addUser({ email: "sam@acme.test", name: "sam" });

    const known: unknown = await (await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).json();
    expect(known).toMatchObject({ ok: true, user: { id: sam.id, team_id: fake.team.id, name: "sam", deleted: false, is_bot: false } });

    const unknown: unknown = await (await get(fake, "users.lookupByEmail", { email: "nobody@acme.test" })).json();
    expect(unknown).toMatchObject({ ok: false, error: "users_not_found" });

    fake.deactivateUser("sam@acme.test");
    const deactivated: unknown = await (await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).json();
    expect(deactivated).toMatchObject({ ok: false, error: "account_inactive" });

    fake.removeUser("sam@acme.test");
    const removed: unknown = await (await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).json();
    expect(removed).toMatchObject({ ok: false, error: "users_not_found" });

    fake.scopes.delete("users:read.email");
    const unscoped: unknown = await (await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).json();
    expect(unscoped).toMatchObject({ ok: false, error: "missing_scope" });

    fake.scopes.add("users:read.email");
    fake.setCustomBotUser(true);
    const custom: unknown = await (await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).json();
    expect(custom).toMatchObject({ ok: false, error: "not_allowed_token_type", warning: "custom bot users cannot use this method" });
  });

  it("F-057/c7: a 429 answers with the Retry-After given, and the next call succeeds", async () => {
    const fake = await slack();
    const sam = fake.addUser({ email: "sam@acme.test" });

    fake.rateLimitNext(3);
    const limitedLookup = await get(fake, "users.lookupByEmail", { email: "sam@acme.test" });
    expect(limitedLookup.status).toBe(429);
    expect(limitedLookup.headers.get("retry-after")).toBe("3");
    expect(await limitedLookup.json()).toMatchObject({ ok: false, error: "ratelimited" });
    expect((await get(fake, "users.lookupByEmail", { email: "sam@acme.test" })).status).toBe(200);

    fake.rateLimitNext(5);
    const limitedPost = await post(fake, "chat.postMessage", { channel: sam.id, text: "later" });
    expect(limitedPost.status).toBe(429);
    expect(limitedPost.headers.get("retry-after")).toBe("5");
    expect((await post(fake, "chat.postMessage", { channel: sam.id, text: "now" })).status).toBe(200);
    expect(fake.messages().map((message) => message.text)).toEqual(["now"]);
  });

  it("F-057/c7: expireToken answers token_expired; a refresh answers a new token and refresh token, and refuses the old one", async () => {
    const fake = await slack();
    fake.rotate(true);
    const code = fake.issueCode();
    const first: unknown = await exchange(fake, code);
    expect(first).toMatchObject({ ok: true, access_token: fake.token, token_type: "bot", app_id: fake.appId, bot_user_id: fake.bot.userId, expires_in: 43_200, scope: "chat:write,users:read.email", team: { name: fake.team.name, id: fake.team.id } });
    const refreshToken = field(first, "refresh_token");
    expect(refreshToken).toEqual(expect.stringMatching(/^xoxe-1-fake-/));

    fake.expireToken();
    const expired: unknown = await (await post(fake, "auth.test", {})).json();
    expect(expired).toMatchObject({ ok: false, error: "token_expired" });

    const refreshed: unknown = await (await oauth(fake, { client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: "refresh_token", refresh_token: String(refreshToken) })).json();
    expect(refreshed).toMatchObject({ ok: true, expires_in: 43_200 });
    const accessToken = field(refreshed, "access_token");
    const nextRefresh = field(refreshed, "refresh_token");
    expect(accessToken).not.toBe(fake.token);
    expect(nextRefresh).not.toBe(refreshToken);

    const fresh: unknown = await (await post(fake, "auth.test", {}, String(accessToken))).json();
    expect(fresh).toMatchObject({ ok: true, team: fake.team.name, team_id: fake.team.id, user: fake.bot.name, user_id: fake.bot.userId, bot_id: fake.bot.id });

    const reused: unknown = await (await oauth(fake, { client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: "refresh_token", refresh_token: String(refreshToken) })).json();
    expect(reused).toMatchObject({ ok: false, error: "invalid_refresh_token" });
  });

  it("auth.test answers the bot, refuses a bad token and an inactive workspace, and oauth refuses bad inputs", async () => {
    const fake = await slack();
    const good: unknown = await (await post(fake, "auth.test", {})).json();
    expect(good).toMatchObject({ ok: true, team: fake.team.name, team_id: fake.team.id, user: fake.bot.name, user_id: fake.bot.userId, bot_id: fake.bot.id });

    const bad: unknown = await (await post(fake, "auth.test", {}, "xoxb-wrong")).json();
    expect(bad).toMatchObject({ ok: false, error: "invalid_auth" });

    fake.failNext("internal_error");
    const failed: unknown = await (await post(fake, "auth.test", {})).json();
    expect(failed).toMatchObject({ ok: false, error: "internal_error" });
    const recovered: unknown = await (await post(fake, "auth.test", {})).json();
    expect(recovered).toMatchObject({ ok: true });

    fake.deactivateWorkspace();
    const inactive: unknown = await (await post(fake, "auth.test", {})).json();
    expect(inactive).toMatchObject({ ok: false, error: "account_inactive" });

    const other = await slack({ redirectUrl: "https://example.test/api/slack/callback" });
    const badSecret: unknown = await (await oauth(other, { client_id: other.clientId, client_secret: "wrong", code: other.issueCode() })).json();
    expect(badSecret).toMatchObject({ ok: false, error: "bad_client_secret" });
    const badCode: unknown = await (await oauth(other, { client_id: other.clientId, client_secret: other.clientSecret, code: "nope" })).json();
    expect(badCode).toMatchObject({ ok: false, error: "invalid_code" });
    const badRedirect: unknown = await (await oauth(other, { client_id: other.clientId, client_secret: other.clientSecret, code: other.issueCode(), redirect_uri: "https://wrong.test/callback" })).json();
    expect(badRedirect).toMatchObject({ ok: false, error: "bad_redirect_uri" });
  });

  it("chat.postMessage refuses an unknown user and a missing scope, and cuts text past 40,000", async () => {
    const fake = await slack();
    const unknown: unknown = await (await post(fake, "chat.postMessage", { channel: "U0UNKNOWN", text: "hello" })).json();
    expect(unknown).toMatchObject({ ok: false, error: "channel_not_found" });

    fake.scopes.delete("chat:write");
    const sam = fake.addUser({ email: "sam@acme.test" });
    const unscoped: unknown = await (await post(fake, "chat.postMessage", { channel: sam.id, text: "hello" })).json();
    expect(unscoped).toMatchObject({ ok: false, error: "missing_scope" });

    fake.scopes.add("chat:write");
    const tooLong: unknown = await (await post(fake, "chat.postMessage", { channel: sam.id, text: "x".repeat(40_001) })).json();
    expect(tooLong).toMatchObject({ ok: false, error: "msg_too_long", warning: "message_truncated" });
    expect(fake.messages()).toEqual([]);
  });

  it("the authorize page checks the client ID, carries the state, redirects with a code, or denies", async () => {
    const fake = await slack({ redirectUrl: "https://panel.test/api/slack/callback" });

    const wrong = await fetch(`${fake.authorizeUrl}?client_id=other&state=abc`);
    expect(wrong.status).toBe(400);

    const consent = await fetch(`${fake.authorizeUrl}?client_id=${fake.clientId}&state=abc&redirect_uri=${encodeURIComponent(fake.redirectUrl)}`, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(fake.redirectUrl);
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code")).toEqual(expect.stringMatching(/^code-/));

    const exchanged: unknown = await exchange(fake, location.searchParams.get("code") ?? "");
    expect(exchanged).toMatchObject({ ok: true, token_type: "bot" });
    expect(field(exchanged, "refresh_token")).toBeUndefined();

    fake.denyNextAuthorize();
    const denied = await fetch(`${fake.authorizeUrl}?client_id=${fake.clientId}&state=def`, { redirect: "manual" });
    const deniedTarget = new URL(denied.headers.get("location") ?? "");
    expect(deniedTarget.searchParams.get("error")).toBe("access_denied");
    expect(deniedTarget.searchParams.get("state")).toBe("def");
  });

  it("opens one loopback port and closes it", async () => {
    const fake = await startFakeSlack();
    expect(new URL(fake.url).hostname).toBe("127.0.0.1");
    expect(fake.apiUrl).toBe(`${fake.url}/api`);
    await fake.close();
    await expect(fetch(`${fake.apiUrl}/auth.test`, { method: "POST" })).rejects.toThrow();
  });
});
