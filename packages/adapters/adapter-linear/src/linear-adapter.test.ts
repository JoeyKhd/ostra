import http from "node:http";
import type { AddressInfo } from "node:net";

import { defineTrackerContractSuite, memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import { ticketKeySchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { LinearAdapter } from "./linear-adapter.ts";

// A fake Linear GraphQL API: it answers the few operations the adapter sends, by looking at the
// query text, and checks the credentials the way Linear does.

const TOKEN = "lin_api_fake0123456789abcdefghijklmnop";
const bodySchema = z.looseObject({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional() });

type FakeIssue = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number;
  readonly stateId: string;
  readonly parent: string | null;
};

const states: Readonly<Record<string, string>> = { s1: "Todo", s2: "In Progress", s3: "Done" };

const startFake = async () => {
  const issues: FakeIssue[] = [
    { id: "uuid-1", identifier: "OST-1", title: "First", description: "Do `rm -rf /` $(whoami)", priority: 2, stateId: "s1", parent: null },
    { id: "uuid-2", identifier: "OST-2", title: "Second", description: null, priority: 0, stateId: "s2", parent: "OST-1" },
    { id: "uuid-3", identifier: "OST-3", title: "Third", description: "x", priority: 4, stateId: "s3", parent: null },
  ];
  const comments: { readonly issueId: string; readonly body: string }[] = [];
  const links: string[] = [];
  const seen: { readonly authorization: string | undefined; readonly query: string }[] = [];
  const injected: { status: number; headers?: Record<string, string>; body?: unknown }[] = [];

  const issueJson = (issue: FakeIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/ostra-test/issue/${issue.identifier}`,
    priority: issue.priority,
    updatedAt: "2026-11-18T10:00:00.000Z",
    state: { id: issue.stateId, name: states[issue.stateId] ?? "?" },
    parent: issue.parent === null ? null : { identifier: issue.parent },
  });

  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const body = bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      seen.push({ authorization: request.headers.authorization, query: body.query });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(payload));
      };
      const next = injected.shift();
      if (next !== undefined) {
        send(next.status, next.body ?? { errors: [{ message: "an injected failure mentioning lin_api_secretvalue0123456789" }] }, next.headers);
        return;
      }
      if (request.headers.authorization !== TOKEN && request.headers.authorization !== `Bearer ${TOKEN}`) {
        send(400, { errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error" } }] });
        return;
      }
      const variables = body.variables ?? {};
      if (body.query.includes("viewer")) {
        send(200, { data: { viewer: { id: "me" } } });
      } else if (body.query.includes("issue(id:")) {
        const found = issues.find((issue) => issue.identifier === variables["id"]);
        send(200, found === undefined ? { errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input" } }] } : { data: { issue: issueJson(found) } });
      } else if (body.query.includes("issues(")) {
        const filter = z.looseObject({ state: z.looseObject({ id: z.looseObject({ in: z.array(z.string()) }) }).optional() }).parse(variables["filter"]);
        const wanted = filter.state?.id.in;
        const matching = issues.filter((issue) => wanted === undefined || wanted.includes(issue.stateId));
        const after = variables["after"];
        const nodes = after === "cursor-1" ? matching.slice(2) : matching.slice(0, 2);
        send(200, {
          data: { issues: { nodes: nodes.map(issueJson), pageInfo: { hasNextPage: after !== "cursor-1" && matching.length > 2, endCursor: "cursor-1" } } },
        });
      } else if (body.query.includes("issueUpdate")) {
        const found = issues.findIndex((issue) => issue.id === variables["id"]);
        const current = issues[found];
        if (current !== undefined) {
          issues[found] = { ...current, stateId: z.string().parse(variables["stateId"]) };
        }
        send(200, { data: { issueUpdate: { success: found !== -1 } } });
      } else if (body.query.includes("commentCreate")) {
        comments.push({ issueId: z.string().parse(variables["issueId"]), body: z.string().parse(variables["body"]) });
        send(200, { data: { commentCreate: { success: true, comment: { id: `comment-${String(comments.length)}` } } } });
      } else if (body.query.includes("attachmentLinkGitHubPR")) {
        links.push(z.string().parse(variables["url"]));
        send(200, { data: { attachmentLinkGitHubPR: { success: true } } });
      } else {
        send(400, { errors: [{ message: "unknown query" }] });
      }
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/graphql`,
    comments,
    links,
    seen,
    injected,
    issues,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

let suiteFake: Awaited<ReturnType<typeof startFake>> | undefined;
defineTrackerContractSuite({
  name: "linear, against a fake Linear",
  create: async () => {
    suiteFake = await startFake();
    return {
      adapter: new LinearAdapter({ auth: { kind: "api-key", token: TOKEN }, apiUrl: suiteFake.url }),
      fixture: {},
      dispose: () => suiteFake?.close() ?? Promise.resolve(),
    };
  },
});

const key = (value: string) => ticketKeySchema.parse(value);
const board = { externalId: "team-1" };

describe("the Linear adapter", () => {
  let fake: Awaited<ReturnType<typeof startFake>>;
  const context = memoryAdapterContext();
  let adapter: LinearAdapter;
  beforeAll(async () => {
    fake = await startFake();
    adapter = new LinearAdapter({ auth: { kind: "api-key", token: TOKEN }, apiUrl: fake.url }, context);
  });
  afterAll(async () => {
    await fake.close();
  });

  it("is healthy with a good key, and down with a bad one", async () => {
    expect(await adapter.health()).toEqual({ status: "ok" });
    const bad = new LinearAdapter({ auth: { kind: "api-key", token: "lin_api_wrong" }, apiUrl: fake.url });
    expect(await bad.health()).toMatchObject({ status: "down" });
  });

  it("sends an API key as it is, and an OAuth token as a bearer", async () => {
    await adapter.health();
    await new LinearAdapter({ auth: { kind: "oauth", token: TOKEN }, apiUrl: fake.url }).health();
    expect(fake.seen.at(-2)?.authorization).toBe(TOKEN);
    expect(fake.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads a ticket by its key, with the priority and parent in ostra's terms", async () => {
    const first = await adapter.getTicket(board, key("OST-1"));
    expect(first).toMatchObject({
      ok: true,
      value: { key: "OST-1", title: "First", status: { id: "s1", name: "Todo" }, priority: 2, parentKey: null, updatedAt: Date.parse("2026-11-18T10:00:00.000Z") },
    });
    // The ticket's text comes back as data, exactly as it is.
    expect(first.ok && first.value.description).toBe("Do `rm -rf /` $(whoami)");
    expect(await adapter.getTicket(board, key("OST-2"))).toMatchObject({ ok: true, value: { priority: null, parentKey: "OST-1" } });
    expect(await adapter.getTicket(board, key("OST-99"))).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("lists tickets a page at a time, and filters by status", async () => {
    const first = await adapter.listTickets({ board });
    expect(first.ok && first.value.tickets.map((ticket) => ticket.key)).toEqual(["OST-1", "OST-2"]);
    expect(first.ok && first.value.nextCursor).toBe("cursor-1");
    const second = await adapter.listTickets({ board, cursor: "cursor-1" });
    expect(second.ok && second.value.tickets.map((ticket) => ticket.key)).toEqual(["OST-3"]);
    expect(second.ok && second.value.nextCursor).toBeNull();
    const done = await adapter.listTickets({ board, statusIds: ["s3"] });
    expect(done.ok && done.value.tickets.map((ticket) => ticket.key)).toEqual(["OST-3"]);
  });

  it("moves a ticket, comments on it and links a PR", async () => {
    expect(await adapter.updateStatus(board, key("OST-1"), "s2")).toEqual({ ok: true, value: undefined });
    expect(fake.issues.find((issue) => issue.identifier === "OST-1")?.stateId).toBe("s2");
    expect(await adapter.comment(board, key("OST-1"), "Opened a PR: **done**")).toEqual({ ok: true, value: { commentId: "comment-1" } });
    expect(fake.comments).toEqual([{ issueId: "uuid-1", body: "Opened a PR: **done**" }]);
    expect(await adapter.linkPullRequest(board, key("OST-1"), "https://github.com/ostra-test/test1/pull/7")).toEqual({ ok: true, value: undefined });
    expect(fake.links).toEqual(["https://github.com/ostra-test/test1/pull/7"]);
    expect(await adapter.comment(board, key("OST-99"), "x")).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("maps failures to typed errors, in its own words", async () => {
    fake.injected.push({ status: 429, headers: { "retry-after": "30" }, body: { errors: [{ message: "Rate limited", extensions: { type: "ratelimited" } }] } });
    expect(await adapter.getTicket(board, key("OST-1"))).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 30_000 } });
    fake.injected.push({ status: 503, body: { errors: [{ message: "down" }] } });
    expect(await adapter.getTicket(board, key("OST-1"))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const unreachable = new LinearAdapter({ auth: { kind: "api-key", token: TOKEN }, apiUrl: "http://127.0.0.1:1/graphql" });
    expect(await unreachable.getTicket(board, key("OST-1"))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("keeps the token and Linear's messages out of every error and log line", async () => {
    fake.injected.push({ status: 400 });
    const failed = await adapter.getTicket(board, key("OST-1"));
    const bad = await new LinearAdapter({ auth: { kind: "api-key", token: "lin_api_wrongtokenvalue0123456789" }, apiUrl: fake.url }, context).getTicket(board, key("OST-1"));
    const everything = JSON.stringify([failed, bad, context.logger.records]);
    expect(everything).not.toContain("lin_api");
    expect(everything).not.toContain("injected failure");
    expect(everything).not.toContain("Authentication required");
  });

  it("declares what it has: sub-issues, and no agent sessions or status graph yet", () => {
    expect(adapter.capabilities).toEqual({ agentSessions: false, subIssues: true, statusGraph: false });
  });
});
