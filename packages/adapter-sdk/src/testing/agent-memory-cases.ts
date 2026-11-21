import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { expect, it } from "vitest";

import type { AgentAdapter, AgentLaunch, LaunchMemory, PrepareLaunchInput } from "../agent/base.ts";
import type { AgentFixture } from "./agent-suite.ts";
import { memoryNoteFixtures, memoryToolNames } from "./fake-memory-core.ts";
import type { FakeMemoryCore } from "./fake-memory-core.ts";

// Milestone 4 (ticket 02, ADR 0044, ADR 0035): the agent contract suite's memory cases, the repos
// side by side, and the canary. The memory block reaches the agent with the profile's instructions
// and no repo; an `mcp` agent is offered the three memory tools and each call round-trips through
// the fake core; an `index-only` one gets the block and no tool. A task's repos sit side by side
// under the workspace's root, where the agent works, and its instructions name them. And ADR 0035's
// positive control: a shell call that reads a file outside the workspace shows in the event log,
// with its full input.

const run = promisify(execFile);

/** Prompts that make an agent show what it got of memory. Each says its answer as a message. */
export type AgentMemoryProbes = {
  /** The agent says its instructions, all of them. */
  readonly instructions: string;
  /** The agent names the memory tools ostra's MCP server offers it, or says it has none. */
  readonly tools: string;
  readonly search: (query: string) => string;
  readonly read: (noteId: string) => string;
  readonly propose: (title: string) => string;
  /** The fake core the fixture started: `launchInput.mcp` names its MCP server. Absent for an `index-only` agent. */
  readonly core?: () => FakeMemoryCore;
  /** At least two git repos, each a folder under `launchInput.workspaceDir`. */
  readonly repos: readonly string[];
};

/** ADR 0035's canary: a prompt that makes the agent run a shell command reading the absolute path given. */
export type AgentCanaryProbe = { readonly prompt: (absolutePath: string) => string };

/** The block core renders (ticket 06), as a launch carries it: the "always" notes, the index, the standing instruction. */
export const sampleMemoryBlock = (tools: boolean): string =>
  [
    "## Project memory",
    "Always:",
    ...memoryNoteFixtures.slice(0, 1).map((note) => `- ${note.title}: ${note.body}`),
    "Index:",
    ...memoryNoteFixtures.map((note) => `- ${note.noteId} (${note.kind}): ${note.title}`),
    tools
      ? "Search these with memory_search, read one with memory_read, and propose what the team should keep with memory_propose."
      : "These are the project's notes; ask a member for any you need in full.",
  ].join("\n");

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

