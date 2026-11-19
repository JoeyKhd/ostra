import { createServer } from "node:http";

import { sha256Hex } from "@ostra/adapter-sdk";
import type { TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear, defineTrackerContractSuite, fakeLinearSuiteFixture, memoryAdapterContext, memoryRateBudgetStore } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LinearAdapter } from "./linear-adapter.ts";
import { markdownImages } from "./markdown-images.ts";

// The Linear adapter against the fake Linear server (spec section 8): the tracker contract suite,
// then what's Linear's own: how it reads Linear's types, threads, relations and files, and how it
// keeps the token and ticket text out of every error and log line.

const originOf = (fake: FakeLinear): string => new URL(fake.apiUrl).origin;

const adapterOn = (fake: FakeLinear, token: string, kind: "api-key" | "oauth", context?: ReturnType<typeof memoryAdapterContext>) =>
  new LinearAdapter({ auth: { kind, token }, apiUrl: fake.apiUrl, fileOrigins: [originOf(fake)] }, context);

defineTrackerContractSuite({
  name: "linear, on the fake Linear with the app's token",
  create: async () => {
    const fake = await createFakeLinear();
    const other = await createFakeLinear();
    const app = fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example.test/oauth/linear/callback"], webhookUrl: null });
    const token = fake.mintToken("app");
    const appUser = fake.appUser();
    if (appUser === undefined) throw new Error("the fake made no app user");
    const adapter = adapterOn(fake, token.accessToken, "oauth");
    return {
      adapter,
      fixture: fakeLinearSuiteFixture({ fake, other: adapterOn(other, other.adminApiKey, "api-key"), ownUserId: appUser.id, webhookSecret: app.webhookSecret }),
      dispose: async () => {
        await Promise.all([fake.close(), other.close()]);
      },
    };
  },
});

defineTrackerContractSuite({
  name: "linear, on the fake Linear with a personal API key (development)",
  create: async () => {
    const fake = await createFakeLinear();
    const other = await createFakeLinear();
    return {
      adapter: adapterOn(fake, fake.adminApiKey, "api-key"),
      fixture: fakeLinearSuiteFixture({ fake, other: adapterOn(other, other.adminApiKey, "api-key"), ownUserId: null, webhookSecret: "lin_wh_dev" }),
      dispose: async () => {
        await Promise.all([fake.close(), other.close()]);
      },
    };
  },
});

