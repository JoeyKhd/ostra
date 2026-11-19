import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PrepareLaunchInput } from "@ostra/adapter-sdk";
import { FakeAgentAdapter, fakeMarker, memoryNoteFixtures } from "@ostra/adapter-sdk/testing";
import { noteIdSchema } from "@ostra/protocol";
import type { TaskSpec, TaskSpecMemory } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_TOKEN, harnessAgents, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { createAgentRegistry } from "./agents.ts";

// Ticket 20 (milestone 4, F-110, F-111): the memory block at launch and the sidecar's memory tools,
// through the whole task host on `host` with the scripted fake agent, which calls the tools over
// MCP as a real agent does. The fake server plays core's memory endpoints by the protocol's schemas.

let shared: Shared;
const harnesses: Harness[] = [];

beforeAll(async () => {
  shared = await startShared("memory");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
}, 120_000);

const [pnpmNote, branchNote] = memoryNoteFixtures;
if (pnpmNote === undefined || branchNote === undefined) {
  throw new Error("the fixture has two notes");
}

const BLOCK = [
  "## Project memory",
  "",
  "These are the organization's and the project's approved notes.",
  `- Always: ${branchNote.title} (project note)`,
  `- ${pnpmNote.noteId} (command): ${pnpmNote.title}`,
  "Search these with memory_search and read one with memory_read.",
].join("\n");

const memoryOf = (tools: boolean): TaskSpecMemory => ({
  block: BLOCK,
  indexNoteIds: [pnpmNote.noteId],
  alwaysNoteIds: [branchNote.noteId],
  omitted: 0,
  tools,
});

/** A runner whose fake agent's launches are recorded, MCP bearer included. */
const runner = async (): Promise<{ readonly h: Harness; readonly mcp: PrepareLaunchInput["mcp"][] }> => {
  const mcp: PrepareLaunchInput["mcp"][] = [];
  const agents = createAgentRegistry({
    ...harnessAgents,
    "fake-acp-agent-rich": (driver) => {
      const agent = new FakeAgentAdapter("rich", driver);
      const prepare = agent.prepareLaunch.bind(agent);
      agent.prepareLaunch = (input) => {
        mcp.push(input.mcp);
        return prepare(input);
      };
      return agent;
    },
  });
  const h = await startHarness(shared, { agents });
  h.server.memory.notes.push(pnpmNote, branchNote);
  harnesses.push(h);
  return { h, mcp };
};

const said = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join("\n");

/** Every file under a folder, read as text. */
const filesUnder = async (root: string): Promise<{ readonly file: string; readonly text: string }[]> => {
  const out: { readonly file: string; readonly text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push({ file: full, text: await readFile(full, "latin1") });
      }
    }
  };
  await walk(root);
  return out;
};

