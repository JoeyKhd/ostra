import { createFakeLinear, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import type { TrackerStatus } from "@ostra/adapter-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activityIdFor, defaultReadyStatus, parseLinearAgentSessionEvent } from "./agent-sessions.ts";
import { authorizeUrl, createPkce, exchangeCode, LINEAR_AGENT_MODE_SCOPES, LINEAR_AGENT_SCOPES, LINEAR_APP_SCOPES, missingAgentScopes, randomOAuthState } from "./app/oauth.ts";
import { LinearAdapter, MAX_ATTACHMENT_BYTES } from "./linear-adapter.ts";
import { postThreadReply } from "./thread-reply.ts";

// Milestone 6's ticket 07 on the fake Linear (spec section 8): agent sessions (F-012), sub-issues
// (F-077) and draft writes (F-099). The tracker contract suite runs the shared cases in
// `linear-adapter.test.ts`; these are Linear's own.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe("Linear's agent sessions, sub-issues and drafts, on the fake Linear", () => {
  let fake: FakeLinear;
  let app: LinearAdapter;
  let key: LinearAdapter;
  let appToken: string;
  const context = memoryAdapterContext();
  const board = () => ({ externalId: fake.team.id });
  const origin = () => new URL(fake.apiUrl).origin;

  beforeAll(async () => {
    fake = await createFakeLinear();
    fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example.test/oauth/linear/callback"], webhookUrl: null });
    appToken = fake.mintToken("app", LINEAR_AGENT_MODE_SCOPES).accessToken;
    app = new LinearAdapter({ auth: { kind: "oauth", token: appToken }, apiUrl: fake.apiUrl, fileOrigins: [origin()] }, context);
    key = new LinearAdapter({ auth: { kind: "api-key", token: fake.adminApiKey }, apiUrl: fake.apiUrl, fileOrigins: [origin()] }, context);
  });
  afterAll(async () => {
    await fake.close();
  });

  const lastEventBody = (sessionId: string): unknown => fake.sessionEvents().filter((event) => event.sessionId === sessionId).at(-1)?.body;

  it("F-012/c2: reads a created event from a delegation and a mention, and a prompted one with and without the stop signal", async () => {
    const issue = await fake.createIssue({ title: "Delegate me" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    expect(parseLinearAgentSessionEvent(lastEventBody(sessionId))).toEqual({
      ok: true,
      value: {
        sessionId,
        action: "created",
        ticketExternalId: issue.id,
        teamExternalId: fake.team.id,
        creator: { userId: fake.admin.id, name: fake.admin.name, email: fake.admin.email },
        prompt: null,
        signal: null,
        commentId: null,
      },
    });

    await fake.promptSession(sessionId, "Also check the footer $(whoami)");
    expect(parseLinearAgentSessionEvent(lastEventBody(sessionId))).toMatchObject({
      ok: true,
      value: { sessionId, action: "prompted", prompt: "Also check the footer $(whoami)", signal: null, creator: { userId: fake.admin.id } },
    });
    await fake.promptSession(sessionId, "Stop", { stop: true });
    expect(parseLinearAgentSessionEvent(lastEventBody(sessionId))).toMatchObject({ ok: true, value: { sessionId, action: "prompted", signal: "stop" } });

    const mentioned = await fake.createIssue({ title: "Mention me" });
    const mention = await fake.mentionApp(mentioned.id, "can you look?");
    expect(parseLinearAgentSessionEvent(lastEventBody(mention.sessionId))).toMatchObject({
      ok: true,
      value: { sessionId: mention.sessionId, action: "created", commentId: mention.commentId, ticketExternalId: mentioned.id },
    });
    const read = parseLinearAgentSessionEvent(lastEventBody(mention.sessionId));
    expect(read.ok && read.value.prompt?.endsWith("can you look?")).toBe(true);
  });

  it("F-012/c2: reads Linear's payload loosely: unknown fields, a missing email and the SDK's other shapes", () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org-1",
      appUserId: "app-1",
      oauthClientId: "client-1",
      webhookId: "hook-1",
      webhookTimestamp: 1_700_000_000_000,
      somethingLinearAddedLater: { deep: [1, 2, 3] },
      agentSession: {
        id: "session-9",
        issue: { id: "issue-9", identifier: "OST-9", team: { id: "team-9", key: "OST" }, newField: true },
        creatorId: "user-1",
        creator: { id: "user-1", name: "Ada", avatarUrl: "https://example.test/a.png" },
        status: "awaitingInput",
      },
      agentActivity: {
        id: "activity-9",
        body: "The SDK's flat body",
        signal: "stop",
        signalMetadata: { reason: "user" },
        sourceCommentId: "comment-9",
        userId: "user-2",
      },
    };
    expect(parseLinearAgentSessionEvent(payload)).toEqual({
      ok: true,
      value: {
        sessionId: "session-9",
        action: "prompted",
        ticketExternalId: "issue-9",
        teamExternalId: "team-9",
        creator: { userId: "user-2", name: "", email: null },
        prompt: "The SDK's flat body",
        signal: "stop",
        commentId: null,
      },
    });
    // Another signal, or none, is no stop.
    expect(parseLinearAgentSessionEvent({ ...payload, agentActivity: { ...payload.agentActivity, signal: "continue" } })).toMatchObject({ ok: true, value: { signal: null } });
    // Not a session event, a session with no issue, an action ostra doesn't know: each refused.
    for (const body of [
      { type: "Issue", action: "update" },
      { ...payload, agentSession: { id: "session-9" } },
      { ...payload, action: "removed" },
      null,
      "text",
    ]) {
      expect(parseLinearAgentSessionEvent(body)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    }
  });

  it("F-012/c2: posts each kind with its content shape and ephemeral flag, and twice with one key posts once", async () => {
    const issue = await fake.createIssue({ title: "Progress" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    const thought = { kind: "thought", body: "Reading the code", ephemeral: true, idempotencyKey: "task-1:turn-1:thought" } as const;
    const first = await app.postAgentActivity(sessionId, thought);
    const again = await app.postAgentActivity(sessionId, thought);
    if (!first.ok || !again.ok) throw new Error("the activity wasn't posted");
    expect(again.value.activityId).toBe(first.value.activityId);
    expect(await app.postAgentActivity(sessionId, { kind: "action", body: "Running the tests", ephemeral: true, idempotencyKey: "a" })).toMatchObject({ ok: true });
    expect(await app.postAgentActivity(sessionId, { kind: "response", body: "Opened the PR", ephemeral: false, idempotencyKey: "r" })).toMatchObject({ ok: true });
    const activities = fake.session(sessionId)?.activities ?? [];
    expect(activities.map((one) => [one.type, one.ephemeral, one.body])).toEqual([
      ["thought", true, "Reading the code"],
      ["action", true, "Running the tests"],
      ["response", false, "Opened the PR"],
    ]);
    // Only a thought or an action can be ephemeral, and an empty text is no activity: refused before any call.
    const calls = fake.apiCalls()["agentActivityCreate"] ?? 0;
    expect(await app.postAgentActivity(sessionId, { kind: "response", body: "x", ephemeral: true, idempotencyKey: "e" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await app.postAgentActivity(sessionId, { kind: "thought", body: "  ", ephemeral: false, idempotencyKey: "t" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(fake.apiCalls()["agentActivityCreate"] ?? 0).toBe(calls);
  });

  it("F-012: derives one client-made UUID per session and key", () => {
    const id = activityIdFor("session-1", "task-1:thought");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(activityIdFor("session-1", "task-1:thought")).toBe(id);
    expect(activityIdFor("session-2", "task-1:thought")).not.toBe(id);
    expect(activityIdFor("session-1", "task-1:response")).not.toBe(id);
  });

  it("F-012/c2: finds an activity already posted with its key, and posts nothing more", async () => {
    // A retry after a post Linear applied but whose answer was lost: the lookup finds it.
    const issue = await fake.createIssue({ title: "Lost answer" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    fake.injectFaults([{ kind: "fail-after-write" }]);
    const lost = await app.postAgentActivity(sessionId, { kind: "response", body: "Done", ephemeral: false, idempotencyKey: "task-2:final" });
    expect(lost).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await app.postAgentActivity(sessionId, { kind: "response", body: "Done", ephemeral: false, idempotencyKey: "task-2:final" })).toMatchObject({ ok: true });
    expect(fake.session(sessionId)?.activities.map((one) => one.body)).toEqual(["Done"]);
  });

  it("F-012/c4: a personal key's post is refused as unauthorized, and never retried", async () => {
    const issue = await fake.createIssue({ title: "Key" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    const before = fake.apiCalls()["agentActivityCreate"] ?? 0;
    expect(await key.postAgentActivity(sessionId, { kind: "thought", body: "Hi", ephemeral: false, idempotencyKey: "k" })).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    expect((fake.apiCalls()["agentActivityCreate"] ?? 0) - before).toBe(1);
    expect(fake.session(sessionId)?.activities).toEqual([]);
  });

  it("F-012/c2: links the session to the task, and refuses a link that isn't a URL", async () => {
    const issue = await fake.createIssue({ title: "Link" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    expect(await app.setAgentSessionLink(sessionId, "https://ostra.example.test/tasks/0196f1a0")).toEqual({ ok: true, value: undefined });
    expect(fake.session(sessionId)?.externalUrls).toEqual([{ label: "Open in ostra", url: "https://ostra.example.test/tasks/0196f1a0" }]);
    expect(await app.setAgentSessionLink(sessionId, "not a url")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await app.setAgentSessionLink("session-nope", "https://ostra.example.test/tasks/1")).toMatchObject({ ok: false });
  });

  it("F-012: keeps the token, prompts and activity text out of every log line and error", async () => {
    const issue = await fake.createIssue({ title: "Secret words" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    await app.postAgentActivity(sessionId, { kind: "thought", body: "a-private-plan-line", ephemeral: false, idempotencyKey: "p" });
    const refused = await key.postAgentActivity(sessionId, { kind: "thought", body: "another-private-line", ephemeral: false, idempotencyKey: "q" });
    const everything = JSON.stringify([refused, context.logger.records]);
    for (const secret of [appToken, fake.adminApiKey, "a-private-plan-line", "another-private-line", "unexpected authentication method"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("F-012: asks for the agent scopes on the existing install, and the install gains them", async () => {
    const own = await createFakeLinear();
    try {
      const redirectUri = "https://ostra.example.test/oauth/linear/callback";
      const registered = own.createApp({ name: "ostra", redirectUris: [redirectUri], webhookUrl: null });
      const consent = async (input: { readonly extraScopes?: readonly string[]; readonly updateExistingToken?: boolean }) => {
        const pkce = createPkce();
        const url = authorizeUrl({
          authorizeUrl: own.authorizeUrl,
          clientId: registered.clientId,
          redirectUri,
          scopes: LINEAR_APP_SCOPES,
          state: randomOAuthState(),
          codeChallenge: pkce.challenge,
          ...input,
        });
        const response = await fetch(url, { redirect: "manual" });
        const code = new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";
        const tokens = await exchangeCode({ tokenUrl: own.tokenUrl, clock: own.clock, clientId: registered.clientId, clientSecret: registered.clientSecret, redirectUri, code, codeVerifier: pkce.verifier });
        if (!tokens.ok) throw new Error(tokens.error.message);
        return { url: new URL(url), tokens: tokens.value };
      };
      const installed = await consent({});
      expect(missingAgentScopes(installed.tokens.scopes)).toEqual([...LINEAR_AGENT_SCOPES]);

      // "Turn on agent mode": the full set, and the flag that updates the existing install's token.
      const turnedOn = await consent({ extraScopes: LINEAR_AGENT_SCOPES, updateExistingToken: true });
      expect(Object.fromEntries(turnedOn.url.searchParams)).toMatchObject({
        scope: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
        update_scopes_on_existing_token: "true",
        actor: "app",
        response_type: "code",
        code_challenge_method: "S256",
      });
      expect(missingAgentScopes(turnedOn.tokens.scopes)).toEqual([]);
      expect(own.installScopes()).toEqual([...LINEAR_AGENT_MODE_SCOPES]);

      // Without the flag, a second consent keeps the install's scopes: the URL never carries it.
      const plain = authorizeUrl({ clientId: "c", redirectUri, scopes: LINEAR_APP_SCOPES, extraScopes: ["read"], state: "s", codeChallenge: "x" });
      expect(new URL(plain).searchParams.get("update_scopes_on_existing_token")).toBeNull();
      expect(new URL(plain).searchParams.get("scope")).toBe("read,write,issues:create,comments:create");
    } finally {
      await own.close();
    }
  });

  it("F-040/c1: reads a person by ID, with the address when the token can read it, and an unknown one is not-found", async () => {
    const ada = fake.addUser({ name: "Ada Lovelace", email: "ada@example.test" });
    expect(await app.getUser(ada.id)).toEqual({ ok: true, value: { userId: ada.id, name: "Ada Lovelace", email: "ada@example.test", active: true } });
    fake.setUserActive(ada.id, false);
    expect(await app.getUser(ada.id)).toMatchObject({ ok: true, value: { active: false } });
    expect(await app.getUser("user-nope")).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(JSON.stringify(context.logger.records)).not.toContain("ada@example.test");
  });

  it("F-012: posts a follow-up as a thread reply for the harness, which Linear turns into prompted", async () => {
    const issue = await fake.createIssue({ title: "Harness" });
    const mention = await fake.mentionApp(issue.id, "hello");
    const replied = await postThreadReply({ apiUrl: fake.apiUrl, apiKey: fake.adminApiKey, sessionId: mention.sessionId, body: "One more thing" });
    expect(replied).toMatchObject({ ok: true });
    expect(parseLinearAgentSessionEvent(lastEventBody(mention.sessionId))).toMatchObject({ ok: true, value: { action: "prompted", prompt: "One more thing" } });
    // A delegation's session hangs from no comment in the fake: there's no thread to reply in.
    const delegated = await fake.delegateToApp((await fake.createIssue({ title: "No thread" })).id);
    expect(await postThreadReply({ apiUrl: fake.apiUrl, apiKey: fake.adminApiKey, sessionId: delegated.sessionId, body: "x" })).toEqual({ ok: false, reason: "no-thread" });
    expect(await postThreadReply({ apiUrl: fake.apiUrl, apiKey: "lin_api_wrong", sessionId: delegated.sessionId, body: "x" })).toEqual({ ok: false, reason: "refused" });
  });

  it("F-077/c1,c2: creates sub-issues three levels deep, and reads the tree in one query per ticket read", async () => {
    const root = await fake.createIssue({ title: "Root" });
    const child = await app.createTicket(board(), { title: "Child", description: "Part one", parent: { externalId: root.id } });
    if (!child.ok) throw new Error(child.error.message);
    const grandchildren = [];
    for (const title of ["Leaf A", "Leaf B"]) {
      const made = await app.createTicket(board(), { title, description: null, parent: { key: child.value.key } });
      if (!made.ok) throw new Error(made.error.message);
      expect(made.value).toMatchObject({ parentExternalId: child.value.externalId, parentKey: child.value.key });
      grandchildren.push(made.value);
    }
    const mapping = { started: stateId("In Progress"), inReview: stateId("In Review"), done: stateId("Done") };
    const doneLeaf = grandchildren[1];
    if (doneLeaf === undefined) throw new Error("no leaf");
    await app.moveTicket(board(), { externalId: doneLeaf.externalId }, "done", mapping);

    // The tree as core walks it (ticket 12): one context per level, each one `issueContext` query.
    const before = fake.apiCalls()["issue"] ?? 0;
    const top = await app.getTicketContext(board(), { externalId: root.id });
    if (!top.ok) throw new Error(top.error.message);
    expect(top.value.children.map((one) => [one.title, one.open])).toEqual([["Child", true]]);
    const middle = await app.getTicketContext(board(), { externalId: child.value.externalId });
    if (!middle.ok) throw new Error(middle.error.message);
    expect(middle.value.parent?.externalId).toBe(root.id);
    expect(middle.value.children.map((one) => [one.title, one.open])).toEqual([
      ["Leaf A", true],
      ["Leaf B", false],
    ]);
    const leaf = await app.getTicketContext(board(), { externalId: grandchildren[0]?.externalId ?? root.id });
    if (!leaf.ok) throw new Error(leaf.error.message);
    expect(leaf.value.children).toEqual([]);
    expect(leaf.value.parent?.externalId).toBe(child.value.externalId);
    // Three reads, three queries: `issue` is the root field of each context read.
    expect((fake.apiCalls()["issue"] ?? 0) - before).toBe(3);

    // A parent on another board, or none at all, makes nothing.
    const ops = fake.addTeam("SUB", "Elsewhere");
    const elsewhere = await fake.createIssue({ teamId: ops.id, title: "Elsewhere" });
    const creates = fake.apiCalls()["issueCreate"] ?? 0;
    expect(await app.createTicket(board(), { title: "Stray", description: null, parent: { externalId: elsewhere.id } })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(fake.apiCalls()["issueCreate"] ?? 0).toBe(creates);
  });

  const stateId = (name: string): string => {
    const state = fake.states(fake.team.id).find((candidate) => candidate.name === name);
    if (state === undefined) throw new Error(`no state ${name}`);
    return state.id;
  };

  it("F-099/c6: writes a draft's description as it is, and refuses criteria Linear has no field for", async () => {
    const issue = await fake.createIssue({ title: "Refine", description: "Vague" });
    const description = "## What\n\nShow the version.\n\n## Acceptance criteria\n\n- [ ] `$(whoami)` stays text";
    expect(await app.updateTicket(board(), { externalId: issue.id }, { description })).toEqual({ ok: true, value: undefined });
    expect(await app.getTicket(board(), { externalId: issue.id })).toMatchObject({ ok: true, value: { description } });
    const writes = fake.apiCalls()["issueUpdate"] ?? 0;
    expect(await app.updateTicket(board(), { externalId: issue.id }, { description, acceptanceCriteria: "- one" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await app.updateTicket({ externalId: "team-nope" }, { externalId: issue.id }, { description: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(fake.apiCalls()["issueUpdate"] ?? 0).toBe(writes);
  });

  it("F-099/c7: attaches a file through Linear's upload, which downloads back byte for byte, with no token sent to the upload URL", async () => {
    const issue = await fake.createIssue({ title: "Mock-up" });
    const attached = await app.attachFile(board(), { externalId: issue.id }, { name: "version mock.png", contentType: "image/png", bytes: PNG });
    if (!attached.ok) throw new Error(attached.error.message);
    expect(fake.apiCalls()["upload-target"]).toBe(1);
    expect(fake.issueView(issue.id).attachments.map((one) => one.url)).toEqual([attached.value.url]);
    const downloaded = await app.downloadFile(attached.value.url, 1024);
    expect(downloaded).toMatchObject({ ok: true, value: { contentType: "image/png" } });
    expect(downloaded.ok && [...downloaded.value.bytes]).toEqual([...PNG]);
    const context6 = await app.getTicketContext(board(), { externalId: issue.id });
    expect(context6.ok && context6.value.images.map((image) => image.url)).toEqual([attached.value.url]);

    // Over the cap, or with no name: refused before anything is uploaded.
    const uploads = fake.apiCalls()["fileUpload"] ?? 0;
    expect(await app.attachFile(board(), { externalId: issue.id }, { name: "big.bin", contentType: "application/octet-stream", bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) })).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
    expect(await app.attachFile(board(), { externalId: issue.id }, { name: " ", contentType: "image/png", bytes: PNG })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(fake.apiCalls()["fileUpload"] ?? 0).toBe(uploads);
  });

  it("F-099/c6: drafts the board's ready status as its first unstarted one by position", async () => {
    const listed = await app.listStatuses(board());
    if (!listed.ok) throw new Error(listed.error.message);
    expect(defaultReadyStatus(listed.value)?.name).toBe("Todo");
    const status = (name: string, vendorType: string, position: number): TrackerStatus => ({ id: name, name, category: "open", vendorType, position });
    expect(defaultReadyStatus([status("Later", "unstarted", 5), status("Backlog", "backlog", 0), status("Ready", "unstarted", 2)])?.name).toBe("Ready");
    expect(defaultReadyStatus([status("Backlog", "backlog", 0)])).toBeNull();
  });
});