export const defineAgentMemoryCases = (subject: Subject): void => {
  /** One session launched with `extra`, running `prompts` in turn: every turn's events, and the launch. */
  const runPrompts = async (
    extra: Partial<PrepareLaunchInput>,
    prompts: readonly string[],
  ): Promise<{ readonly texts: readonly string[]; readonly events: readonly TaskEvent[]; readonly launch: AgentLaunch }> => {
    const { adapter, fixture } = subject();
    const input: PrepareLaunchInput = { ...fixture.launchInput, ...extra };
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    const started = await fixture.start(prepared.value);
    const events: TaskEvent[] = [];
    const result = await adapter.startSession({
      taskId: input.taskId,
      sessionId: input.sessionId,
      io: started.io,
      cwd: input.workspaceDir,
      mcpServers: [],
      onEvents: (batch) => {
        events.push(...batch);
      },
      onPermission: () => Promise.resolve({ outcome: "cancelled" }),
      onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
    });
    if (!result.ok) {
      await started.stop();
      throw new Error(`startSession failed: ${result.error.message}`);
    }
    const texts: string[] = [];
    try {
      for (const [index, prompt] of prompts.entries()) {
        const before = events.length;
        const turn = await adapter.prompt(result.value, turnIdSchema.parse(`memory-turn-${String(index + 1)}`), { text: prompt, images: [] });
        if (!turn.ok) throw new Error(`the turn failed: ${turn.error.message}`);
        texts.push(textOf(events.slice(before)));
      }
    } finally {
      await adapter.close(result.value);
      await started.stop();
    }
    return { texts, events, launch: prepared.value };
  };

  const memoryProbe = (context: { readonly skip: () => void }): AgentMemoryProbes | undefined => {
    const value = subject().fixture.memory;
    if (value === undefined) context.skip();
    return value;
  };

  const memoryFor = (adapter: AgentAdapter): LaunchMemory => ({ block: sampleMemoryBlock(adapter.capabilities.memory === "mcp"), tools: adapter.capabilities.memory === "mcp" });

  const statusOf = async (repoDir: string): Promise<string> => (await run("git", ["status", "--porcelain"], { cwd: repoDir })).stdout;

  it("F-110: the memory block reaches the agent with the profile's instructions, in its config folder and in no repo", async (context) => {
    const probes = memoryProbe(context);
    if (probes === undefined) return;
    const { adapter, fixture } = subject();
    const memory = memoryFor(adapter);
    const repoDirs = probes.repos.map((repo) => path.join(fixture.launchInput.workspaceDir, repo));
    const { texts, launch } = await runPrompts({ instructions: "Keep the README short.", memory, repoDirs: probes.repos }, [probes.instructions]);
    const said = texts[0] ?? "";
    expect(said).toContain("Keep the README short.");
    for (const line of memory.block.split("\n")) {
      expect(said, line).toContain(line);
    }
    // The block lives in the task's config folder: no launch file is in a repo, and every repo is clean.
    for (const file of launch.files) {
      for (const repoDir of repoDirs) {
        expect(path.relative(repoDir, file.path).startsWith(".."), `${file.path} is outside ${repoDir}`).toBe(true);
      }
    }
    for (const repoDir of repoDirs) {
      expect(await statusOf(repoDir), `git status in ${repoDir}`).toBe("");
    }
  }, 60_000);

  it("F-110: an agent with MCP is offered memory_search, memory_read and memory_propose, and each call round-trips through the fake core", async (context) => {
    const probes = memoryProbe(context);
    const { adapter } = subject();
    if (probes === undefined || adapter.capabilities.memory !== "mcp") {
      context.skip();
      return;
    }
    const core = probes.core?.();
    if (core === undefined) throw new Error("an mcp agent's fixture starts the fake core");
    const [searched, read] = [memoryNoteFixtures[0], memoryNoteFixtures[1]];
    if (searched === undefined || read === undefined) throw new Error("the fixtures hold two notes");
    const before = { ...core.calls, proposals: core.proposals.length };
    const { texts, events } = await runPrompts({ memory: memoryFor(adapter) }, [
      probes.tools,
      probes.search("pnpm install"),
      probes.read(read.noteId),
      probes.propose("Run the linter before a commit"),
    ]);
    const [tools = "", search = "", readText = "", proposed = ""] = texts;
    for (const name of memoryToolNames) {
      expect(tools, name).toContain(name);
    }
    expect(search).toContain(searched.title);
    expect(search).toContain(searched.noteId);
    expect(readText).toContain(read.title);
    expect(readText).toContain(read.body);
    expect(proposed).toMatch(/proposal-\d+/);
    // Each went through core's endpoints, by the protocol's schemas.
    expect(core.calls.search - before.search).toBe(1);
    expect(core.calls.read - before.read).toBe(1);
    expect(core.calls.propose - before.propose).toBe(1);
    expect(core.proposals.at(-1)?.title).toBe("Run the linter before a commit");
    expect(core.proposals.length - before.proposals).toBe(1);
    // The event log shows each tool call, by its title or its input (an agent names an MCP tool in either).
    const called = events.flatMap((event) => (event.kind === "tool.called" ? [`${event.title} ${JSON.stringify(event.input)}`] : []));
    for (const name of memoryToolNames) {
      expect(called.some((input) => input.includes(name)), name).toBe(true);
    }
  }, 60_000);

  it("F-110: an agent without MCP gets the index and no tools", async (context) => {
    const probes = memoryProbe(context);
    const { adapter } = subject();
    if (probes === undefined || adapter.capabilities.memory !== "index-only") {
      context.skip();
      return;
    }
    const memory = memoryFor(adapter);
    expect(memory.tools).toBe(false);
    const { texts, events } = await runPrompts({ memory }, [probes.instructions, probes.tools, probes.search("pnpm install")]);
    const [instructions = "", tools = "", search = ""] = texts;
    for (const line of memory.block.split("\n")) {
      expect(instructions, line).toContain(line);
    }
    for (const name of memoryToolNames) {
      expect(tools, name).not.toContain(name);
    }
    expect(search).not.toContain(memoryNoteFixtures[0]?.title ?? "a note's title");
    expect(events.some((event) => event.kind === "tool.called" && `${event.title} ${JSON.stringify(event.input)}`.includes("memory_search"))).toBe(false);
  }, 60_000);

  it("F-098: two repos side by side, the agent at the workspace's root, its instructions naming both", async (context) => {
    const probes = memoryProbe(context);
    if (probes === undefined) return;
    expect(probes.repos.length).toBeGreaterThanOrEqual(2);
    const { fixture } = subject();
    const { texts, launch } = await runPrompts({ repoDirs: probes.repos }, [probes.instructions]);
    expect(path.resolve(launch.cwd)).toBe(path.resolve(fixture.launchInput.workspaceDir));
    for (const repo of probes.repos) {
      expect(texts[0], repo).toContain(repo);
      expect(await statusOf(path.join(fixture.launchInput.workspaceDir, repo))).toBe("");
    }
  }, 60_000);

  it("F-073: ADR 0035's canary: a shell call that reads a file outside the workspace is in the event log with its full input", async (context) => {
    const canary = subject().fixture.canary;
    if (canary === undefined) {
      context.skip();
      return;
    }
    const { fixture } = subject();
    const outside = await mkdtemp(path.join(tmpdir(), "ostra-canary-"));
    try {
      const file = path.join(outside, "canary.txt");
      const secret = `canary-${String(Date.now())}`;
      await writeFile(file, `${secret}\n`);
      expect(path.relative(fixture.launchInput.workspaceDir, file).startsWith("..")).toBe(true);
      const { events } = await runPrompts({}, [canary.prompt(file)]);
      const call = events.find((event) => event.kind === "tool.called" && event.toolKind === "execute" && JSON.stringify(event.input).includes(file.replaceAll("\\", "\\\\")));
      expect(call, "the shell call, with the canary's path in its input").toBeDefined();
      if (call?.kind !== "tool.called") return;
      const done = events.find((event) => event.kind === "tool.completed" && event.toolCallId === call.toolCallId);
      expect(JSON.stringify(done)).toContain(secret);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 60_000);
};
