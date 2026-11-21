import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createServer } from "node:http";
import { proposalIdSchema, repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemoryProposalRequest, MemoryProposalResponse, MemorySearchRequest, TaskEventOf } from "@ostra/protocol";
import { memoryNoteFixture } from "@ostra/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { memoryLink } from "../task-host/server-link.ts";
import type { MemoryCallResult, MemoryLink } from "../task-host/server-link.ts";
import { MEMORY_PROPOSE_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, MEMORY_UNAVAILABLE, PR_BODY_MAX, SET_PR_TEXT_TOOL, startMcpTools } from "./mcp-tools.ts";
import type { McpTools } from "./mcp-tools.ts";

// Ticket 20's "done when": a real MCP client lists the tool, calls it, and the event comes out.

const repoId = repoIdSchema.parse("repo-1");
const otherRepoId = repoIdSchema.parse("repo-2");
const template = "## What\n\n## Why\n\n## How it was tested\n";

let tools: McpTools | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await tools?.close();
  tools = undefined;
});

const start = async (): Promise<{ readonly tools: McpTools; readonly events: TaskEventOf<"pr.text_set">[]; readonly logs: LogRecord[] }> => {
  const events: TaskEventOf<"pr.text_set">[] = [];
  const logs: LogRecord[] = [];
  tools = await startMcpTools({
    taskId: taskIdSchema.parse("task-mcp"),
    repos: [
      { repoId, fullName: repoFullNameSchema.parse("ostra-test/test1"), prTemplate: template },
      { repoId: otherRepoId, fullName: repoFullNameSchema.parse("ostra-test/test2"), prTemplate: null },
    ],
    taskTitle: "Add a short CONTRIBUTING.md",
    listenHost: "127.0.0.1",
    logger: createLogger((record) => logs.push(record)),
    onPrText: (event) => events.push(event),
  });
  return { tools, events, logs };
};

