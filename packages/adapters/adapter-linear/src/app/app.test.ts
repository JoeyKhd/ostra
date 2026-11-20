import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";

import { hmacSha256Hex } from "@ostra/adapter-sdk";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { linearAppEndpoints } from "./endpoints.ts";
import { linearAppManifest, linearAppName, OSTRA_RESOURCE_TYPES, parseManifestLink } from "./manifest.ts";
import { authorizeUrl, checkAppToken, clientCredentialsToken, createPkce, exchangeCode, LINEAR_APP_SCOPES, randomOAuthState, refreshToken, revokeToken } from "./oauth.ts";
import { checkPublicUrl } from "./public-url.ts";
import { linearWebhookHint, parseLinearWebhook, verifyLinearWebhook } from "./webhooks.ts";

// Ticket 08: the app's manifest link, OAuth with `actor=app`, and webhooks, against the fake
// Linear server (spec section 8), which signs deliveries and rotates refresh tokens as Linear does.

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${String(address.port)}`;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });

describe("the address pre-check", () => {
  it.each([
    ["http://ostra.example.com/webhooks/linear/1", "not-https"],
    ["ftp://ostra.example.com/x", "invalid-url"],
    ["not a url", "invalid-url"],
    ["https://localhost/webhooks", "loopback"],
    ["https://app.localhost/webhooks", "loopback"],
    ["https://127.0.0.1/webhooks", "loopback"],
    ["https://[::1]/webhooks", "loopback"],
    ["https://10.1.2.3/webhooks", "private-network"],
    ["https://172.20.0.1/webhooks", "private-network"],
    ["https://192.168.1.10/webhooks", "private-network"],
    ["https://169.254.169.254/webhooks", "private-network"],
    ["https://100.64.0.1/webhooks", "private-network"],
    ["https://[fd00::1]/webhooks", "private-network"],
    ["https://[fe80::1]/webhooks", "private-network"],
    ["https://[::ffff:10.0.0.1]/webhooks", "private-network"],
    ["https://ostra/webhooks", "single-label-host"],
    ["https://ostra.local/webhooks", "local-suffix"],
    ["https://ostra.corp.internal/webhooks", "local-suffix"],
    ["https://ostra.lan/webhooks", "local-suffix"],
    ["https://ostra.home.arpa/webhooks", "local-suffix"],
    ["https://linear.app/webhooks", "linear-host"],
    ["https://hooks.linear.app/webhooks", "linear-host"],
  ])("refuses %s as %s, and says why", (url, problem) => {
    const check = checkPublicUrl(url);
    expect(check).toMatchObject({ ok: false, problem });
    expect(check.ok ? "" : check.reason.length).toBeGreaterThan(10);
  });

  it.each(["https://quiet-river-1234.trycloudflare.com/webhooks/linear/1", "https://8.8.8.8/x", "https://[2606:4700::1111]/x", "https://ostra.acme.com:8443/x"])(
    "takes the public address %s",
    (url) => {
      expect(checkPublicUrl(url)).toMatchObject({ ok: true });
    },
  );
});

describe("the manifest link", () => {
  const callbackUrl = "https://ostra.acme.com/oauth/linear/callback";
  const webhookUrl = "https://ostra.acme.com/webhooks/linear/0196f1a0-0000-7000-8000-000000000001";

  it("opens Linear's new-app form, private, with the callback, the code grant only and the webhook's types", () => {
    const link = linearAppManifest({ name: "ostra (ostra.acme.com)", callbackUrl, webhookUrl });
    if (!link.ok) throw new Error(link.problems.join("; "));
    expect(link.url.startsWith("https://linear.app/settings/api/applications/new?manifest=")).toBe(true);
    expect(link.webhook).toEqual({ state: "included", url: webhookUrl });
    const read = parseManifestLink(link.url);
    if (!read.ok) throw new Error("the link doesn't read back");
    expect(read.manifest).toMatchObject({
      distribution: "private",
      oauth: { client_name: "ostra (ostra.acme.com)", redirect_uris: [callbackUrl], grant_types: ["authorization_code"], client_uri: "https://ostra.acme.com" },
      webhook: { enabled: true, url: webhookUrl },
    });
    expect([...(read.manifest.webhook?.resourceTypes ?? [])].sort()).toEqual(
      ["AgentSessionEvent", "Attachment", "Comment", "Issue", "IssueLabel", "OAuthAuthorization"],
    );
    expect(OSTRA_RESOURCE_TYPES).toHaveLength(6);
  });

  it("falls back to the name ostra when Linear's rules refuse the name", () => {
    expect(linearAppName("ostra (linear.acme.com)")).toBe("ostra");
    expect(linearAppName("x")).toBe("ostra");
    expect(linearAppName("ostra (https://ostra.acme.com)")).toBe("ostra");
    const link = linearAppManifest({ name: "ostra (linear-tools.acme.com)", callbackUrl, webhookUrl });
    expect(link.ok && link.manifest.oauth.client_name).toBe("ostra");
  });

  it("leaves the webhook out when there's none, or its address fails the pre-check, and says why", () => {
    const none = linearAppManifest({ name: "ostra", callbackUrl: "http://localhost:3000/oauth/linear/callback", webhookUrl: null });
    expect(none).toMatchObject({ ok: true, webhook: { state: "none" } });
    expect(none.ok && none.manifest.webhook).toBeUndefined();
    const local = linearAppManifest({ name: "ostra", callbackUrl: "http://localhost:3000/oauth/linear/callback", webhookUrl: "http://localhost:8787/webhooks/linear/1" });
    expect(local).toMatchObject({ ok: true, webhook: { state: "refused", problem: "not-https" } });
    expect(local.ok && local.manifest.webhook).toBeUndefined();
  });

  it("refuses a callback that isn't a URL", () => {
    expect(linearAppManifest({ name: "ostra", callbackUrl: "nope", webhookUrl: null })).toMatchObject({ ok: false });
  });

  it("opens the new-app form it's given, a fake Linear's, with the same manifest", () => {
    const newAppUrl = "http://127.0.0.1:4100/settings/api/applications/new";
    const link = linearAppManifest({ name: "ostra", callbackUrl, webhookUrl: null, newAppUrl });
    if (!link.ok) throw new Error(link.problems.join("; "));
    expect(link.url.startsWith(`${newAppUrl}?manifest=`)).toBe(true);
    expect(JSON.parse(new URL(link.url).searchParams.get("manifest") ?? "")).toEqual(link.manifest);
  });
});

describe("the app flow's endpoints", () => {
  it("are Linear's own for Linear's API, and the same paths on a fake Linear's origin for another address", async () => {
    expect(linearAppEndpoints()).toEqual({
      graphqlUrl: "https://api.linear.app/graphql",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      revokeUrl: "https://api.linear.app/oauth/revoke",
      newAppUrl: "https://linear.app/settings/api/applications/new",
    });
    const fake = await createFakeLinear();
    try {
      expect(linearAppEndpoints(fake.apiUrl)).toEqual({ graphqlUrl: fake.apiUrl, authorizeUrl: fake.authorizeUrl, tokenUrl: fake.tokenUrl, revokeUrl: fake.revokeUrl, newAppUrl: fake.newAppUrl });
    } finally {
      await fake.close();
    }
  });
});

describe("OAuth with actor=app, on the fake Linear", () => {
  let fake: FakeLinear;
  let app: ReturnType<FakeLinear["createApp"]>;
  const redirectUri = "https://ostra.example.test/oauth/linear/callback";

  beforeAll(async () => {
    fake = await createFakeLinear();
    app = fake.createApp({ name: "ostra", redirectUris: [redirectUri], webhookUrl: null });
  });
  afterAll(async () => {
    await fake.close();
  });

  /** The admin's browser: opens the authorize URL, Linear consents at once, and the callback gets a code. */
  const consent = async (challenge: string, state: string): Promise<{ readonly code: string; readonly state: string | null }> => {
    const url = authorizeUrl({ authorizeUrl: fake.authorizeUrl, clientId: app.clientId, redirectUri, scopes: LINEAR_APP_SCOPES, state, codeChallenge: challenge });
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get("location") ?? "");
    return { code: back.searchParams.get("code") ?? "", state: back.searchParams.get("state") };
  };

  it("builds the authorize URL with actor=app, the scopes and S256 PKCE", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(authorizeUrl({ clientId: "client", redirectUri, scopes: LINEAR_APP_SCOPES, state: "s", codeChallenge: pkce.challenge }));
    expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "read,write,issues:create,comments:create",
      actor: "app",
      state: "s",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    expect(randomOAuthState()).not.toBe(randomOAuthState());
  });

  it("authorizes, exchanges the code, and confirms the token is the app's own user", async () => {
    const pkce = createPkce();
    const state = randomOAuthState();
    const back = await consent(pkce.challenge, state);
    expect(back.state).toBe(state);
    const tokens = await exchangeCode({ tokenUrl: fake.tokenUrl, clock: fake.clock, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri, code: back.code, codeVerifier: pkce.verifier });
    if (!tokens.ok) throw new Error(tokens.error.message);
    expect(tokens.value.expiresAt).toBe(fake.clock.now() + 86_399_000);
    expect(tokens.value.scopes).toEqual([...LINEAR_APP_SCOPES]);
    const identity = await checkAppToken({ apiUrl: fake.apiUrl, accessToken: tokens.value.accessToken });
    expect(identity).toEqual({
      ok: true,
      value: { appUserId: fake.appUser()?.id, appUserName: "ostra", workspaceId: fake.organization.id, workspaceKey: "ostra-test", workspaceName: "ostra-test" },
    });
    // A code works once.
    expect(
      await exchangeCode({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri, code: back.code, codeVerifier: pkce.verifier }),
    ).toMatchObject({ ok: false, error: { code: "invalid-grant" } });
  });

  it("refuses a code without its verifier, and a wrong secret", async () => {
    const pkce = createPkce();
    const back = await consent(pkce.challenge, "s");
    expect(
      await exchangeCode({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri, code: back.code, codeVerifier: createPkce().verifier }),
    ).toMatchObject({ ok: false, error: { code: "invalid-grant" } });
    expect(
      await exchangeCode({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: "wrong", redirectUri, code: back.code, codeVerifier: pkce.verifier }),
    ).toMatchObject({ ok: false, error: { code: "invalid-client" } });
  });

  it("refuses a token that isn't the app's, or isn't the one the connection saved", async () => {
    const person = fake.mintToken("person");
    expect(await checkAppToken({ apiUrl: fake.apiUrl, accessToken: person.accessToken })).toMatchObject({ ok: false, error: { code: "not-an-app-user" } });
    const appToken = fake.mintToken("app");
    expect(
      await checkAppToken({ apiUrl: fake.apiUrl, accessToken: appToken.accessToken, expected: { appUserId: "someone-else", workspaceId: fake.organization.id } }),
    ).toMatchObject({ ok: false, error: { code: "different-app-user" } });
    expect(await checkAppToken({ apiUrl: fake.apiUrl, accessToken: "lin_oauth_nope" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("refreshes, takes the rotated refresh token, and gets the same pair again within 30 minutes", async () => {
    const first = fake.mintToken("app");
    const options = { tokenUrl: fake.tokenUrl, clock: fake.clock, clientId: app.clientId, clientSecret: app.clientSecret };
    const refreshed = await refreshToken({ ...options, refreshToken: first.refreshToken });
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(refreshed.value.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.value.accessToken).not.toBe(first.accessToken);
    // The answer was lost, say: the old refresh token, asked again, gives the same pair.
    fake.clock.advance(29 * 60_000);
    expect(await refreshToken({ ...options, refreshToken: first.refreshToken })).toMatchObject({
      ok: true,
      value: { accessToken: refreshed.value.accessToken, refreshToken: refreshed.value.refreshToken },
    });
    fake.clock.advance(2 * 60_000);
    expect(await refreshToken({ ...options, refreshToken: first.refreshToken })).toMatchObject({ ok: false, error: { code: "invalid-grant" } });
    // The rotated one works, and its token is the app's.
    const next = await refreshToken({ ...options, refreshToken: refreshed.value.refreshToken });
    if (!next.ok) throw new Error(next.error.message);
    expect(await checkAppToken({ apiUrl: fake.apiUrl, accessToken: next.value.accessToken })).toMatchObject({ ok: true });
  });

  it("asks again with the old refresh token when Linear's answer is lost", async () => {
    const first = fake.mintToken("app");
    let seen = 0;
    const proxy = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen += 1;
        const attempt = seen;
        void fetch(fake.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: Buffer.concat(chunks) }).then(async (answer) => {
          const text = await answer.text();
          if (attempt === 1) {
            // Linear rotated the token, and the answer never arrived.
            request.socket.destroy();
            return;
          }
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(text);
        });
      });
    });
    const proxyUrl = await listen(proxy);
    const options = { clock: fake.clock, clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: first.refreshToken };
    const refreshed = await refreshToken({ ...options, tokenUrl: `${proxyUrl}/oauth/token`, retryDelaysMs: [5] });
    await close(proxy);
    expect(seen).toBe(2);
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    // The pair the lost answer held, which Linear repeats for the old token.
    const direct = await refreshToken({ ...options, tokenUrl: fake.tokenUrl });
    expect(direct).toMatchObject({ ok: true, value: { accessToken: refreshed.value.accessToken, refreshToken: refreshed.value.refreshToken } });
  });

  it("gives up after the retries, and says Linear was unavailable", async () => {
    expect(
      await refreshToken({ tokenUrl: "http://127.0.0.1:1/oauth/token", clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: "lin_refresh_x", retryDelaysMs: [1, 1] }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("answers grant-disabled for client credentials while the app's setting is off, and a 30-day app token once it's on", async () => {
    const input = { tokenUrl: fake.tokenUrl, clock: fake.clock, clientId: app.clientId, clientSecret: app.clientSecret, scopes: LINEAR_APP_SCOPES };
    expect(await clientCredentialsToken(input)).toMatchObject({ ok: false, error: { code: "grant-disabled" } });
    fake.setClientCredentialsEnabled(true);
    const token = await clientCredentialsToken(input);
    fake.setClientCredentialsEnabled(false);
    if (!token.ok) throw new Error(token.error.message);
    expect(token.value.expiresAt).toBe(fake.clock.now() + 30 * 86_400_000);
    expect(token.value).not.toHaveProperty("refreshToken");
    expect(await checkAppToken({ apiUrl: fake.apiUrl, accessToken: token.value.accessToken })).toMatchObject({ ok: true });
  });

  it("revokes a token", async () => {
    const token = fake.mintToken("app");
    expect(await revokeToken({ revokeUrl: fake.revokeUrl, token: token.accessToken })).toEqual({ ok: true, value: undefined });
    expect(await checkAppToken({ apiUrl: fake.apiUrl, accessToken: token.accessToken })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("keeps the secret and every token out of what it answers", async () => {
    const results = [
      await exchangeCode({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri, code: "nope", codeVerifier: "v" }),
      await refreshToken({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: "lin_refresh_secretvalue", retryDelaysMs: [] }),
      await clientCredentialsToken({ tokenUrl: fake.tokenUrl, clientId: app.clientId, clientSecret: app.clientSecret, scopes: ["read"] }),
      await checkAppToken({ apiUrl: fake.apiUrl, accessToken: "lin_oauth_secretvalue" }),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(app.clientSecret);
    expect(text).not.toContain("secretvalue");
    expect(text).not.toContain("Client does not support");
  });
});

describe("webhooks, from the fake Linear", () => {
  let fake: FakeLinear;
  let receiver: Server;
  let app: ReturnType<FakeLinear["createApp"]>;
  const received: { readonly rawBody: Uint8Array; readonly headers: IncomingHttpHeaders }[] = [];

  const lowerHeaders = (headers: IncomingHttpHeaders): Record<string, string | undefined> =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(",") : value]));

  beforeAll(async () => {
    fake = await createFakeLinear();
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ rawBody: new Uint8Array(Buffer.concat(chunks)), headers: request.headers });
        response.writeHead(200).end();
      });
    });
    const url = await listen(receiver);
    app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example.test/cb"], webhookUrl: `${url}/webhooks/linear/1` });
  });
  afterEach(() => {
    received.length = 0;
  });
  afterAll(async () => {
    await fake.close();
    await close(receiver);
  });

  const lastDelivery = () => {
    const delivery = received.at(-1);
    if (delivery === undefined) throw new Error("nothing was delivered");
    return { rawBody: delivery.rawBody, headers: lowerHeaders(delivery.headers), secret: app.webhookSecret, now: fake.clock.now() + 1500 };
  };

  it("verifies a real delivery and reads it into a hint: the issue, its team, the delivery ID", async () => {
    const issue = await fake.createIssue({ title: "Hello" });
    const request = lastDelivery();
    const verified = verifyLinearWebhook(request);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.deliveryId).toBe(request.headers["linear-delivery"]);
    expect(verified.sentAt).toBe(fake.clock.now());
    expect(verified.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseLinearWebhook(verified.body)).toMatchObject({
      ok: true,
      value: { kind: "change", subject: "ticket", action: "create", ticketExternalId: issue.id, ticketKey: issue.identifier, boardExternalId: fake.team.id, actorId: fake.admin.id, workspaceId: fake.organization.id },
    });
  });

  it("reads a comment's ticket, and marks the app's own comment as its echo", async () => {
    const issue = await fake.createIssue({ title: "Echo" });
    await fake.addComment(issue.id, "a person's comment");
    const verified = verifyLinearWebhook(lastDelivery());
    if (!verified.ok) throw new Error(verified.reason);
    expect(linearWebhookHint({ body: verified.body, ownUserId: fake.admin.id })).toMatchObject({
      ok: true,
      value: { event: "Comment", subject: "comment", ticketExternalId: issue.id, ticketKey: issue.identifier, boardExternalId: fake.team.id, byOwnUser: true },
    });
    expect(linearWebhookHint({ body: verified.body, ownUserId: "app-user" })).toMatchObject({ ok: true, value: { byOwnUser: false } });
    expect(linearWebhookHint({ body: verified.body, ownUserId: null })).toMatchObject({ ok: true, value: { byOwnUser: false } });
  });

  it("refuses a signature off by one byte, a wrong secret, no signature, and a stale timestamp", async () => {
    await fake.createIssue({ title: "Tamper" });
    const request = lastDelivery();
    const signature = request.headers["linear-signature"] ?? "";
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(verifyLinearWebhook({ ...request, headers: { ...request.headers, "linear-signature": flipped } })).toEqual({ ok: false, reason: "bad-signature" });
    const body = new Uint8Array(request.rawBody);
    body[10] = (body[10] ?? 0) ^ 1;
    expect(verifyLinearWebhook({ ...request, rawBody: body })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyLinearWebhook({ ...request, secret: `${app.webhookSecret}x` })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyLinearWebhook({ ...request, headers: { ...request.headers, "linear-signature": undefined } })).toEqual({ ok: false, reason: "missing-signature" });
    expect(verifyLinearWebhook({ ...request, now: fake.clock.now() + 61_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyLinearWebhook({ ...request, now: fake.clock.now() - 61_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyLinearWebhook({ ...request, headers: { ...request.headers, "linear-delivery": undefined } })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a body re-serialized after parsing: the signature covers the bytes as sent", async () => {
    await fake.createIssue({ title: "Bytes, café" });
    const request = lastDelivery();
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(request.rawBody)), null, 2));
    expect(verifyLinearWebhook({ ...request, rawBody: reserialized })).toEqual({ ok: false, reason: "bad-signature" });
    // Bytes Linear might send that a parse and a stringify change: an escaped character.
    const sent = new TextEncoder().encode(`{"type":"Issue","action":"update","data":{"title":"caf\\u00e9"},"webhookTimestamp":${String(fake.clock.now())}}`);
    const headers = { "linear-signature": hmacSha256Hex(app.webhookSecret, sent), "linear-delivery": "d-1" };
    expect(verifyLinearWebhook({ rawBody: sent, headers, secret: app.webhookSecret, now: fake.clock.now() })).toMatchObject({ ok: true });
    const again = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(sent))));
    expect(verifyLinearWebhook({ rawBody: again, headers, secret: app.webhookSecret, now: fake.clock.now() })).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a signed body that isn't JSON", () => {
    const sent = new TextEncoder().encode("not json");
    expect(verifyLinearWebhook({ rawBody: sent, headers: { "linear-signature": hmacSha256Hex("s", sent), "linear-delivery": "d" }, secret: "s", now: 0 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("the webhook parse", () => {
  it("ignores a type ostra doesn't act on, never an error", () => {
    expect(parseLinearWebhook({ type: "Project", action: "update", data: { id: "p" } })).toEqual({ ok: true, value: { kind: "ignored", type: "Project", action: "update" } });
    expect(parseLinearWebhook({ type: "AgentSessionEvent", action: "created" })).toMatchObject({ ok: true, value: { kind: "ignored" } });
    expect(linearWebhookHint({ body: { type: "Cycle" }, ownUserId: null })).toMatchObject({ ok: true, value: { subject: "other", ticketExternalId: null } });
  });

  it("tolerates extra fields, a numeric createdAt, and data it can't read", () => {
    expect(
      parseLinearWebhook({
        type: "Attachment",
        action: "create",
        createdAt: 1_700_000_000_000,
        brandNew: { nested: true },
        data: { id: "att-1", issueId: "issue-1", url: "https://x.test", somethingElse: 3 },
      }),
    ).toMatchObject({ ok: true, value: { kind: "change", subject: "attachment", ticketExternalId: "issue-1", createdAt: 1_700_000_000_000 } });
    expect(parseLinearWebhook({ type: "Issue", action: "remove", createdAt: "2026-11-19T10:00:00.000Z", data: "weird" })).toMatchObject({
      ok: true,
      value: { kind: "change", subject: "ticket", action: "remove", ticketExternalId: null, createdAt: Date.parse("2026-11-19T10:00:00.000Z") },
    });
    expect(parseLinearWebhook({ type: "IssueLabel", action: "update", data: { id: "label-1", teamId: "team-1" } })).toMatchObject({
      ok: true,
      value: { subject: "label", ticketExternalId: null },
    });
  });

  it("reads a comment's author from data when there's no actor", () => {
    expect(linearWebhookHint({ body: { type: "Comment", action: "create", data: { id: "c", userId: "app-user", issueId: "i" } }, ownUserId: "app-user" })).toMatchObject({
      ok: true,
      value: { byOwnUser: true, ticketExternalId: "i" },
    });
  });

  it("reads the app's revocation", () => {
    expect(parseLinearWebhook({ type: "OAuthApp", action: "revoked", organizationId: "org-1" })).toMatchObject({ ok: true, value: { kind: "app-revoked", workspaceId: "org-1" } });
  });

  it("refuses only a body with no event type", () => {
    expect(parseLinearWebhook({ action: "create" })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    expect(parseLinearWebhook("x")).toMatchObject({ ok: false });
  });
});