describe("the Linear adapter", () => {
  let fake: FakeLinear;
  let adapter: LinearAdapter;
  const context = memoryAdapterContext();
  const board = () => ({ externalId: fake.team.id });

  beforeAll(async () => {
    fake = await createFakeLinear();
    adapter = adapterOn(fake, fake.adminApiKey, "api-key", context);
  });
  afterAll(async () => {
    await fake.close();
  });

  it("sends an API key as it is, and an OAuth token as a bearer", async () => {
    expect(await adapter.health()).toEqual({ status: "ok" });
    // Linear refuses an OAuth token sent bare, as the fake does.
    const person = fake.mintToken("person");
    expect(await adapterOn(fake, person.accessToken, "oauth").health()).toEqual({ status: "ok" });
    expect(await adapterOn(fake, person.accessToken, "api-key").health()).toMatchObject({ status: "down" });
    expect(await adapterOn(fake, "lin_api_wrong", "api-key").health()).toMatchObject({ status: "down" });
  });

  it("lists statuses in Linear's board order, with Linear's types in the four categories", async () => {
    const listed = await adapter.listStatuses(board());
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.map((status) => [status.name, status.vendorType, status.category, status.position])).toEqual([
      ["Triage", "triage", "open", 0],
      ["Backlog", "backlog", "open", 1],
      ["Todo", "unstarted", "open", 2],
      ["In Progress", "started", "started", 3],
      ["In Review", "started", "started", 4],
      ["Done", "completed", "done", 5],
      ["Canceled", "canceled", "cancelled", 6],
    ]);
    expect(await adapter.listStatuses({ externalId: "team-nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("reads priority and parent in ostra's terms, and the text as data, exactly", async () => {
    const parent = await fake.createIssue({ title: "Parent" });
    const child = await fake.createIssue({ title: "Child", description: "Do `rm -rf /` $(whoami)", parentId: parent.id });
    const read = await adapter.getTicket(board(), child.identifier);
    expect(read).toMatchObject({
      ok: true,
      value: { title: "Child", description: "Do `rm -rf /` $(whoami)", priority: null, parentKey: parent.identifier, parentExternalId: parent.id },
    });
    expect(await adapter.getTicket(board(), ticketKeySchema.parse("OST-9999"))).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("reads children, relations both ways, comment threads and authors in a ticket's context", async () => {
    const parent = await fake.createIssue({ title: "Context parent", comments: ["Top comment"] });
    const child = await fake.createIssue({ title: "Context child", parentId: parent.id });
    const context = await adapter.getTicketContext(board(), { externalId: parent.id });
    if (!context.ok) throw new Error(context.error.message);
    expect(context.value.children.map((summary) => summary.key)).toEqual([child.identifier]);
    expect(context.value.comments[0]).toMatchObject({ body: "Top comment", author: { id: fake.admin.id, name: fake.admin.name }, parentId: null });
    const childContext = await adapter.getTicketContext(board(), { key: child.identifier });
    expect(childContext).toMatchObject({ ok: true, value: { parent: { key: parent.identifier, title: "Context parent" } } });
  });

  it("lists only images Linear holds: never sends the token elsewhere", async () => {
    const issue = await fake.createIssue({ title: "Images", description: "![outside](https://example.test/x.png)", withImage: true });
    const context = await adapter.getTicketContext(board(), { externalId: issue.id });
    if (!context.ok) throw new Error(context.error.message);
    expect(context.value.images).toHaveLength(1);
    expect(context.value.images[0]?.name).toBe("screenshot.png");
    expect(await adapter.downloadFile("https://example.test/x.png", 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.downloadFile("not a url", 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("stops reading a file past the cap, even when no length is declared", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png", "transfer-encoding": "chunked" });
      response.write(Buffer.alloc(4096));
      response.end(Buffer.alloc(4096));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const files = new LinearAdapter({ auth: { kind: "api-key", token: fake.adminApiKey }, apiUrl: fake.apiUrl, fileOrigins: [origin] });
    expect(await files.downloadFile(`${origin}/f.png`, 5000)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await files.downloadFile(`${origin}/f.png`, 10_000)).toMatchObject({ ok: true, value: { contentType: "image/png" } });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("refuses to edit a comment that's on another ticket", async () => {
    const first = await fake.createIssue({ title: "First" });
    const second = await fake.createIssue({ title: "Second" });
    const comment = await adapter.comment(board(), first.identifier, "ostra is working on this");
    if (!comment.ok) throw new Error(comment.error.message);
    expect(await adapter.updateComment(board(), { externalId: second.id }, comment.value.commentId, "moved")).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    expect(fake.issueView(first.id).comments.map((one) => one.body)).toEqual(["ostra is working on this"]);
  });

  it("links a PR with the board's magic word as Linear's link kind", async () => {
    const issue = await fake.createIssue({ title: "PR kinds" });
    expect(await adapter.linkPullRequest(board(), issue.identifier, "https://github.com/ostra-test/test1/pull/1", { kind: "references" })).toEqual({ ok: true, value: undefined });
    expect(await adapter.linkPullRequest(board(), issue.identifier, "https://github.com/ostra-test/test1/pull/1", { kind: "closes" })).toEqual({ ok: true, value: undefined });
    expect(fake.issueView(issue.id).attachments).toHaveLength(1);
  });

  it("doesn't create a ticket on a board it can't see", async () => {
    expect(await adapter.createTicket({ externalId: "team-nope" }, { title: "x", description: null })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("says when Linear's GitHub integration is installed", async () => {
    fake.setGithubIntegration(true);
    const tracker: TrackerAdapter = adapter;
    expect(await tracker.detectCodeHostIntegration(board())).toEqual({ ok: true, value: { installed: true, name: "GitHub" } });
    fake.setGithubIntegration(false);
    expect(await tracker.detectCodeHostIntegration(board())).toEqual({ ok: true, value: { installed: false, name: null } });
  });

  it("reports a write Linear applied and then failed as unavailable, so the writer looks before retrying", async () => {
    const issue = await fake.createIssue({ title: "Faulty" });
    fake.injectFaults([{ kind: "fail-after-write" }]);
    expect(await adapter.comment(board(), issue.identifier, "once")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fake.issueView(issue.id).comments).toHaveLength(1);
  });

  it("waits for the rate limit's reset once Linear says nothing is left, without calling", async () => {
    const store = memoryRateBudgetStore();
    const budgets = { ...memoryAdapterContext(), rateBudgets: store };
    const limited = adapterOn(fake, fake.adminApiKey, "api-key", budgets);
    await store.set(`linear:${sha256Hex(fake.adminApiKey).slice(0, 16)}`, { remaining: 0, limit: 10, resetAt: budgets.clock.now() + 60_000 });
    const before = fake.apiCalls()["issue"] ?? 0;
    expect(await limited.getTicket(board(), ticketKeySchema.parse("OST-1"))).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 60_000 } });
    expect(fake.apiCalls()["issue"] ?? 0).toBe(before);
    budgets.clock.advance(60_001);
    fake.injectFaults([{ kind: "rate-limited", retryAfterSeconds: 7 }]);
    expect(await limited.getTicket(board(), ticketKeySchema.parse("OST-1"))).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 7000 } });
  });

  it("keeps the token and Linear's messages out of every error and log line", async () => {
    fake.injectFaults([{ kind: "http500" }]);
    const failed = await adapter.getTicket(board(), { externalId: externalTicketIdSchema.parse("nope") });
    const bad = await adapterOn(fake, "lin_api_wrongtokenvalue0123456789", "api-key", context).getTicket(board(), ticketKeySchema.parse("OST-1"));
    const missing = await adapter.getTicket(board(), ticketKeySchema.parse("OST-9999"));
    const everything = JSON.stringify([failed, bad, missing, context.logger.records]);
    expect(everything).not.toContain("lin_api");
    expect(everything).not.toContain(fake.adminApiKey);
    expect(everything).not.toContain("Internal server error");
    expect(everything).not.toContain("Authentication required");
    expect(everything).not.toContain("Entity not found");
  });

  it("declares what it has: sub-issues, webhooks, comment edits and attachments; no agent sessions, graph or transitions", () => {
    expect(adapter.capabilities).toEqual({
      agentSessions: false,
      subIssues: true,
      statusGraph: false,
      webhooks: true,
      commentEdit: true,
      attachments: true,
      transitions: false,
    });
  });
});

describe("markdown images", () => {
  it("finds markdown and HTML images in order, each once, and nothing else", () => {
    const text = [
      "Intro ![one.png](https://uploads.linear.app/a/one.png) then",
      '![](<https://uploads.linear.app/b/two.png> "title")',
      '<img alt="x" src="https://uploads.linear.app/c/three.png">',
      "[not an image](https://uploads.linear.app/d/doc.pdf)",
      "![one again](https://uploads.linear.app/a/one.png)",
    ].join("\n");
    expect(markdownImages(text).map((image) => image.url)).toEqual([
      "https://uploads.linear.app/a/one.png",
      "https://uploads.linear.app/b/two.png",
      "https://uploads.linear.app/c/three.png",
    ]);
  });

  it("reads a long hostile text quickly", () => {
    const hostile = `${"![".repeat(20_000)}${"](".repeat(20_000)}<img src=${'"'.repeat(20_000)}`;
    const started = performance.now();
    markdownImages(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
