import { appAddressName, appToolNames, ONE_ORIGIN_RULE, TAKE_SCREENSHOT_TOOL, turnIdSchema } from "@ostra/protocol";
import type { OstraToolSet, TakeScreenshotInput, TaskEvent } from "@ostra/protocol";
import { expect, it } from "vitest";

import type { AgentAdapter, LaunchApp, PrepareLaunchInput } from "../agent/base.ts";
import { sampleMemoryBlock } from "./agent-memory-cases.ts";
import type { AgentFixture } from "./agent-suite.ts";
import { fakeAttachmentId, fakeCoreToolNames } from "./fake-memory-core.ts";
import type { FakeMemoryCore } from "./fake-memory-core.ts";

// Milestone 8 (ticket 03, spec sections 5.2 and 6, ADR 0068): the agent contract suite's cases for
// the running app. The app tools (`start_app`, `show_preview`, `take_screenshot`, `record_app`) are
// listed for a task whose tool sets hold `app`, and absent otherwise; an agent's `take_screenshot`
// reaches ostra's server and its answer reaches the agent; the app's block reaches the agent's
// instructions for a task with app processes, and none without. An agent without MCP gets no app
// tools and a block that doesn't name them: its task's pictures are the ones ostra takes after each
// turn (the runner's, ticket 13), and the pane's.

/** Prompts and set-ups that make an agent show the app cases. */
export type AgentAppProbes = {
  /** Starts a fake core serving `tools`, and the launch's `mcp` that points the agent at it (as the team cases' `tools.start`). */
  readonly start: (tools: readonly OstraToolSet[]) => Promise<{ readonly core: FakeMemoryCore; readonly mcp: PrepareLaunchInput["mcp"] }>;
  /** Makes the agent list ostra's tools, as `memory tools: a, b` (milestone 4's probe), or `none`. */
  readonly list: string;
  /** Makes the agent call `take_screenshot` with this input and say the tool's answer. */
  readonly takeScreenshot: (input: TakeScreenshotInput) => string;
  /** Makes the agent say its instructions, all of them. */
  readonly instructions: string;
};

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

/** A code task's tool sets with the app's, as dispatch gives a task whose environment has app processes (minor 7). */
export const appToolSets: readonly OstraToolSet[] = ["pr-text", "memory", "app"];

/** Two app processes and a service, with a primary, as the app's block names them. */
export const sampleLaunchApp: LaunchApp = {
  processes: [
    { name: "web", label: "Web", port: 5173, primary: true },
    { name: "api", label: "API", port: 3001, primary: false },
  ],
  services: [{ name: "mailpit", label: "Mail", address: "http://mailpit:8025" }],
};

/** The screenshot the probing agent takes: the primary's `/settings` at phone width, with a caption a member reads. */
export const sampleScreenshot: TakeScreenshotInput = { target: { process: "web" }, path: "/settings", width: "phone", caption: "The settings page; `$(whoami)` stays text." };

/** Every kind's tool sets hold memory's, so a launch with ostra's tools carries the memory block with its tools. */
const withTools = { block: sampleMemoryBlock(true), tools: true } as const;

/** Whether the agent reaches ostra's MCP server, where the app tools are: MCP, and memory over it (milestone 4's split). */
const hasOstraTools = (adapter: AgentAdapter): boolean => (adapter.capabilities.mcp.http || adapter.capabilities.mcp.stdio) && adapter.capabilities.memory === "mcp";

