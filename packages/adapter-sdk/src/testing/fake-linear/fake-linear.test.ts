import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyHmacSha256Hex } from "../../plumbing/signature.ts";
import { createFakeLinear } from "./fake-linear.ts";
import type { FakeLinear } from "./fake-linear.ts";
import { readOperation } from "./graphql-lite.ts";

// The fake Linear's own tests: what ticket 07 and 08 build the Linear adapter against.

describe("the GraphQL reader", () => {
  it("reads top-level fields, aliases and arguments, with variables, objects, lists and enums", () => {
    const operation = readOperation(
      `query Issues($filter: IssueFilter, $first: Int) {
        # a comment
        issues(filter: $filter, first: $first, orderBy: updatedAt, sort: [{ updatedAt: { order: Ascending } }]) { nodes { id } }
        me: viewer { id name }
      }`,
      { filter: { team: { id: { eq: "t1" } } }, first: 2 },
    );
    expect(operation).toEqual({
      type: "query",
      fields: [
        {
          responseKey: "issues",
          name: "issues",
          args: { filter: { team: { id: { eq: "t1" } } }, first: 2, orderBy: "updatedAt", sort: [{ updatedAt: { order: "Ascending" } }] },
        },
        { responseKey: "me", name: "viewer", args: {} },
      ],
    });
  });

  it("reads a mutation with an object literal around a variable, and a string with escapes", () => {
    const operation = readOperation('mutation ($id: String!) { issueUpdate(id: $id, input: { stateId: "s\\"1", title: null }) { success } }', { id: "i1" });
    expect(operation).toEqual({
      type: "mutation",
      fields: [{ responseKey: "issueUpdate", name: "issueUpdate", args: { id: "i1", input: { stateId: 's"1', title: null } } }],
    });
  });

  it("refuses fragments, directives and subscriptions, so a misread fails loudly", () => {
    expect(() => readOperation("query { ...F }", {})).toThrow();
    expect(() => readOperation("query { viewer @include(if: true) { id } }", {})).toThrow();
    expect(() => readOperation("subscription { x }", {})).toThrow();
  });
});

const responseSchema = z.looseObject({ data: z.record(z.string(), z.unknown()).optional(), errors: z.array(z.looseObject({ message: z.string(), extensions: z.looseObject({ code: z.string() }) })).optional() });

const gql = async (fake: FakeLinear, authorization: string, query: string, variables: Record<string, unknown> = {}) => {
  const response = await fetch(fake.apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: responseSchema.parse(await response.json()) };
};

const dataOf = async (fake: FakeLinear, authorization: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const answer = await gql(fake, authorization, query, variables);
  if (answer.body.data === undefined) throw new Error(`no data: ${JSON.stringify(answer.body.errors)}`);
  return answer.body.data;
};

