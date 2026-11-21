import { createServer } from "node:http";

import { sha256Hex } from "@ostra/adapter-sdk";
import type { AdapterResult, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear, defineTrackerContractSuite, fakeLinearSuiteFixture, memoryAdapterContext, memoryRateBudgetStore } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { externalTicketIdSchema, ticketKeySchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LINEAR_AGENT_MODE_SCOPES } from "./app/oauth.ts";
import { LinearAdapter, linearMention } from "./linear-adapter.ts";
import { fileName, markdownFiles, markdownImages } from "./markdown-images.ts";

const must = <T,>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

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
    // Agent mode's scopes on the install, so the session cases run (ticket 07).
    const token = fake.mintToken("app", LINEAR_AGENT_MODE_SCOPES);
    const appUser = fake.appUser();
    if (appUser === undefined) throw new Error("the fake made no app user");
    const adapter = adapterOn(fake, token.accessToken, "oauth");
    return {
      adapter,
      fixture: fakeLinearSuiteFixture({ fake, other: adapterOn(other, other.adminApiKey, "api-key"), ownUserId: appUser.id, webhookSecret: app.webhookSecret, milestone6: true }),
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
      fixture: fakeLinearSuiteFixture({ fake, other: adapterOn(other, other.adminApiKey, "api-key"), ownUserId: null, webhookSecret: "lin_wh_dev", milestone6: true }),
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

  it("F-036/c2: finds an active user by email, and their mention, posted in a comment, mentions them in Linear", async () => {
    const maya = fake.addUser({ name: "Maya Brook", email: "maya@example.test", displayName: "maya" });
    const found = await adapter.findUsersByEmail(board(), ["Maya@Example.test"]);
    expect(found).toEqual({
      ok: true,
      value: [{ email: "Maya@Example.test", userId: maya.id, mention: `[@maya](https://linear.app/ostra-test/profiles/maya)` }],
    });
    if (!found.ok) throw new Error(found.error.message);
    // The comment ticket 11's tracker notifications write: the fake reads mentions as Linear does.
    const issue = await fake.createIssue({ title: "Mentions" });
    const posted = await adapter.comment(board(), issue.identifier, `Needs you: an approval. ${found.value[0]?.mention ?? ""}`);
    if (!posted.ok) throw new Error(posted.error.message);
    expect(fake.issueView(issue.id).comments.find((comment) => comment.id === posted.value.commentId)?.mentions).toEqual([maya.id]);
  });

  it("F-036/c2: leaves out deactivated users, unknown emails and blank ones, and asks in batches", async () => {
    const gone = fake.addUser({ name: "Gone", email: "gone@example.test" });
    fake.setUserActive(gone.id, false);
    const many = Array.from({ length: 120 }, (_, index) => `nobody-${String(index)}@example.test`);
    const before = fake.apiCalls()["users"] ?? 0;
    expect(await adapter.findUsersByEmail(board(), ["gone@example.test", "", "  ", ...many])).toEqual({ ok: true, value: [] });
    expect((fake.apiCalls()["users"] ?? 0) - before).toBe(3);
    expect(await adapter.findUsersByEmail(board(), [])).toEqual({ ok: true, value: [] });
    expect(fake.apiCalls()["users"] ?? 0).toBe(before + 3);
  });

  it("F-036/c2: keeps every email out of its log lines, and reports Linear's failure as an error", async () => {
    fake.addUser({ name: "Quiet", email: "quiet.person@example.test" });
    fake.injectFaults([{ kind: "http500" }]);
    const failed = await adapter.findUsersByEmail(board(), ["quiet.person@example.test"]);
    expect(failed).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await adapter.findUsersByEmail(board(), ["quiet.person@example.test"])).toMatchObject({ ok: true, value: [{ email: "quiet.person@example.test" }] });
    expect(JSON.stringify([failed, context.logger.records])).not.toContain("quiet.person");
  });

  it("F-036/c2: writes a mention whose display name can't break the link, and none for a URL that isn't Linear's", () => {
    expect(linearMention({ displayName: "a](https://evil.test)[b", url: "https://linear.app/ostra-test/profiles/a" })).toBe(
      String.raw`[@a\]\(https://evil.test\)\[b](https://linear.app/ostra-test/profiles/a)`,
    );
    expect(linearMention({ displayName: "x", url: "https://evil.test/profiles/x" })).toBeNull();
    expect(linearMention({ displayName: "x", url: "http://linear.app/ostra-test/profiles/x" })).toBeNull();
    expect(linearMention({ displayName: "x", url: "https://linear.app/ostra-test/issue/OST-1" })).toBeNull();
    expect(linearMention({ displayName: "x", url: "not a url" })).toBeNull();
  });

  it("declares what it has: agent sessions, sub-issues, webhooks, comment edits and attachments; no graph or transitions", () => {
    expect(adapter.capabilities).toEqual({
      agentSessions: true,
      subIssues: true,
      statusGraph: false,
      webhooks: true,
      commentEdit: true,
      attachments: true,
      transitions: false,
      // F-036: findUsersByEmail, with the profile link as the mention.
      mentions: true,
      // Milestone 6 (ticket 07): agent mode's scopes, and the session's link to the task.
      agentScopes: ["app:assignable", "app:mentionable"],
      agentSessionLink: true,
      ticketFields: { acceptanceCriteria: false },
      // Milestone 9 (F-149): every file the ticket shows on Linear's file host.
      ticketFiles: "all",
    });
  });
});