const connect = async (server: McpTools, bearer: string = server.bearer): Promise<Client> => {
  const client = new Client({ name: "ostra-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  clients.push(client);
  return client;
};

const textOf = (result: unknown): string => {
  const content: unknown = Reflect.get(Object(result), "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = Reflect.get(Object(first), "text");
  return typeof text === "string" ? text : "";
};

describe("ostra's MCP tools", () => {
  it("F-030/c4, F-078/c1: lists the tool, whose description carries the repo's PR template and the title rule", async () => {
    const { tools: server } = await start();
    const client = await connect(server);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([SET_PR_TEXT_TOOL]);
    const [tool] = listed.tools;
    expect(tool?.description).toContain("ostra-test/test1: has a pull request template. Follow it");
    expect(tool?.description).toContain("## How it was tested");
    expect(tool?.description).toContain("ostra-test/test2: no pull request template");
    expect(tool?.description).toContain("close to the task's own title");
    expect(tool?.inputSchema.required).toEqual(["repo", "title", "body"]);
  });

  it("F-030/c4: emits pr.text_set for a call naming one of the task's repos", async () => {
    const { tools: server, events } = await start();
    const client = await connect(server);
    const result = await client.callTool({
      name: SET_PR_TEXT_TOOL,
      arguments: { repo: "ostra-test/test1", title: "Add a short\nCONTRIBUTING.md", body: "## What\nA guide.\n" },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Saved");
    expect(events).toEqual([{ kind: "pr.text_set", repoId, title: "Add a short CONTRIBUTING.md", body: "## What\nA guide.\n" }]);
  });

  it("refuses an unknown repo, an oversized body and an unknown field, and emits nothing", async () => {
    const { tools: server, events } = await start();
    const client = await connect(server);
    const unknown = await client.callTool({ name: SET_PR_TEXT_TOOL, arguments: { repo: "someone/else", title: "x", body: "y" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("isn't one of this task's repos");
    const oversized = await client.callTool({
      name: SET_PR_TEXT_TOOL,
      arguments: { repo: "ostra-test/test1", title: "x", body: "y".repeat(PR_BODY_MAX + 1) },
    });
    expect(oversized.isError).toBe(true);
    const extra = await client.callTool({ name: SET_PR_TEXT_TOOL, arguments: { repo: "ostra-test/test1", title: "x", body: "y", base: "main" } });
    expect(extra.isError).toBe(true);
    expect(events).toEqual([]);
  });

  it("answers a wrong bearer, and none, with 401", async () => {
    const { tools: server, logs } = await start();
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const wrong = await fetch(server.url, { method: "POST", headers: { ...headers, authorization: "Bearer not-the-task-bearer" }, body: JSON.stringify(initialize) });
    expect(wrong.status).toBe(401);
    const none = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(initialize) });
    expect(none.status).toBe(401);
    await expect(connect(server, "wrong")).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toContain(server.bearer);
  });
});

// Milestone 4 (ticket 20, F-110, F-111): the memory tools, against a stand-in for core's endpoints.

const note = memoryNoteFixture;

type MemoryCalls = { search: MemorySearchRequest[]; read: string[]; propose: MemoryProposalRequest[] };

const memoryLinkStub = (
  answers: { readonly propose?: MemoryCallResult<MemoryProposalResponse>; readonly down?: boolean } = {},
): { readonly link: MemoryLink; readonly calls: MemoryCalls } => {
  const calls: MemoryCalls = { search: [], read: [], propose: [] };
  const down = { ok: false as const, failure: { kind: "unavailable" as const } };
  return {
    calls,
    link: {
      search: (_taskId, request) => {
        calls.search.push(request);
        return Promise.resolve(
          answers.down === true
            ? down
            : { ok: true, value: { results: [{ noteId: note.noteId, title: note.title, line: "Use `pnpm test` at the repo root", kind: note.kind, scope: note.scope }] } },
        );
      },
      read: (_taskId, noteId) => {
        calls.read.push(noteId);
        if (answers.down === true) return Promise.resolve(down);
        return Promise.resolve(
          noteId === note.noteId || noteId === "note-other"
            ? { ok: true, value: { ...note, noteId } }
            : { ok: false, failure: { kind: "refused", status: 404, message: "There's no approved memory note with that ID." } },
        );
      },
      propose: (_taskId, request) => {
        calls.propose.push(request);
        return Promise.resolve(answers.down === true ? down : (answers.propose ?? { ok: true, value: { proposalId: proposalIdSchema.parse("proposal-7") } }));
      },
    },
  };
};

const startWithMemory = async (
  link: MemoryLink,
): Promise<{ readonly tools: McpTools; readonly used: TaskEventOf<"memory.used">[]; readonly logs: LogRecord[] }> => {
  const used: TaskEventOf<"memory.used">[] = [];
  const logs: LogRecord[] = [];
  tools = await startMcpTools({
    taskId: taskIdSchema.parse("task-mcp"),
    repos: [{ repoId, fullName: repoFullNameSchema.parse("ostra-test/test1"), prTemplate: null }],
    taskTitle: "Add a short CONTRIBUTING.md",
    listenHost: "127.0.0.1",
    logger: createLogger((record) => logs.push(record)),
    onPrText: () => undefined,
    memory: { link, onUsed: (event) => used.push(event) },
  });
  return { tools, used, logs };
};

describe("ostra's memory tools (ticket 20)", () => {
  it("F-110/c5: a read of a note this turn's search found is memory.used via search, and via read after the turn ends", async () => {
    const { link, calls } = memoryLinkStub();
    const { tools: server, used } = await startWithMemory(link);
    const client = await connect(server);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([SET_PR_TEXT_TOOL, MEMORY_SEARCH_TOOL, MEMORY_READ_TOOL, MEMORY_PROPOSE_TOOL]);
    const found = await client.callTool({ name: MEMORY_SEARCH_TOOL, arguments: { query: "pnpm test" } });
    expect(textOf(found)).toContain(`${note.noteId} (command, project): ${note.title}`);
    // The agent named no limit: the default, within the protocol's.
    expect(calls.search).toEqual([{ query: "pnpm test", limit: 5 }]);
    await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: note.noteId } });
    // A note no search of the turn found is a read.
    await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: "note-other" } });
    server.turnStarted();
    const read = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: note.noteId } });
    expect(textOf(read)).toContain(note.body);
    expect(used).toEqual([
      { kind: "memory.used", noteIds: [note.noteId], via: "search" },
      { kind: "memory.used", noteIds: ["note-other"], via: "read" },
      { kind: "memory.used", noteIds: [note.noteId], via: "read" },
    ]);
  });

  it("F-110/c2: input the protocol's schemas refuse never reaches core, and a refusal is the tool's error text", async () => {
    const { link, calls } = memoryLinkStub();
    const { tools: server, used } = await startWithMemory(link);
    const client = await connect(server);
    const long = await client.callTool({ name: MEMORY_SEARCH_TOOL, arguments: { query: "x".repeat(501) } });
    expect(long.isError).toBe(true);
    const many = await client.callTool({ name: MEMORY_SEARCH_TOOL, arguments: { query: "pnpm", limit: 21 } });
    expect(many.isError).toBe(true);
    const extra = await client.callTool({ name: MEMORY_SEARCH_TOOL, arguments: { query: "pnpm", scope: "all" } });
    expect(extra.isError).toBe(true);
    const twoLines = await client.callTool({ name: MEMORY_PROPOSE_TOOL, arguments: { title: "a\nb", body: "x", kind: "command", scope: "project" } });
    expect(twoLines.isError).toBe(true);
    const halfRelation = await client.callTool({
      name: MEMORY_PROPOSE_TOOL,
      arguments: { title: "a", body: "x", kind: "command", scope: "project", relation: "refines" },
    });
    expect(textOf(halfRelation)).toContain("relatesTo and relation go together");
    expect(calls).toEqual({ search: [], read: [], propose: [] });
    const missing = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: "note-gone" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("There's no approved memory note with that ID.");
    expect(used).toEqual([]);
  });

  it("F-111/c1: a proposal goes to core as the protocol's request, and each refusal's words reach the agent", async () => {
    const { link, calls } = memoryLinkStub();
    const { tools: server } = await startWithMemory(link);
    const client = await connect(server);
    const proposed = await client.callTool({
      name: MEMORY_PROPOSE_TOOL,
      arguments: { title: "Tests run with vitest", body: "`pnpm test` runs vitest.", kind: "command", scope: "project", relatesTo: note.noteId, relation: "refines" },
    });
    expect(textOf(proposed)).toContain("Proposed as proposal-7");
    expect(calls.propose).toEqual([
      { title: "Tests run with vitest", body: "`pnpm test` runs vitest.", kind: "command", scope: "project", relatesTo: note.noteId, relation: "refines" },
    ]);
    const refusals: [MemoryProposalResponse, string][] = [
      [{ code: "secret-found", found: ["a GitHub token"] }, "it holds a GitHub token"],
      [{ code: "limit-reached" }, "this task has made the 20 proposals a task may make"],
      [{ code: "invalid" }, "core couldn't read it as a note"],
    ];
    for (const [value, words] of refusals) {
      for (const open of clients.splice(0)) {
        await open.close();
      }
      await tools?.close();
      const again = await startWithMemory(memoryLinkStub({ propose: { ok: true, value } }).link);
      const other = await connect(again.tools);
      const result = await other.callTool({ name: MEMORY_PROPOSE_TOOL, arguments: { title: "t", body: "b", kind: "term", scope: "organization" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(words);
    }
  });

  it("F-110/c2: with core unreachable, every tool says memory is unavailable, and no query or note text is logged", async () => {
    const { link } = memoryLinkStub({ down: true });
    const { tools: server, logs, used } = await startWithMemory(link);
    const client = await connect(server);
    const calls: [string, Record<string, unknown>][] = [
      [MEMORY_SEARCH_TOOL, { query: "the secret query" }],
      [MEMORY_READ_TOOL, { noteId: note.noteId }],
      [MEMORY_PROPOSE_TOOL, { title: "A private title", body: "A private body", kind: "gotcha", scope: "project" }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(MEMORY_UNAVAILABLE);
    }
    expect(used).toEqual([]);
    const logged = JSON.stringify(logs);
    expect(logged).toContain("memory call failed");
    for (const secret of ["the secret query", "A private title", "A private body"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("F-110/c2: the real link answers unavailable for a server that isn't there, and core's words for a 404", async () => {
    const tokens = { get: () => Promise.resolve({ ok: true as const, token: "ostra-task-t", expiresAt: Date.now() + 60_000 }), invalidate: () => undefined };
    const nowhere = memoryLink({ serverUrl: "http://127.0.0.1:9", tokens });
    expect(await nowhere.search(taskIdSchema.parse("task-mcp"), { query: "pnpm", limit: 5 })).toEqual({ ok: false, failure: { kind: "unavailable" } });
    const server = createServer((request, response) => {
      request.resume();
      const allowed = request.headers.authorization === "Bearer ostra-task-t";
      response
        .writeHead(allowed ? 404 : 401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "not-found", message: "No such note here." } }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const real = memoryLink({ serverUrl: `http://127.0.0.1:${String(port)}`, tokens });
      expect(await real.read(taskIdSchema.parse("task-mcp"), note.noteId)).toEqual({ ok: false, failure: { kind: "refused", status: 404, message: "No such note here." } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

// 2026-11-21 (ADR 0044, borrowed from claude-mem): `memory_read` reads several notes in one call.

describe("memory_read of several notes (F-110/c9)", () => {
  it("F-110/c9: lists noteIds beside noteId, and its description tells the agent to read several in one call", async () => {
    const { link } = memoryLinkStub();
    const { tools: server } = await startWithMemory(link);
    const client = await connect(server);
    const read = (await client.listTools()).tools.find((tool) => tool.name === MEMORY_READ_TOOL);
    expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual(["noteId", "noteIds"]);
    expect(read?.inputSchema.required ?? []).toEqual([]);
    expect(read?.description).toContain("name them all in noteIds (up to 10) in one call");
    const search = (await client.listTools()).tools.find((tool) => tool.name === MEMORY_SEARCH_TOOL);
    expect(search?.description).toContain("with memory_read, all in one call");
  });

  it("F-110/c9: reads each note through core in one call, says which weren't found, and reports the reads by how the agent found them", async () => {
    const { link, calls } = memoryLinkStub();
    const { tools: server, used, logs } = await startWithMemory(link);
    const client = await connect(server);
    await client.callTool({ name: MEMORY_SEARCH_TOOL, arguments: { query: "pnpm test" } });
    const result = await client.callTool({
      name: MEMORY_READ_TOOL,
      arguments: { noteIds: [note.noteId, "note-other", "note-gone", "not an id", note.noteId] },
    });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("Read 2 of the 4 memory notes asked for.");
    expect(text).toContain(`An approved project note (command), ${note.noteId}, version 3.`);
    expect(text).toContain("An approved project note (command), note-other, version 3.");
    expect(text.split(note.body)).toHaveLength(3);
    expect(text).toContain("Not found: note-gone, not an id. None of these is an approved memory note of this project or its organization.");
    // Every ID that is one went to core's endpoint for one note, which checks it against the task's scope; a repeat went once.
    expect([...calls.read].sort()).toEqual(["note-gone", note.noteId, "note-other"].sort());
    expect(used).toEqual([
      { kind: "memory.used", noteIds: [note.noteId], via: "search" },
      { kind: "memory.used", noteIds: ["note-other"], via: "read" },
    ]);
    // Counts only: no title, no body, no ID the agent made up.
    const logged = JSON.stringify(logs);
    expect(logged).toContain("memory notes read");
    for (const text of [note.title, note.body, "not an id"]) {
      expect(logged).not.toContain(text);
    }
  });

  it("F-110/c9: a note of another scope reads exactly as one that doesn't exist", async () => {
    const { link } = memoryLinkStub();
    const { tools: server, used } = await startWithMemory(link);
    const client = await connect(server);
    // The stand-in answers 404 for both, as core does (`readNote` scopes the query): the words can't tell them apart.
    const other = textOf(await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: [note.noteId, "note-of-another-org"] } }));
    const none = textOf(await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: [note.noteId, "note-never-written"] } }));
    expect(other.replace("note-of-another-org", "<id>")).toBe(none.replace("note-never-written", "<id>"));
    expect(used.flatMap((event) => event.noteIds)).toEqual([note.noteId, note.noteId]);
  });

  it("F-110/c9: the one-ID form answers as before, and more than 10 IDs, none, or none found is the tool's error", async () => {
    const { link, calls } = memoryLinkStub();
    const { tools: server, used } = await startWithMemory(link);
    const client = await connect(server);
    const one = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: note.noteId } });
    expect(textOf(one)).toBe([`# ${note.title}`, "", `An approved project note (command), ${note.noteId}, version 3.`, "", note.body].join("\n"));
    // The same ID twice, or once in each field, is one note.
    const twice = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteId: note.noteId, noteIds: [note.noteId] } });
    expect(textOf(twice)).toBe(textOf(one));
    const eleven = Array.from({ length: 11 }, (_, index) => `note-${String(index)}`);
    const tooMany = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: eleven } });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toBe("Name the notes to read: one ID in noteId, or up to 10 in noteIds.");
    const empty = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: [] } });
    expect(empty.isError).toBe(true);
    const noArguments = await client.callTool({ name: MEMORY_READ_TOOL, arguments: {} });
    expect(noArguments.isError).toBe(true);
    expect(calls.read).toEqual([note.noteId, note.noteId]);
    const noneFound = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: ["note-gone", "note-lost"] } });
    expect(noneFound.isError).toBe(true);
    expect(textOf(noneFound)).toContain("Not found: note-gone, note-lost.");
    expect(used).toHaveLength(2);
  });

  it("F-110/c9: with core unreachable, a read of several says memory is unavailable; with part of it down, it reads the rest", async () => {
    const { link } = memoryLinkStub({ down: true });
    const { tools: server, used } = await startWithMemory(link);
    const client = await connect(server);
    const down = await client.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: [note.noteId, "note-other"] } });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe(MEMORY_UNAVAILABLE);
    expect(used).toEqual([]);
    for (const open of clients.splice(0)) {
      await open.close();
    }
    await tools?.close();
    // One read times out: the other note still comes back, and the one that didn't is named.
    const { link: healthy } = memoryLinkStub();
    const flaky: MemoryLink = {
      ...healthy,
      read: (taskId, noteId) => (noteId === "note-other" ? Promise.resolve({ ok: false, failure: { kind: "unavailable" } }) : healthy.read(taskId, noteId)),
    };
    const again = await startWithMemory(flaky);
    const other = await connect(again.tools);
    const part = textOf(await other.callTool({ name: MEMORY_READ_TOOL, arguments: { noteIds: [note.noteId, "note-other"] } }));
    expect(part).toContain("Read 1 of the 2 memory notes asked for.");
    expect(part).toContain("Not read: note-other. Memory couldn't answer for these right now");
    expect(again.used).toEqual([{ kind: "memory.used", noteIds: [note.noteId], via: "read" }]);
  });
});