const pageSchema = z.object({
  issues: z.object({
    nodes: z.array(z.looseObject({ id: z.string(), identifier: z.string(), title: z.string() })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});

describe("the fake Linear", () => {
  let fake: FakeLinear;
  let app: ReturnType<FakeLinear["createApp"]>;
  const redirectUri = "http://127.0.0.1:1/oauth/linear/callback";
  let receiver: Server;
  let receiverUrl = "";
  const received: { readonly headers: Record<string, string | string[] | undefined>; readonly body: Buffer }[] = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      receiver.listen(0, "127.0.0.1", resolve);
    });
    const address = receiver.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    receiverUrl = `http://127.0.0.1:${String(address.port)}/webhooks/linear/conn-1`;
    fake = await createFakeLinear();
    app = fake.createApp({ name: "ostra", redirectUris: [redirectUri], webhookUrl: receiverUrl });
  });

  afterAll(async () => {
    await fake.close();
    await new Promise<void>((resolve) => {
      receiver.close(() => {
        resolve();
      });
    });
  });

  it("refuses a request without a credential, and takes the admin's key bare", async () => {
    expect((await gql(fake, "", "{ viewer { id } }")).status).toBe(401);
    expect((await gql(fake, `Bearer ${fake.adminApiKey}`, "{ viewer { id } }")).status).toBe(200);
    const data = await dataOf(fake, fake.adminApiKey, "{ viewer { id } organization { urlKey } }");
    expect(data).toMatchObject({ viewer: { id: fake.admin.id, app: false }, organization: { urlKey: "ostra-test" } });
  });

  it("pages issues by team, updated since, oldest first with sort or newest first with orderBy", async () => {
    const since = fake.clock.now();
    for (const title of ["A", "B", "C"]) {
      await fake.createIssue({ title });
      fake.clock.advance(1000);
    }
    const query = `query ($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 2, after: $after, sort: [{ updatedAt: { order: Ascending } }]) { nodes { id } pageInfo { hasNextPage endCursor } } }`;
    const filter = { team: { id: { eq: fake.team.id } }, updatedAt: { gte: new Date(since).toISOString() } };
    const first = pageSchema.parse(await dataOf(fake, fake.adminApiKey, query, { filter }));
    expect(first.issues.nodes.map((node) => node.title)).toEqual(["A", "B"]);
    expect(first.issues.pageInfo.hasNextPage).toBe(true);
    const second = pageSchema.parse(await dataOf(fake, fake.adminApiKey, query, { filter, after: first.issues.pageInfo.endCursor }));
    expect(second.issues.nodes.map((node) => node.title)).toEqual(["C"]);
    const newest = pageSchema.parse(
      await dataOf(fake, fake.adminApiKey, "query ($filter: IssueFilter) { issues(filter: $filter, orderBy: updatedAt) { nodes { id } } }", { filter }),
    );
    expect(newest.issues.nodes.map((node) => node.title)).toEqual(["C", "B", "A"]);
  });

  it("moves an issue to another team: a new identifier, the same ID", async () => {
    const ops = fake.addTeam("OPZ", "Ops");
    const issue = await fake.createIssue({ title: "Moving" });
    const key = await fake.moveIssue(issue.id, ops.id);
    expect(key.startsWith("OPZ-")).toBe(true);
    const data = await dataOf(fake, fake.adminApiKey, "query ($id: String!) { issue(id: $id) { identifier } }", { id: issue.id });
    expect(data).toMatchObject({ issue: { identifier: key } });
    const old = await gql(fake, fake.adminApiKey, "query ($id: String!) { issue(id: $id) { id } }", { id: issue.identifier });
    expect(old.body.errors?.[0]?.message).toContain("not found");
  });

  it("makes an attachment once per URL, and lets only a comment's author edit it", async () => {
    const issue = await fake.createIssue({ title: "Links" });
    const create = "mutation ($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { attachment { id } } }";
    const input = { issueId: issue.id, url: "https://ostra.test/t/1", title: "ostra task" };
    const first = z.object({ attachmentCreate: z.object({ attachment: z.object({ id: z.string() }) }) }).parse(await dataOf(fake, fake.adminApiKey, create, { input }));
    const second = z.object({ attachmentCreate: z.object({ attachment: z.object({ id: z.string() }) }) }).parse(await dataOf(fake, fake.adminApiKey, create, { input }));
    expect(second.attachmentCreate.attachment.id).toBe(first.attachmentCreate.attachment.id);
    expect(fake.issueView(issue.id).attachments).toHaveLength(1);

    const appToken = fake.mintToken("app");
    const commented = z
      .object({ commentCreate: z.object({ comment: z.object({ id: z.string() }) }) })
      .parse(await dataOf(fake, fake.adminApiKey, "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }", { input: { issueId: issue.id, body: "hi" } }));
    const id = commented.commentCreate.comment.id;
    const edit = "mutation ($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }";
    expect((await gql(fake, `Bearer ${appToken.accessToken}`, edit, { id, input: { body: "x" } })).status).toBe(403);
    expect((await gql(fake, fake.adminApiKey, edit, { id, input: { body: "x" } })).status).toBe(200);
    expect(fake.issueView(issue.id).comments.map((comment) => comment.body)).toContain("x");
  });

  it("answers 429 with Retry-After, and a write applied then answered 500", async () => {
    fake.injectFaults([{ kind: "rate-limited", retryAfterSeconds: 7 }]);
    const limited = await gql(fake, fake.adminApiKey, "{ viewer { id } }");
    expect(limited).toMatchObject({ status: 429, retryAfter: "7" });
    expect(limited.body.errors?.[0]?.extensions.code).toBe("RATELIMITED");

    const issue = await fake.createIssue({ title: "Retry after commit" });
    fake.injectFaults([{ kind: "fail-after-write" }]);
    const failed = await gql(fake, fake.adminApiKey, "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", {
      input: { issueId: issue.id, body: "applied" },
    });
    expect(failed.status).toBe(500);
    expect(fake.issueView(issue.id).comments.map((comment) => comment.body)).toEqual(["applied"]);
  });

  it("runs the consent flow with PKCE, gives the app its own user, and rotates the refresh token", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(fake.authorizeUrl);
    for (const [key, value] of Object.entries({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "state-1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "read,write",
      actor: "app",
    })) {
      authorize.searchParams.set(key, value);
    }
    const consent = await fetch(authorize, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get("location") ?? "");
    expect(back.searchParams.get("state")).toBe("state-1");
    const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() });
    const exchange = (form: Record<string, string>) =>
      fetch(fake.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    const wrong = await exchange({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: "wrong" });
    expect(wrong.status).toBe(400);
    const consent2 = await fetch(authorize, { redirect: "manual" });
    const code = new URL(consent2.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = tokenSchema.parse(await (await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: verifier })).json());
    const viewer = await dataOf(fake, `Bearer ${tokens.access_token}`, "{ viewer { id app } }");
    expect(viewer).toMatchObject({ viewer: { id: fake.appUser()?.id, app: true } });

    fake.expireAccessTokens();
    expect((await gql(fake, `Bearer ${tokens.access_token}`, "{ viewer { id } }")).status).toBe(401);
    const refreshed = tokenSchema.parse(await (await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).json());
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    // The old refresh token can be retried within 30 minutes, and gets the same new pair.
    const retried = tokenSchema.parse(await (await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).json());
    expect(retried.access_token).toBe(refreshed.access_token);
    fake.clock.advance(31 * 60_000);
    expect((await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).status).toBe(400);
    expect((await exchange({ grant_type: "client_credentials", client_id: app.clientId, client_secret: app.clientSecret, scope: "read" })).status).toBe(400);
  });

  it("sends a signed delivery to the app's URL when a person changes an issue", async () => {
    received.length = 0;
    const issue = await fake.createIssue({ title: "Webhook me" });
    expect(received.length).toBeGreaterThan(0);
    const delivery = received.at(-1);
    if (delivery === undefined) throw new Error("nothing arrived");
    const signature = delivery.headers["linear-signature"];
    expect(typeof signature).toBe("string");
    expect(delivery.headers["linear-delivery"]).toBeTypeOf("string");
    expect(delivery.headers["linear-event"]).toBe("Issue");
    const body = z.looseObject({ type: z.string(), action: z.string(), webhookTimestamp: z.number(), data: z.looseObject({ id: z.string() }) }).parse(JSON.parse(delivery.body.toString("utf8")));
    expect(body).toMatchObject({ type: "Issue", action: "create", data: { id: issue.id } });
    expect(fake.deliveries().at(-1)?.delivered).toBe(true);
    // Signed with the app's secret: a receiver verifies it with that, and nothing else.
    expect(typeof signature === "string" && verifyHmacSha256Hex(app.webhookSecret, delivery.body, signature)).toBe(true);
    expect(typeof signature === "string" && verifyHmacSha256Hex(`${app.webhookSecret}x`, delivery.body, signature)).toBe(false);
  });
});