export const defineAgentAppCases = (subject: Subject): void => {
  const runTurn = async (prompt: string, extra: Partial<PrepareLaunchInput>): Promise<string> => {
    const { adapter, fixture } = subject();
    const input: PrepareLaunchInput = { ...fixture.launchInput, ...extra };
    const prepared = await adapter.prepareLaunch(input);
    if (!prepared.ok) throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
    const started = await fixture.start(prepared.value);
    const events: TaskEvent[] = [];
    const session = await adapter.startSession({
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
    if (!session.ok) {
      await started.stop();
      throw new Error(`startSession failed: ${session.error.message}`);
    }
    try {
      const turn = await adapter.prompt(session.value, turnIdSchema.parse("app-turn-1"), { text: prompt, images: [] });
      if (!turn.ok) throw new Error(`the turn failed: ${turn.error.message}`);
      return textOf(events);
    } finally {
      await adapter.close(session.value);
      await started.stop();
    }
  };

  const probes = (context: { readonly skip: () => void }): AgentAppProbes | undefined => {
    const value = subject().fixture.app;
    if (value === undefined) context.skip();
    return value;
  };

  /** The names after `memory tools: `, `none` dropped. */
  const listed = (text: string): readonly string[] =>
    (/memory tools: (.*)/.exec(text)?.[1]?.split(", ") ?? []).map((name) => name.trim()).filter((name) => name !== "none" && name !== "");

  it("F-121/c1: the app tools are listed for a task whose tool sets hold app, and absent otherwise", async (context) => {
    const app = probes(context);
    if (app === undefined) return;
    if (!hasOstraTools(subject().adapter)) {
      context.skip();
      return;
    }
    for (const sets of [appToolSets, ["pr-text", "memory"] satisfies OstraToolSet[]]) {
      const { core, mcp } = await app.start(sets);
      try {
        const names = listed(await runTurn(app.list, { mcp, memory: withTools, tools: sets, app: sampleLaunchApp }));
        expect([...names].sort()).toEqual([...fakeCoreToolNames(sets)].sort());
        const appNames: readonly string[] = appToolNames;
        expect(names.some((name) => appNames.includes(name))).toBe(sets.includes("app"));
      } finally {
        await core.close();
      }
    }
  });

  it("F-121/c1: the agent's take_screenshot reaches ostra's server with its input, and the tool's answer reaches the agent", async (context) => {
    const app = probes(context);
    if (app === undefined) return;
    if (!hasOstraTools(subject().adapter)) {
      context.skip();
      return;
    }
    const { core, mcp } = await app.start(appToolSets);
    try {
      const said = await runTurn(app.takeScreenshot(sampleScreenshot), { mcp, memory: withTools, tools: appToolSets, app: sampleLaunchApp });
      expect(core.screenshots).toEqual([sampleScreenshot]);
      expect(core.toolCalls).toContain(TAKE_SCREENSHOT_TOOL);
      // The protocol's words, with the picture's ID a finding may name and the phone's size.
      expect(said).toContain(`Screenshot ${fakeAttachmentId(1)} (390×844) is in the task's thread`);
    } finally {
      await core.close();
    }
  });

  it("F-121/c1: an agent without MCP is offered no app tools, and its app block doesn't name them: its pictures are ostra's after each turn", async (context) => {
    const app = probes(context);
    if (app === undefined) return;
    if (hasOstraTools(subject().adapter)) {
      context.skip();
      return;
    }
    const { core, mcp } = await app.start(appToolSets);
    try {
      const names = listed(await runTurn(app.list, { mcp, tools: appToolSets, app: sampleLaunchApp }));
      expect(names).toEqual([]);
      const instructions = await runTurn(app.instructions, { mcp, tools: appToolSets, app: sampleLaunchApp });
      expect(instructions).toContain(appAddressName("web"));
      expect(instructions).not.toContain(TAKE_SCREENSHOT_TOOL);
      expect(core.toolCalls).toEqual([]);
    } finally {
      await core.close();
    }
  });

  it("F-140/c10: the app's block reaches the agent's instructions, naming each process, its address and the one-origin rule; a task with no process gets none", async (context) => {
    const app = probes(context);
    if (app === undefined) return;
    const withApp = await runTurn(app.instructions, { instructions: "Keep the README short.", tools: appToolSets, app: sampleLaunchApp });
    expect(withApp).toContain("Keep the README short.");
    for (const process of sampleLaunchApp.processes) {
      expect(withApp).toContain(`http://localhost:${String(process.port)}`);
      expect(withApp).toContain(appAddressName(process.name));
      expect(withApp).toContain(process.label);
    }
    expect(withApp).toContain("http://mailpit:8025");
    expect(withApp).toContain(ONE_ORIGIN_RULE);
    // A task whose environment declares no process gets no block.
    for (const none of [null, { processes: [], services: sampleLaunchApp.services }] satisfies (LaunchApp | null)[]) {
      const without = await runTurn(app.instructions, { instructions: "Keep the README short.", tools: appToolSets, app: none });
      expect(without).toContain("Keep the README short.");
      expect(without).not.toContain(ONE_ORIGIN_RULE);
      expect(without).not.toContain(appAddressName("web"));
    }
  });
};
