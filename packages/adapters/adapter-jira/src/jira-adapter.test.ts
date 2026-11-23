import type { AdapterResult } from "@ostra/adapter-sdk";
import { defineTrackerContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { ticketKeySchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markdownToAdf } from "./adf.ts";
import { findJiraCloudId, JiraAdapter, jqlTime, MARKERS_PROPERTY, withoutOrderBy } from "./jira-adapter.ts";
import { planMapping } from "./transitions.ts";
import { createFakeJira, fakeJiraSuiteFixture } from "./testing/index.ts";
import type { FakeJira } from "./testing/index.ts";

// The Jira adapter against the fake Jira (spec section 8, ADR 0047): the tracker contract suite
// through Atlassian's gateway with the service account's scoped token, then what's Jira's own:
// the token's read-back, the workflow's transitions, JQL, ADF, the files, the rate limits, and the
// token and ticket text kept out of every error and log line.

const must = <T,>(result: AdapterResult<T>, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

type Mode = "gateway" | "site";

const adapterOn = (fake: FakeJira, mode: Mode, options: { readonly token?: string; readonly email?: string; readonly context?: ReturnType<typeof memoryAdapterContext>; readonly criteria?: string } = {}) =>
  new JiraAdapter(
    {
      siteUrl: fake.siteUrl,
      auth: { email: options.email ?? fake.serviceAccount.email, token: options.token ?? fake.token },
      ...(mode === "gateway" ? { cloudId: fake.cloudId, gatewayUrl: fake.gatewayUrl } : {}),
      ...(options.criteria === undefined ? {} : { acceptanceCriteriaField: options.criteria }),
    },
    options.context,
  );

defineTrackerContractSuite({
  name: "jira, on the fake Jira through Atlassian's gateway with the service account's scoped token",
  create: async () => {
    const fake = await createFakeJira();
    const other = await createFakeJira();
    return {
      adapter: adapterOn(fake, "gateway"),
      fixture: fakeJiraSuiteFixture({ fake, other: adapterOn(other, "gateway"), mode: "gateway" }),
      dispose: async () => {
        await Promise.all([fake.close(), other.close()]);
      },
    };
  },
});

describe("the Jira adapter", () => {
  let fake: FakeJira;
  let adapter: JiraAdapter;
  const context = memoryAdapterContext();
  const board = () => ({ externalId: fake.project.id });
  const status = (name: string): string => {
    const found = fake.statuses.find((one) => one.name === name);
    if (found === undefined) throw new Error(`no status ${name}`);
    return found.id;
  };

  beforeAll(async () => {
    fake = await createFakeJira({ clock: context.clock, customFields: ["customfield_10050"] });
    adapter = adapterOn(fake, "gateway", { context });
  });
  afterAll(async () => {
    await fake.close();
  });

  it("F-008/c2: signs in as the service account with its scoped token through Atlassian's gateway, and a classic token at the site", async () => {
    const before = fake.calls().length;
    expect(await adapter.health()).toEqual({ status: "ok" });
    expect(fake.calls().slice(before).map((call) => [call.route, call.via])).toEqual([["GET /rest/api/3/myself", "gateway"]]);
    // A scoped token works only through the gateway, as Atlassian's does.
    expect(await adapterOn(fake, "site").health()).toMatchObject({ status: "down" });
    const classic = fake.mintToken(fake.serviceAccount.accountId, null);
    expect(await adapterOn(fake, "site", { token: classic }).health()).toEqual({ status: "ok" });
    expect(await adapterOn(fake, "gateway", { token: classic }).health()).toMatchObject({ status: "down" });
    // A wrong token is refused, and its error never holds it.
    const wrong = await adapterOn(fake, "gateway", { token: "ATATTwrong-token-value" }).getTicket(board(), ticketKeySchema.parse("PROJ-1"));
    expect(wrong).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(JSON.stringify(wrong)).not.toContain("ATATTwrong-token-value");
    // The cloud ID comes from the site's public tenant info, with no credential.
    expect(await findJiraCloudId(fake.siteUrl)).toEqual({ ok: true, value: fake.cloudId });
    expect(await findJiraCloudId("not a url")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("reads back who the token signs in as, the projects it sees, the permissions it lacks, and whether it reads workflows", async () => {
    const ops = fake.addProject("SHOP", "Globex storefront");
    const hidden = fake.addProject("SECRET", "Not for ostra");
    fake.revokePermissions(fake.serviceAccount.accountId, ops.id, ["TRANSITION_ISSUES", "ADD_COMMENTS"]);
    fake.revokePermissions(fake.serviceAccount.accountId, hidden.id, ["BROWSE_PROJECTS"]);
    const checked = must(await adapter.checkToken(), "checkToken");
    expect(checked.account).toMatchObject({ accountId: fake.serviceAccount.accountId, name: "ostra-bot", accountType: "app", serviceAccount: true });
    expect(checked.projects.map((project) => [project.key, project.missing])).toEqual([
      [fake.project.key, []],
      ["SHOP", ["TRANSITION_ISSUES", "ADD_COMMENTS"]],
    ]);
    expect(checked.workflowsReadable).toBe(true);
    // Without `read:workflow:jira`, the rest still reads, and the mapping can't check transitions.
    const narrow = fake.mintToken(fake.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    expect(must(await adapterOn(fake, "gateway", { token: narrow }).checkToken(), "checkToken without workflows").workflowsReadable).toBe(false);
    // A person's token reads back as a person's, which the connect page refuses.
    const personToken = fake.mintToken(fake.person.accountId, ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"]);
    expect(must(await adapterOn(fake, "gateway", { token: personToken, email: fake.person.email }).checkToken(), "a person's checkToken").account).toMatchObject({ serviceAccount: false, accountType: "atlassian" });
  });

  it("walks a ticket through its workflow's transitions, never writing a status, and never through Won't Do", async () => {
    const created = fake.createIssue({ summary: "Walk me" });
    const before = fake.calls().length;
    const moved = must(await adapter.moveTicket(board(), { externalId: created.id }, "done", { started: status("In Progress"), inReview: status("In Review"), done: status("Done") }), "moveTicket");
    expect(moved).toEqual({ moved: true, status: { id: status("Done"), name: "Done", category: "done" } });
    const posts = fake.calls().slice(before).filter((call) => call.route.endsWith("/transitions") && call.route.startsWith("POST"));
    expect(posts).toHaveLength(3);
    expect(fake.calls().slice(before).some((call) => call.route.startsWith("PUT /rest/api/3/issue/"))).toBe(false);
    // From Blocked, In Review is two steps away (Unblock, Ready for review).
    const blocked = fake.createIssue({ summary: "Blocked" });
    fake.setStatus(blocked.id, status("Blocked"));
    expect(must(await adapter.moveTicket(board(), { externalId: blocked.id }, "in-review", { started: status("In Progress"), inReview: status("In Review"), done: status("Done") }), "moveTicket from Blocked").status.name).toBe("In Review");
  });

  it("says no transition reaches a target with no path, and leaves the ticket where it was", async () => {
    const created = fake.createIssue({ summary: "Stuck" });
    const before = fake.calls().length;
    // Nothing in the workflow goes back to Backlog.
    const refused = await adapter.moveTicket(board(), { externalId: created.id }, "started", { started: status("Backlog"), inReview: status("In Review"), done: status("Done") });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fake.issueView(created.id).statusId).toBe(status("To Do"));
    expect(fake.calls().slice(before).some((call) => call.route.startsWith("POST") && call.route.endsWith("/transitions"))).toBe(false);
    // Without `read:workflow:jira`, the walk finds its transitions per ticket, a category at a time.
    const narrow = fake.mintToken(fake.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    const blind = adapterOn(fake, "gateway", { token: narrow });
    const other = fake.createIssue({ summary: "Walk me blind" });
    expect(must(await blind.moveTicket(board(), { externalId: other.id }, "done", { started: status("In Progress"), inReview: status("In Review"), done: status("Done") }), "a blind move").status.name).toBe("Done");
    expect(await blind.moveTicket(board(), { externalId: created.id }, "started", { started: status("Backlog"), inReview: status("In Review"), done: status("Done") })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fake.issueView(created.id).statusId).toBe(status("To Do"));
  });

  it("reads the board's workflow per issue type, which plans the mapping's transitions and warnings", async () => {
    const workflow = must(await adapter.readWorkflow(board()), "readWorkflow");
    expect(workflow.readable).toBe(true);
    const task = workflow.issueTypes.find((type) => type.name === "Task")?.workflow;
    if (task === null || task === undefined) throw new Error("no task workflow");
    expect(task.transitions.find((transition) => transition.name === "Won't do")?.from).toBe("any");
    expect(task.statuses.find((one) => one.name === "Won't Do")?.category).toBe("cancelled");
    const [started, , done] = planMapping(task, { started: status("In Progress"), inReview: status("In Review"), done: status("Done") });
    expect(started?.direct.find((step) => step.transition.name === "Start progress")?.from).toEqual([status("Backlog"), status("To Do")]);
    expect(done?.unreachableFrom).toEqual([]);
    const narrow = fake.mintToken(fake.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    const blind = must(await adapterOn(fake, "gateway", { token: narrow }).readWorkflow(board()), "readWorkflow without the scope");
    expect(blind.readable).toBe(false);
    expect(blind.issueTypes.every((type) => type.workflow === null)).toBe(true);
  });

  it("F-008/c4: pages a search with Jira's nextPageToken, and asks for updated times in the account's own zone", async () => {
    expect(jqlTime(Date.UTC(2026, 10, 23, 10, 5, 30), "Europe/Amsterdam")).toBe("2026/11/23 11:05");
    expect(jqlTime(Date.UTC(2026, 10, 23, 3, 5, 30), "America/Los_Angeles")).toBe("2026/11/22 19:05");
    context.clock.advance(3_600_000);
    const since = context.clock.now();
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      made.push(fake.createIssue({ summary: `Paged ${String(index)}` }).id);
      context.clock.advance(10_000);
    }
    const before = fake.calls().length;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listed = must(await adapter.listTickets({ board: board(), updatedSince: since + 1, order: "updatedAt", pageSize: 2, ...(cursor === undefined ? {} : { cursor }) }), "listTickets");
      seen.push(...listed.tickets.map((ticket) => ticket.externalId));
      if (listed.nextCursor === null) break;
      cursor = listed.nextCursor;
    }
    // The first was made a millisecond before `since + 1`: JQL asks from the minute, the page keeps the exact time.
    expect(seen).toEqual(made.slice(1));
    expect(fake.calls().slice(before).filter((call) => call.route === "POST /rest/api/3/search/jql")).toHaveLength(3);
  });

  it("takes an intake rule's JQL, bounded to the board and ordered by the adapter", async () => {
    const shop = fake.addProject("INTK", "Intake elsewhere");
    const wanted = fake.createIssue({ summary: "For ostra", labels: ["ostra"] });
    fake.createIssue({ summary: "Not labelled" });
    const started = fake.createIssue({ summary: "Labelled but started", labels: ["ostra"] });
    fake.setStatus(started.id, status("In Progress"));
    fake.createIssue({ projectId: shop.id, summary: "Another project", labels: ["ostra"] });
    const found = must(await adapter.searchTickets(board(), 'labels = ostra AND statusCategory = "To Do" ORDER BY created DESC'), "searchTickets");
    expect(found.tickets.map((ticket) => ticket.externalId)).toEqual([wanted.id]);
    expect(withoutOrderBy('summary = "order by me" ORDER BY created')).toBe('summary = "order by me"');
    expect(await adapter.searchTickets(board(), "labels ~ ostra")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("turns a 429 into the time Jira says to wait, from Retry-After or else X-RateLimit-Reset, and keeps the credential's budget", async () => {
    const created = fake.createIssue({ summary: "Busy" });
    fake.injectFaults([{ kind: "rate-limited", retryAfterSeconds: null, resetInSeconds: 30 }]);
    expect(await adapter.getTicket(board(), { externalId: created.id })).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 30_000 } });
    // The budget: once Jira says nothing is left until the reset, the adapter waits without asking.
    fake.setRateHeaders({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "0", "x-ratelimit-reset": new Date(context.clock.now() + 60_000).toISOString() });
    must(await adapter.getTicket(board(), { externalId: created.id }), "the call that spends the last one");
    fake.setRateHeaders({});
    const before = fake.calls().length;
    expect(await adapter.getTicket(board(), { externalId: created.id })).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 60_000 } });
    expect(fake.calls()).toHaveLength(before);
    context.clock.advance(61_000);
    // Jira's per-issue write limit (20 in 2 s) is a 429 like any other.
    let limited: AdapterResult<{ readonly commentId: string }> | undefined;
    for (let index = 0; index < 21 && limited?.ok !== false; index += 1) {
      limited = await adapter.comment(board(), created.key, `Note ${String(index)}`);
    }
    expect(limited).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 2000 } });
    context.clock.advance(2_000);
  });

  it("F-008/c6: reads sub-tasks, an epic's children, links both ways, priority, and a moved ticket by its old key", async () => {
    const typeId = (name: string): string => {
      const found = fake.issueTypes.find((type) => type.name === name);
      if (found === undefined) throw new Error(`no issue type ${name}`);
      return found.id;
    };
    const epic = fake.createIssue({ summary: "Epic", issueTypeId: typeId("Epic"), priority: "Highest" });
    const task = fake.createIssue({ summary: "A task in the epic", issueTypeId: typeId("Task"), parentId: epic.id, priority: "Low" });
    const sub = fake.createIssue({ summary: "Sub-task", parentId: task.id });
    fake.setStatus(sub.id, status("Done"));
    const blocker = fake.createIssue({ summary: "Blocker" });
    const duplicate = fake.createIssue({ summary: "Duplicate" });
    fake.linkIssues("Blocks", blocker.id, task.id);
    fake.linkIssues("Duplicate", task.id, duplicate.id);
    // An epic's children come by `parent` in JQL; a task's sub-tasks are in its own fields too.
    const ofEpic = must(await adapter.getTicketContext(board(), { externalId: epic.id }), "the epic's context");
    expect(ofEpic.ticket.priority).toBe(1);
    expect(ofEpic.children.map((child) => [child.externalId, child.open])).toEqual([[task.id, true]]);
    const read = must(await adapter.getTicketContext(board(), { externalId: task.id }), "the task's context");
    expect(read.ticket.priority).toBe(4);
    expect(read.parent?.externalId).toBe(epic.id);
    expect(read.children.map((child) => [child.externalId, child.open])).toEqual([[sub.id, false]]);
    expect(read.linked.map((link) => [link.kind, link.ticket.externalId])).toEqual([
      ["blocked-by", blocker.id],
      ["duplicate", duplicate.id],
    ]);
    // Created under the epic, a child is a task; under a task, a sub-task.
    const child = must(await adapter.createTicket(board(), { title: "Made under the epic", description: null, parent: { externalId: epic.id } }), "createTicket under an epic");
    expect(child.parentExternalId).toBe(epic.id);
    expect(fake.issueView(child.externalId).key.startsWith(fake.project.key)).toBe(true);
    const moved = fake.createIssue({ summary: "Moving" });
    const ops = fake.addProject("MOVE", "Moved to");
    const newKey = fake.moveIssue(moved.id, ops.id);
    // Jira finds a moved issue by its old key too; the adapter answers with the new one, on its new board.
    expect(must(await adapter.getTicket({ externalId: ops.id }, moved.key), "getTicket by the old key").key).toBe(newKey);
    expect(await adapter.getTicket(board(), moved.key)).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("F-008/c6: writes comments and descriptions as ADF, a mention by account ID, and reads Jira's own times", async () => {
    const created = fake.createIssue({ summary: "ADF" });
    const { commentId } = must(await adapter.comment(board(), created.key, `## Progress\n\n- one\n- two\n\ncc [~accountid:${fake.person.accountId}]`), "comment");
    const written = fake.issueView(created.id).comments.find((comment) => comment.id === commentId)?.body;
    expect(written).toEqual(markdownToAdf(`## Progress\n\n- one\n- two\n\ncc [~accountid:${fake.person.accountId}]`));
    expect(JSON.stringify(written)).toContain(`"type":"mention","attrs":{"id":"${fake.person.accountId}"}`);
    const read = must(await adapter.getTicketContext(board(), { externalId: created.id }), "getTicketContext");
    expect(read.comments[0]).toMatchObject({ id: commentId, author: { id: fake.serviceAccount.accountId, name: "ostra-bot" } });
    expect(read.comments[0]?.createdAt).toBe(context.clock.now());
    expect(await adapter.comment(board(), created.key, "   ")).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.updateComment(board(), { externalId: created.id }, "not-a-comment", "x")).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("keeps acceptance criteria in the site's custom field when the connection names one", async () => {
    const withField = adapterOn(fake, "gateway", { criteria: "customfield_10050" });
    expect(withField.capabilities.ticketFields.acceptanceCriteria).toBe(true);
    expect(adapter.capabilities.ticketFields.acceptanceCriteria).toBe(false);
    const created = fake.createIssue({ summary: "Criteria" });
    must(await withField.updateTicket(board(), { externalId: created.id }, { description: "What", acceptanceCriteria: "- It shows the name" }), "updateTicket");
    expect(fake.issueView(created.id).fields.get("customfield_10050")).toEqual(markdownToAdf("- It shows the name"));
    expect(must(await withField.getTicket(board(), { externalId: created.id }), "getTicket").acceptanceCriteria).toBe("- It shows the name");
  });

  it("downloads an attachment with redirect=false, from its site URL too, and keeps markers in ostra's issue property", async () => {
    const created = fake.createIssue({ summary: "Files" });
    const attached = must(await adapter.attachFile(board(), { externalId: created.id }, { name: "shot.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]), marker: "Attached by ostra (image 1)" }), "attachFile");
    expect(fake.issueView(created.id).properties.get(MARKERS_PROPERTY)).toEqual({ markers: { [attached.attachmentId]: "Attached by ostra (image 1)" } });
    const before = fake.calls().length;
    expect([...must(await adapter.downloadFile(`${fake.siteUrl}/secure/attachment/${attached.attachmentId}/shot.png`, 1024), "downloadFile by the site URL").bytes]).toEqual([1, 2, 3]);
    expect(fake.calls().slice(before).map((call) => [call.route, call.query, call.via])).toEqual([[`GET /rest/api/3/attachment/content/${attached.attachmentId}`, "?redirect=false", "gateway"]]);
    expect(await adapter.downloadFile("https://evil.example.test/rest/api/3/attachment/content/1", 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await adapter.downloadFile(`${fake.siteUrl}/rest/api/3/attachment/content/1;rm`, 1024)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    // A property that isn't ostra's shape holds no markers.
    expect(must(await adapter.attachFile(board(), { externalId: created.id }, { name: "b.png", contentType: "image/png", bytes: new Uint8Array([4]) }), "attachFile without a marker").attachmentId).not.toBe(attached.attachmentId);
  });

  it("finds people by an address Jira shows, and never guesses one it hides", async () => {
    const shown = fake.addAccount({ displayName: "Visible Vera", email: "vera@globex.example" });
    const hidden = fake.addAccount({ displayName: "Hidden Hank", email: "hank@globex.example", emailVisible: false });
    fake.addAccount({ displayName: "Prefix", email: "vera@globex.example.org" });
    const found = must(await adapter.findUsersByEmail(board(), ["Vera@Globex.example", "hank@globex.example"]), "findUsersByEmail");
    expect(found).toEqual([{ email: "Vera@Globex.example", userId: shown.accountId, mention: `[~accountid:${shown.accountId}]` }]);
    expect(must(await adapter.getUser(hidden.accountId), "getUser").email).toBeNull();
    expect(must(await adapter.getUser(shown.accountId), "getUser").email).toBe("vera@globex.example");
  });

  it("F-008/c3: reads a comment event made by its own service account as its echo", () => {
    const created = fake.createIssue({ summary: "Echo" });
    const commentId = fake.addComment(created.id, "from ostra", fake.serviceAccount.accountId);
    const delivery = fake.signedDelivery({ issueId: created.id, event: "comment_created", byAccountId: fake.serviceAccount.accountId, sentAt: context.clock.now(), commentId });
    const verified = adapter.verifyWebhook({ rawBody: delivery.rawBody, headers: delivery.headers, secret: fake.webhookSecret, now: context.clock.now() });
    if (!verified.ok) throw new Error(verified.reason);
    expect(must(adapter.parseWebhook({ body: verified.body, ownUserId: fake.serviceAccount.accountId }), "parseWebhook")).toMatchObject({ subject: "comment", action: "create", byOwnUser: true, ticketExternalId: created.id });
  });

  it("F-008/c2: keeps the token and every ticket's text out of its log lines and errors", async () => {
    const secretText = "Top secret $(whoami) summary";
    const created = fake.createIssue({ summary: secretText, description: "the description `rm -rf /`", comments: ["a private comment"] });
    must(await adapter.getTicketContext(board(), { externalId: created.id }), "getTicketContext");
    must(await adapter.comment(board(), created.key, "ostra's private progress"), "comment");
    fake.injectFaults([{ kind: "unavailable" }]);
    const failed = await adapter.getTicket(board(), { externalId: created.id });
    expect(failed.ok).toBe(false);
    const logged = JSON.stringify(context.logger.records);
    for (const text of [fake.token, secretText, "rm -rf", "a private comment", "private progress", fake.serviceAccount.email]) {
      expect(logged).not.toContain(text);
      expect(JSON.stringify(failed)).not.toContain(text);
    }
    expect(context.logger.records.some((record) => record.message === "jira.call.failed")).toBe(true);
  });
});