// Milestone 6 (ticket 02): agent sessions, ported from spike 5's fake. Each test makes its own
// fake, so one session's clock and scopes never reach another's.
describe("the fake Linear's agent sessions", () => {
  const agentScopes = ["read", "write", "issues:create", "comments:create", "app:assignable", "app:mentionable"];
  const received: { readonly headers: Record<string, string | string[] | undefined>; readonly body: Buffer }[] = [];
  let receiver: Server;
  let receiverUrl = "";
  const opened: FakeLinear[] = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      receiver.listen(0, "127.0.0.1", resolve);
    });
    const address = receiver.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    receiverUrl = `http://127.0.0.1:${String(address.port)}/webhooks/linear/conn-1`;
  });

  afterAll(async () => {
    await Promise.all(opened.map((one) => one.close()));
    await new Promise<void>((resolve) => {
      receiver.close(() => {
        resolve();
      });
    });
  });

  const installed = async (scopes: readonly string[] = agentScopes) => {
    const fake = await createFakeLinear();
    opened.push(fake);
    const app = fake.createApp({ name: "ostra", redirectUris: ["http://127.0.0.1:1/cb"], webhookUrl: receiverUrl });
    const token = fake.mintToken("app", scopes);
    return { fake, app, auth: `Bearer ${token.accessToken}` };
  };

  const post = (fake: FakeLinear, auth: string, input: Record<string, unknown>) =>
    gql(fake, auth, "mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }", { input });

  const eventSchema = z.looseObject({
    type: z.literal("AgentSessionEvent"),
    action: z.enum(["created", "prompted"]),
    agentSession: z.looseObject({ id: z.string(), issue: z.looseObject({ id: z.string(), teamId: z.string() }), commentId: z.string().nullable(), creator: z.looseObject({ id: z.string() }) }),
    agentActivity: z.looseObject({ content: z.looseObject({ type: z.string(), body: z.string() }), signal: z.string().optional() }).optional(),
  });

  it("F-012: a delegation and a mention each make a session and a signed created event; a reply is prompted, a stop is prompted with signal stop", async () => {
    const { fake, app } = await installed();
    received.length = 0;
    const issue = await fake.createIssue({ title: "Delegate me" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    const created = eventSchema.parse(fake.sessionEvents().at(-1)?.body);
    expect(created).toMatchObject({ action: "created", agentSession: { id: sessionId, issue: { id: issue.id, teamId: fake.team.id }, commentId: null, creator: { id: fake.admin.id } } });
    const sent = received.find((one) => one.headers["linear-event"] === "AgentSessionEvent");
    if (sent === undefined) throw new Error("no AgentSessionEvent reached the app's URL");
    const signature = sent.headers["linear-signature"];
    expect(typeof signature === "string" && verifyHmacSha256Hex(app.webhookSecret, sent.body, signature)).toBe(true);

    await fake.promptSession(sessionId, "Also the footer");
    const prompted = eventSchema.parse(fake.sessionEvents().at(-1)?.body);
    expect(prompted).toMatchObject({ action: "prompted", agentSession: { id: sessionId }, agentActivity: { content: { type: "prompt", body: "Also the footer" } } });
    expect(prompted.agentActivity?.signal).toBeUndefined();
    await fake.promptSession(sessionId, "Stop", { stop: true });
    expect(eventSchema.parse(fake.sessionEvents().at(-1)?.body)).toMatchObject({ action: "prompted", agentActivity: { signal: "stop" } });
    expect(fake.session(sessionId)?.status).toBe("stopping");

    const mention = await fake.mentionApp(issue.id, "please look");
    expect(eventSchema.parse(fake.sessionEvents().at(-1)?.body)).toMatchObject({ action: "created", agentSession: { id: mention.sessionId, commentId: mention.commentId } });
    // A reply in the mention's thread, through the API as a person writes it, is a follow-up.
    await dataOf(fake, fake.adminApiKey, "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId: issue.id, body: "more", parentId: mention.commentId } });
    expect(fake.sessionEvents().at(-1)).toMatchObject({ sessionId: mention.sessionId, action: "prompted" });
  });

  it("F-012: records each activity with its kind and ephemeral flag, once per client-made ID, and a link", async () => {
    const { fake, auth } = await installed();
    const issue = await fake.createIssue({ title: "Progress" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    const id = "4a8f7a52-2f7a-4a59-9a59-1c1b8c9d0e01";
    const first = await post(fake, auth, { id, agentSessionId: sessionId, content: { type: "thought", body: "Reading" }, ephemeral: true });
    const again = await post(fake, auth, { id, agentSessionId: sessionId, content: { type: "thought", body: "Reading" }, ephemeral: true });
    expect(first.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect((await post(fake, auth, { agentSessionId: sessionId, content: { type: "response", body: "Done" }, ephemeral: true })).status).toBe(400);
    await post(fake, auth, { agentSessionId: sessionId, content: { type: "response", body: "Done" } });
    expect(fake.session(sessionId)?.activities.map((activity) => [activity.type, activity.body, activity.ephemeral])).toEqual([
      ["thought", "Reading", true],
      ["response", "Done", false],
    ]);
    expect(fake.session(sessionId)?.status).toBe("complete");
    await dataOf(fake, auth, "mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }", {
      id: sessionId,
      input: { externalUrls: [{ label: "ostra", url: "https://ostra.example.test/tasks/1" }] },
    });
    expect(fake.session(sessionId)?.externalUrls).toEqual([{ label: "ostra", url: "https://ostra.example.test/tasks/1" }]);
    const read = z
      .object({ agentSession: z.looseObject({ activities: z.object({ nodes: z.array(z.looseObject({ content: z.looseObject({ type: z.string() }) })) }) }) })
      .parse(await dataOf(fake, auth, "query ($id: String!) { agentSession(id: $id) { activities { nodes { content } } } }", { id: sessionId }));
    expect(read.agentSession.activities.nodes.map((node) => node.content.type)).toEqual(["thought", "response"]);
  });

  it("F-012: a session silent for more than 30 minutes goes stale, and its next activity recovers it", async () => {
    const { fake, auth } = await installed();
    const issue = await fake.createIssue({ title: "Silent" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    await post(fake, auth, { agentSessionId: sessionId, content: { type: "thought", body: "Starting" } });
    fake.clock.advance(30 * 60_000);
    expect(fake.session(sessionId)?.status).toBe("active");
    fake.clock.advance(1);
    expect(fake.session(sessionId)?.status).toBe("stale");
    await post(fake, auth, { agentSessionId: sessionId, content: { type: "thought", body: "Still here" } });
    expect(fake.session(sessionId)).toMatchObject({ status: "active", staleEpisodes: 1 });
  });

  it("F-012: a session with an activity every 20 minutes never goes stale", async () => {
    const { fake, auth } = await installed();
    const issue = await fake.createIssue({ title: "Heartbeat" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    for (let beat = 0; beat < 6; beat += 1) {
      await post(fake, auth, { agentSessionId: sessionId, content: { type: "thought", body: `Working ${String(beat)}` }, ephemeral: true });
      fake.clock.advance(20 * 60_000);
      expect(fake.session(sessionId)?.status).toBe("active");
    }
    expect(fake.session(sessionId)?.staleEpisodes).toBe(0);
  });

  it("F-012: a personal API key's agentActivityCreate is refused 403, as spike 5's real run saw, and nothing is recorded", async () => {
    const { fake } = await installed();
    const issue = await fake.createIssue({ title: "Keyed" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    const refused = await post(fake, fake.adminApiKey, { agentSessionId: sessionId, content: { type: "thought", body: "From a key" } });
    expect(refused.status).toBe(403);
    expect(refused.body.errors?.[0]?.message).toContain("unexpected authentication method (apiKey)");
    expect(fake.session(sessionId)?.activities).toEqual([]);
  });

  it("F-012: a delegation needs app:assignable, and a re-consent changes the install's scopes only with update_scopes_on_existing_token", async () => {
    const { fake, app } = await installed(["read", "write"]);
    const issue = await fake.createIssue({ title: "No scope" });
    const appUser = fake.appUser();
    if (appUser === undefined) throw new Error("no app user");
    const refused = await gql(fake, fake.adminApiKey, "mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issue.id, input: { delegateId: appUser.id } });
    expect(refused.body.errors?.[0]?.message).toContain("app:assignable");
    expect(fake.sessionEvents()).toEqual([]);

    const redirectUri = "http://127.0.0.1:1/cb";
    const consent = async (extra: Record<string, string>) => {
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(fake.authorizeUrl);
      for (const [key, value] of Object.entries({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state: "s",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        scope: agentScopes.join(","),
        actor: "app",
        ...extra,
      })) {
        authorize.searchParams.set(key, value);
      }
      const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location") ?? "");
      const answer = await fetch(fake.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret, code_verifier: verifier }),
      });
      return z.object({ scope: z.string() }).parse(await answer.json()).scope.split(" ");
    };
    expect(await consent({})).toEqual(["read", "write"]);
    expect(fake.installScopes()).toEqual(["read", "write"]);
    expect(await consent({ update_scopes_on_existing_token: "true" })).toEqual(agentScopes);
    expect(fake.installScopes()).toEqual(agentScopes);
    expect(fake.authorizations().map((one) => one.updateScopes)).toEqual([false, true]);
    await fake.delegateToApp(issue.id);
    expect(fake.sessionEvents().map((event) => event.action)).toEqual(["created"]);
  });
});