const listTools = async (url: string, bearer: string): Promise<string[]> => {
  const client = new Client({ name: "ostra-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
};

describe("the memory block at launch (F-110)", () => {
  it("F-110: the spec's memory block reaches the fake agent, and memory.used reports the always and index notes once", async () => {
    const { h } = await runner();
    const { spec } = h.taskFor(fakeMarker("instructions"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    // The agent read the block, as the adapter wrote it in its config folder.
    for (const line of BLOCK.split("\n").filter((each) => each !== "")) {
      expect(said(h, spec)).toContain(line);
    }
    // No repo holds it: the checkout's tree is the base's.
    const workspace = path.join(h.dataDir, "tasks", spec.taskId, "workspace");
    for (const { text } of await filesUnder(path.join(workspace, "test1"))) {
      expect(text).not.toContain(pnpmNote.title);
    }
    expect(h.ofKind(spec, "memory.used")).toEqual([
      { kind: "memory.used", noteIds: [branchNote.noteId], via: "always" },
      { kind: "memory.used", noteIds: [pnpmNote.noteId], via: "index" },
    ]);
    // Before the first turn: what the session started with.
    const kinds = h.kinds(spec);
    expect(kinds.indexOf("memory.used")).toBeLessThan(kinds.indexOf("turn.started"));
  }, 120_000);

  it("F-110: a memory_read reports memory.used as a read, and the note reaches the agent", async () => {
    const { h } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-read", pnpmNote.noteId), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain(pnpmNote.body);
    expect(h.ofKind(spec, "memory.used").filter((event) => event.via === "read")).toEqual([{ kind: "memory.used", noteIds: [pnpmNote.noteId], via: "read" }]);
    expect(h.server.memory.calls.map((call) => call.endpoint)).toEqual(["read"]);
    // A note that isn't there: core's words, and no use reported.
    h.steer(spec, fakeMarker("memory-read", "note-missing"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(said(h, spec)).toContain("There's no approved memory note with that ID in this project.");
    expect(h.ofKind(spec, "memory.used").filter((event) => event.via === "read")).toHaveLength(1);
  }, 120_000);

  it("F-110: with the spec's tools off, the sidecar offers no memory tool and the agent gets the block alone", async () => {
    const { h, mcp } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-tools"), { memory: memoryOf(false) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain("memory tools: none");
    // Asked directly, with the agent's own bearer: the PR tool, and nothing of memory.
    const [launch] = mcp;
    if (launch?.bearer === undefined) throw new Error("no MCP bearer in the launch");
    expect(await listTools(launch.url, launch.bearer)).toEqual(["set_pull_request_text"]);
    expect(h.ofKind(spec, "memory.used").map((event) => event.via)).toEqual(["always", "index"]);
    expect(h.server.memory.calls).toEqual([]);
  }, 120_000);

  it("F-110: with the tools on, the sidecar offers memory_search, memory_read and memory_propose beside the PR tool", async () => {
    const { h, mcp } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-tools"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain("memory tools: set_pull_request_text, memory_search, memory_read, memory_propose");
    const [launch] = mcp;
    if (launch?.bearer === undefined) throw new Error("no MCP bearer in the launch");
    // The agent's bearer is the sidecar's own, never the token core takes.
    expect(launch.bearer).not.toBe(ACCESS_TOKEN);
  }, 120_000);

  it("F-110: a spec without memory gets no block, no memory.used and no memory tools", async () => {
    const { h } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-tools"));
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain("memory tools: none");
    expect(h.ofKind(spec, "memory.used")).toEqual([]);
  }, 120_000);
});

describe("memory proposals through the sidecar (F-111)", () => {
  it("F-111: a proposal reaches the fake core with the task's token, and the agent never sees the token or the proposal", async () => {
    const { h, mcp } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-propose", "Run the linter before the tests"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(h.server.memory.proposals).toEqual([
      {
        taskId: spec.taskId,
        bearer: ACCESS_TOKEN,
        input: { title: "Run the linter before the tests", body: "Proposed by the fake agent.", kind: "convention", scope: "project", relatesTo: null, relation: null },
      },
    ]);
    expect(said(h, spec)).toContain("Proposed as proposal-1. A member approves it before any agent sees it");
    // The proposal isn't a note: a search in the next turn doesn't find it.
    h.steer(spec, fakeMarker("memory-search", "linter"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(said(h, spec)).toContain("No approved memory note matches that search.");
    // The token core took is nowhere the agent can reach: not in its launch, its bearer or its environment.
    const [launch] = mcp;
    expect(JSON.stringify(launch)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(h.launches)).not.toContain(ACCESS_TOKEN);
    expect(h.server.memory.calls.every((call) => call.bearer === ACCESS_TOKEN && call.taskId === spec.taskId)).toBe(true);
  }, 120_000);

  it("F-111: a secret refusal's words reach the agent, and nothing is recorded", async () => {
    const { h } = await runner();
    h.server.memory.refusals.push({ code: "secret-found", found: ["a GitHub token", "a model-control token"] });
    const { spec } = h.taskFor(fakeMarker("memory-propose", "The deploy token"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain("The proposal was refused: it holds a GitHub token, a model-control token.");
    expect(h.server.memory.proposals).toEqual([]);
  }, 120_000);

  it("F-111: with memory down, the agent reads that memory is unavailable and the session goes on", async () => {
    const { h } = await runner();
    h.server.memory.down = true;
    const { spec } = h.taskFor(fakeMarker("memory-search", "pnpm"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(said(h, spec)).toContain("Memory is unavailable right now");
    h.server.memory.down = false;
    h.steer(spec, fakeMarker("memory-search", "pnpm install"));
    await h.waitForKind(spec, "session.saved", 2);
    expect(said(h, spec)).toContain(`${pnpmNote.noteId} (command, organization): ${pnpmNote.title}`);
  }, 120_000);
});

describe("the task's token (ticket 20)", () => {
  it("F-110: the task's token is in no file of the workspace or the agent's folders, in no event and in no log line, after every memory tool ran", async () => {
    const { h } = await runner();
    const { spec } = h.taskFor(fakeMarker("memory-search", "pnpm install"), { memory: memoryOf(true) });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    h.steer(spec, fakeMarker("memory-read", pnpmNote.noteId));
    await h.waitForKind(spec, "session.saved", 2);
    h.steer(spec, fakeMarker("memory-propose", "Keep the README short"));
    await h.waitForKind(spec, "session.saved", 3);
    expect(h.server.memory.calls.map((call) => call.endpoint)).toEqual(["search", "read", "propose"]);
    const files = await filesUnder(path.join(h.dataDir, "tasks", spec.taskId));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(({ text }) => text.includes(ACCESS_TOKEN)).map(({ file }) => file)).toEqual([]);
    expect(JSON.stringify(h.eventsOf(spec))).not.toContain(ACCESS_TOKEN);
    // Never logged: the token, the query, a note's text, a proposal's text.
    const logged = JSON.stringify(h.logs);
    for (const secret of [ACCESS_TOKEN, "pnpm install", pnpmNote.body, "Keep the README short"]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain("memory searched");
    expect(logged).toContain("memory note read");
    expect(logged).toContain("memory proposed");
    expect(noteIdSchema.safeParse(pnpmNote.noteId).success).toBe(true);
  }, 120_000);
});