// Milestone 9 (F-149, ticket 08): every file of a Linear ticket, on the fake Linear. The tracker
// suite above runs the shared cases; these are Linear's own shapes: links, autolinks, attachments.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%fake\n");
/** ostra's progress comment's marker, as core passes it in `OwnWrites`. */
const PROGRESS_MARKER = "<sub>ostra edits this comment as the task moves:";
const own = (userId: string | null) => ({ userId, commentMarkers: [PROGRESS_MARKER], attachmentMarkers: ["Attached by ostra from a draft"] });

describe("every file of a Linear ticket", () => {
  let fake: FakeLinear;
  let key: LinearAdapter;
  let app: LinearAdapter;
  const board = () => ({ externalId: fake.team.id });

  beforeAll(async () => {
    fake = await createFakeLinear();
    fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example.test/oauth/linear/callback"], webhookUrl: null });
    app = adapterOn(fake, fake.mintToken("app", LINEAR_AGENT_MODE_SCOPES).accessToken, "oauth");
    key = adapterOn(fake, fake.adminApiKey, "api-key");
  });
  afterAll(async () => {
    await fake.close();
  });

  it("F-149/c1,c6: a .docx link in the description, an attached PDF and a comment's .xlsx are files, in order; ostra's comment's picture and a link attachment aren't", async () => {
    const spec = fake.upload({ name: "spec v2.docx", contentType: DOCX, bytes: ZIP });
    const mock = fake.upload({ name: "mock.png", contentType: "image/png", bytes: PNG });
    const sheet = fake.upload({ name: "numbers.xlsx", contentType: XLSX, bytes: ZIP });
    const design = fake.upload({ name: "design.pdf", contentType: "application/pdf", bytes: PDF });
    const preview = fake.upload({ name: "preview.png", contentType: "image/png", bytes: PNG });
    const figma = "https://www.figma.com/file/0196f1a0/History?node-id=1-2";
    const issue = await fake.createIssue({
      title: "Every file",
      // A link and an autolink to the file host, and links elsewhere, which are never files.
      description: `Build it from [spec v2.docx](${spec}); the layout is <${mock}>.\n\nSee [the frame](${figma}) and <https://example.test/notes.txt>. \`$(whoami)\``,
    });
    const commentId = await fake.addComment(issue.id, `The numbers: [numbers.xlsx](${sheet})`);
    // ostra's progress comment, written through the adapter as core writes it, with a picture.
    must(await key.comment(board(), issue.identifier, `**ostra is working on this.**\n\n![preview.png](${preview})\n\n${PROGRESS_MARKER} https://ostra.example.test/tasks/1</sub>`), "comment");
    await fake.attachToIssue(issue.id, { url: design, title: "design.pdf" });
    await fake.attachToIssue(issue.id, { url: figma, title: "History panel (Figma)" });
    must(await key.linkPullRequest(board(), issue.identifier, "https://github.com/ostra-test/test1/pull/7"), "linkPullRequest");

    const read = must(await key.getTicketContext(board(), { externalId: issue.id }, { own: own(null) }), "getTicketContext");
    expect(read.files.filter((file) => !file.byOstra).map((file) => ({ url: file.url, name: file.name, where: file.where, commentId: file.commentId }))).toEqual([
      { url: spec, name: "spec v2.docx", where: "description", commentId: null },
      { url: mock, name: "mock.png", where: "description", commentId: null },
      { url: sheet, name: "numbers.xlsx", where: "comment", commentId },
      { url: design, name: "design.pdf", where: "attachment", commentId: null },
    ]);
    // ostra's own picture is marked, so core leaves it out.
    expect(read.files.filter((file) => file.byOstra).map((file) => file.url)).toEqual([preview]);
    // A link attachment off the file host stays a link: never a file, never fetched.
    const fileUrls = read.files.map((file) => file.url);
    expect(fileUrls).not.toContain(figma);
    expect(fileUrls).not.toContain("https://github.com/ostra-test/test1/pull/7");
    expect(fileUrls).not.toContain("https://example.test/notes.txt");
    expect(read.attachments.map((attachment) => attachment.url)).toEqual(expect.arrayContaining([design, figma, "https://github.com/ostra-test/test1/pull/7"]));
    // Each one is a file Linear holds, fetched with the token.
    const before = fake.apiCalls()["uploads"] ?? 0;
    for (const file of read.files) {
      expect(must(await key.downloadFile(file.url, 1024 * 1024), "downloadFile").bytes.length).toBeGreaterThan(0);
    }
    expect((fake.apiCalls()["uploads"] ?? 0) - before).toBe(read.files.length);
  });

  it("F-149/c6: a comment by ostra's app user is ostra's without its marker, and an attachment with attachFile's marker too", async () => {
    const shot = fake.upload({ name: "shot.png", contentType: "image/png", bytes: PNG });
    const issue = await fake.createIssue({ title: "The app's own" });
    must(await app.comment(board(), issue.identifier, `A preview: ![shot.png](${shot})`), "comment");
    const attached = must(
      await app.attachFile(board(), { externalId: issue.id }, { name: "draft.png", contentType: "image/png", bytes: PNG, marker: "Attached by ostra from a draft (image 7)" }),
      "attachFile",
    );
    const appUser = fake.appUser();
    if (appUser === undefined) throw new Error("no app user");
    const read = must(await app.getTicketContext(board(), { externalId: issue.id }, { own: { userId: appUser.id, commentMarkers: [], attachmentMarkers: ["Attached by ostra from a draft"] } }), "getTicketContext");
    expect(read.files.map((file) => ({ url: file.url, byOstra: file.byOstra, where: file.where }))).toEqual([
      { url: shot, byOstra: true, where: "comment" },
      { url: attached.url, byOstra: true, where: "attachment" },
    ]);
  });

  it("F-149/c9: filesInText finds a follow-up's file, and a link off the file host is ignored", async () => {
    const layout = fake.upload({ name: "layout.png", contentType: "image/png", bytes: PNG });
    const notes = fake.upload({ name: "notes.docx", contentType: DOCX, bytes: ZIP });
    const issue = await fake.createIssue({ title: "Delegated with files" });
    const { sessionId } = await fake.delegateToApp(issue.id);
    // A member's follow-up in the session's thread, holding a screenshot and a document.
    await fake.promptSession(sessionId, `Use this layout instead: ![layout.png](${layout})\n\nand [notes.docx](${notes}), not [the old notes](https://files.example.test/uploads/1/notes.docx)`);
    const body = fake.sessionEvents().filter((event) => event.sessionId === sessionId).at(-1)?.body;
    const event = must(app.parseAgentSessionEvent(body), "parseAgentSessionEvent");
    expect(event.action).toBe("prompted");
    const found = app.filesInText(event.prompt ?? "");
    expect(found).toEqual([
      { url: layout, name: "layout.png", contentType: null, size: null, where: "comment", commentId: null, byOstra: false },
      { url: notes, name: "notes.docx", contentType: null, size: null, where: "comment", commentId: null, byOstra: false },
    ]);
    expect(must(await app.downloadFile(layout, 1024 * 1024), "downloadFile").bytes).toEqual(PNG);
    expect(app.filesInText("Nothing here but [a link](https://example.test/a.pdf) and <https://example.test/b.png>")).toEqual([]);
  });

  it("F-149/c1: refuses a 12 MiB file at a 10 MiB cap, and a download that fails is an error, not a file", async () => {
    const big = fake.upload({ name: "recording.mov", contentType: "video/quicktime", bytes: new Uint8Array(12 * 1024 * 1024) });
    expect(await key.downloadFile(big, 10 * 1024 * 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const flaky = fake.upload({ name: "flaky.pdf", contentType: "application/pdf", bytes: PDF });
    fake.failNextDownload(flaky);
    expect(await key.downloadFile(flaky, 1024 * 1024)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    // Retry fetches it again.
    expect(must(await key.downloadFile(flaky, 1024 * 1024), "downloadFile again").bytes).toEqual(PDF);
  });
});

describe("markdown files", () => {
  it("F-149/c1: finds images, links and autolinks in order, each URL once, an image when any place shows it as one", () => {
    const text = [
      "[spec.docx](https://uploads.linear.app/a/spec.docx) and ![mock.png](https://uploads.linear.app/b/mock.png)",
      '<https://uploads.linear.app/c/notes.txt> then [title](<https://uploads.linear.app/d/deck.pptx> "Deck")',
      "[again](https://uploads.linear.app/a/spec.docx) and [the mock](https://uploads.linear.app/b/mock.png)",
      // A linked image: the image is found, and stays an image.
      "[![badge](https://uploads.linear.app/e/badge.png)](https://example.test/x)",
    ].join("\n");
    expect(markdownFiles(text)).toEqual([
      { url: "https://uploads.linear.app/a/spec.docx", text: "spec.docx", image: false },
      { url: "https://uploads.linear.app/b/mock.png", text: "mock.png", image: true },
      { url: "https://uploads.linear.app/c/notes.txt", text: "", image: false },
      { url: "https://uploads.linear.app/d/deck.pptx", text: "title", image: false },
      { url: "https://uploads.linear.app/e/badge.png", text: "![badge", image: true },
    ]);
  });

  it("names a file by its text when that's a plain file name, else by its URL", () => {
    expect(fileName(new URL("https://uploads.linear.app/a/b/spec%20v2.docx"), "the spec")).toBe("spec v2.docx");
    expect(fileName(new URL("https://uploads.linear.app/a/b/c"), "notes.md")).toBe("notes.md");
    expect(fileName(new URL("https://uploads.linear.app/"), "")).toBe("file");
    expect(fileName(new URL("https://uploads.linear.app/a/%E0%A4%A"), "../../etc/passwd")).toBe("%E0%A4%A");
  });

  it("reads a long hostile text quickly", () => {
    const hostile = `${"[".repeat(20_000)}${"](".repeat(20_000)}${"<https://".repeat(20_000)}`;
    const started = performance.now();
    markdownFiles(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
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
