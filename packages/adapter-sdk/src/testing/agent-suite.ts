import { turnIdSchema } from "@ostra/protocol";
import type { OptionId, TaskEvent, ToolKind } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { isRunning } from "../agent/acp/process-tree.ts";
import type {
  AgentAdapter,
  AgentCommand,
  AgentIo,
  AgentLaunch,
  AgentSession,
  PermissionAnswer,
  PrepareLaunchInput,
  QuestionAnswer,
} from "../agent/base.ts";
import { defineAgentEffortCases } from "./agent-effort-cases.ts";
import type { AgentEffortProbes } from "./agent-effort-cases.ts";
import { defineAgentMemoryCases } from "./agent-memory-cases.ts";
import { defineAgentParityCases } from "./agent-parity-cases.ts";
import { defineAgentAppCases } from "./agent-app-cases.ts";
import type { AgentAppProbes } from "./agent-app-cases.ts";
import { defineAgentTeamCases } from "./agent-team-cases.ts";
import { defineAgentFilesCases } from "./agent-files-cases.ts";
import type { AgentFilesProbes } from "./agent-files-cases.ts";
import { defineAgentQuestionCases } from "./agent-question-cases.ts";
import type { AgentQuestionProbes } from "./agent-question-cases.ts";
import type { AgentTeamProbes } from "./agent-team-cases.ts";
import type { AgentParityProbes } from "./agent-parity-cases.ts";
import type { AgentCanaryProbe, AgentMemoryProbes } from "./agent-memory-cases.ts";
import { defineAgentProfileCases } from "./agent-profile-cases.ts";
import type { AgentProfileProbes } from "./agent-profile-cases.ts";
import { defineCommonCases, useSubject } from "./common-cases.ts";
import type { ContractSuiteOptions } from "./common-cases.ts";

// The cases every agent adapter passes (ADR 0018, ADR 0025, ADR 0032): against the scripted fake
// ACP agent (ticket 10), against stub model endpoints, and, gated on `model.env`, against the real
// endpoint. Each case is named after the ADR line or the ledger row it checks.
//
// The cases that need a particular behavior of the agent take a prompt that makes it happen, in
// `probes`. An adapter whose agent can't be scripted leaves a probe out, and its case is skipped:
// the fake ACP agent has them all, so the cases always run for it.

export type StartedAgent = {
  readonly io: AgentIo;
  /** Ends the agent's process. */
  readonly stop: () => Promise<void>;
};

/** Prompts that make an agent do one particular thing. Each is optional. */
export type AgentProbes = {
  /**
   * The agent calls tools. A prompt alone means a tool of each ACP kind, one of them failing, and
   * one with progress (the fake agent). The object says which kinds this agent's turn calls, and
   * what else to expect.
   */
  readonly tools?:
    | string
    | {
        readonly prompt: string;
        readonly kinds: readonly ToolKind[];
        readonly expectFailure?: boolean;
        readonly expectProgress?: boolean;
      };
  /** The agent asks for permission to edit a file, and carries on when it's allowed. */
  readonly permission?: string;
  /** The agent asks a question through `elicitation.form`, with a text and a select field. */
  readonly question?: string;
  /** The agent sends an update of a kind no mapping knows, between two messages. */
  readonly unknownUpdate?: string;
  /** The agent says its own environment's variable names, as `env: ["A","B"]`. */
  readonly environment?: { readonly prompt: string; readonly allowedNames: readonly string[] };
  /** The agent says the model base URL and key it was given, as `endpoint: <url> <key>`. */
  readonly endpoint?: string;
  /**
   * The agent updates its plan. A prompt alone expects `plan.updated` exactly when the adapter
   * declares `nativePlan`; the object says whether this agent's turn plans (OpenCode plans
   * through its todo tool without declaring `nativePlan`).
   */
  readonly plan?: string | { readonly prompt: string; readonly expectPlan: boolean };
  /**
   * The agent runs until cancelled and leaves a process behind it, saying `spawned <pid>`. After
   * the cancel the suite checks that the process is gone.
   */
  readonly leftoverProcess?: string;
  /**
   * The agent runs a long step, and a steer sent during it reaches its next model call. A prompt
   * alone is the fake's: it says `Steered: <text>`. The object names what to wait for before
   * steering, the text to steer with, and the message that proves it arrived.
   */
  readonly steerable?:
    | string
    | { readonly prompt: string; readonly waitFor: string; readonly steerText: string; readonly expectMessage: string };
  /**
   * Subagents (2026-11-20): the agent starts a subagent and ends its turn; the subagent works on
   * past the prompt's answer, and its report wakes the agent, which then answers. `prompt` makes it
   * happen, with `launched` the agent's words at the answer, `childAnswer` the subagent's and
   * `finalAnswer` the agent's once woken. `hangingPrompt` starts one that works until it's stopped.
   */
  readonly backgroundSubagent?: {
    readonly prompt: string;
    readonly hangingPrompt: string;
    readonly launched: string;
    readonly childAnswer: string;
    readonly finalAnswer: string;
    /** How many model calls the subagents have made so far, for an agent that calls a model. */
    readonly childCalls?: () => number;
  };
};

export type AgentFixture = {
  readonly launchInput: PrepareLaunchInput;
  /** Values that must never reach the agent: the real model token, git tokens, secrets. */
  readonly secrets: readonly string[];
  /** Starts the agent's process from its launch, as the executor would. */
  readonly start: (launch: AgentLaunch) => Promise<StartedAgent>;
  /** A prompt the agent answers with a message and an `end_turn`. */
  readonly simplePrompt: string;
  /** A prompt the agent keeps working on until it's cancelled. */
  readonly longPrompt: string;
  /**
   * Whether the turn of the long prompt sent at `since` (ms since the epoch) is at work: past the
   * agent's own set-up of the turn, as when its model call is open at the stub. A case that means
   * "mid-turn" waits for it rather than for a fixed time, which a loaded machine can outrun (F-024).
   * Absent: the agent's turn is at work from the moment it reads the prompt, as the scripted fakes' is.
   */
  readonly longPromptAtWork?: (since: number) => boolean;
  readonly probes?: AgentProbes;
  /**
   * Milestone 2 (ADR 0039): moving a session to a fresh box. Absent, or without the capability
   * `sessionArchive`, the case is skipped.
   */
  readonly archive?: {
    /** Runs an export or import command where the agent runs. */
    readonly run: (command: AgentCommand) => Promise<{ readonly code: number | null }>;
    /** A launch input for a fresh box: new agent folder, new workspace, the same task. */
    readonly freshBox: () => Promise<PrepareLaunchInput>;
    /** A path the archive can be written to and read from. */
    readonly archivePath: string;
    /** A prompt that makes the agent state a fact, and one that asks for it back without tools. */
    readonly remember: { readonly prompt: string; readonly recall: string; readonly fact: string };
  };
  /**
   * Milestone 3 (ADR 0049): the prompts and files of the profile's cases: rules, task rules, plan
   * mode, skills, MCP servers, a repo's config. Absent: those cases are skipped.
   */
  readonly profile?: AgentProfileProbes;
  /** Milestone 4 (ADR 0044, F-110, F-098): the memory cases and the repos side by side. Absent: skipped. */
  readonly memory?: AgentMemoryProbes;
  /** Milestone 4 (ADR 0035, F-073): the canary control. Absent: skipped. */
  readonly canary?: AgentCanaryProbe;
  /** Milestone 4 (ADR 0066, F-137): the reasoning effort cases. Absent: skipped. */
  readonly effort?: AgentEffortProbes;
  /** Milestone 7 (ticket 03): the cases every agent is checked for before launch. Absent: skipped. */
  readonly parity?: AgentParityProbes;
  /** Milestone 6 (ticket 04): the whole team's task kinds: automatic turns, read-only tasks, reviews, ostra's tools, `commitPaths`. Absent: skipped. */
  readonly team?: AgentTeamProbes;
  /** Milestone 8 (ticket 03): the app tools and the app's block. Absent: skipped. */
  readonly app?: AgentAppProbes;
  /** Milestone 9 (F-148): images in a prompt and a steer, and a file under the root's `.ostra/`. Absent: skipped. */
  readonly files?: AgentFilesProbes;
  /** Milestone 10 (F-151): a question's enum field answered in a member's own words. Absent: skipped. */
  readonly questions?: AgentQuestionProbes;
};

const turn = (n: number) => turnIdSchema.parse(`contract-turn-${String(n)}`);

/** A cancel must come back within this long (F-023). */
const CANCEL_BUDGET_MS = 5000;

type Handlers = {
  readonly onPermission?: (request: { readonly options: readonly { readonly optionId: OptionId; readonly kind: string }[] }) => PermissionAnswer;
  readonly onQuestion?: () => QuestionAnswer;
};

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

export const defineAgentContractSuite = (options: ContractSuiteOptions<AgentAdapter, AgentFixture>): void => {
  describe(`agent contract: ${options.name}`, () => {
    const subject = useSubject(options);

    defineCommonCases(subject, "agent", {
      steerMidTurn: "boolean",
      sessionLoad: "boolean",
      nativePlan: "boolean",
      rejectAndContinue: "boolean",
      elicitationForm: "boolean",
      modelBaseUrlAndPlaceholderKey: "boolean",
      sessionArchive: "boolean",
      permissionRules: "string",
      planMode: "string",
      skills: "boolean",
      mcp: "object",
      projectConfigOverride: "boolean",
      memory: "string",
      reasoningEffort: "string",
      subagents: "string",
      promptImages: "boolean",
      questionFreeText: "boolean",
    });

    const launch = async (): Promise<AgentLaunch> => {
      const prepared = await subject().adapter.prepareLaunch(subject().fixture.launchInput);
      if (!prepared.ok) {
        throw new Error(`prepareLaunch failed: ${prepared.error.message}`);
      }
      return prepared.value;
    };

    const session = async (
      events: TaskEvent[],
      handlers: Handlers = {},
    ): Promise<{ readonly session: AgentSession; readonly started: StartedAgent }> => {
      const { adapter, fixture } = subject();
      const started = await fixture.start(await launch());
      const result = await adapter.startSession({
        taskId: fixture.launchInput.taskId,
        sessionId: fixture.launchInput.sessionId,
        io: started.io,
        cwd: fixture.launchInput.workspaceDir,
        mcpServers: [],
        onEvents: (batch) => {
          events.push(...batch);
        },
        onPermission: (_sessionId, request) =>
          Promise.resolve(handlers.onPermission?.(request) ?? ({ outcome: "cancelled" } satisfies PermissionAnswer)),
        onQuestion: () => Promise.resolve(handlers.onQuestion?.() ?? ({ outcome: "cancelled" } satisfies QuestionAnswer)),
      });
      if (!result.ok) {
        await started.stop();
        throw new Error(`startSession failed: ${result.error.message}`);
      }
      return { session: result.value, started };
    };

    /** Runs one prompt to its end in a session of its own, and gives back every event. */
    const runTurn = async (
      prompt: string,
      handlers: Handlers = {},
      n = 1,
    ): Promise<{ readonly events: TaskEvent[]; readonly stopReason: string }> => {
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events, handlers);
      try {
        const result = await subject().adapter.prompt(running, turn(n), { text: prompt, images: [] });
        if (!result.ok) {
          throw new Error(`the turn failed: ${result.error.message}`);
        }
        return { events, stopReason: result.value.stopReason };
      } finally {
        await subject().adapter.close(running);
        await started.stop();
      }
    };

    const probe = <K extends keyof AgentProbes>(context: { readonly skip: () => void }, name: K): AgentProbes[K] | undefined => {
      const value = subject().fixture.probes?.[name];
      if (value === undefined) {
        context.skip();
      }
      return value;
    };

    it("ADR 0039: exports a session, imports it into a fresh box's workspace, and loads it there with its history", async (context) => {
      const { adapter, fixture } = subject();
      const archive = fixture.archive;
      if (archive === undefined || !adapter.capabilities.sessionArchive || !adapter.capabilities.sessionLoad) {
        context.skip();
        return;
      }
      // Turn one, in the first box: the agent states the fact.
      const first: TaskEvent[] = [];
      const { session: running, started } = await session(first);
      const said = await adapter.prompt(running, turn(1), { text: archive.remember.prompt, images: [] });
      expect(said.ok).toBe(true);
      const agentSessionId = running.agentSessionId;
      await adapter.close(running);
      await started.stop();
      const exported = await adapter.exportSession({
        agentSessionId,
        agentDir: fixture.launchInput.agentDir,
        workspaceDir: fixture.launchInput.workspaceDir,
        archivePath: archive.archivePath,
      });
      if (!exported.ok) throw new Error(`exportSession: ${exported.error.message}`);
      expect((await archive.run(exported.value)).code).toBe(0);

      // A fresh box: another agent folder and workspace. The import binds the session to it.
      const fresh = await archive.freshBox();
      const imported = await adapter.importSession({ agentSessionId, agentDir: fresh.agentDir, workspaceDir: fresh.workspaceDir, archivePath: archive.archivePath });
      if (!imported.ok) throw new Error(`importSession: ${imported.error.message}`);
      expect((await archive.run(imported.value)).code).toBe(0);
      const prepared = await adapter.prepareLaunch(fresh);
      if (!prepared.ok) throw new Error(`prepareLaunch: ${prepared.error.message}`);
      const second = await fixture.start(prepared.value);
      const events: TaskEvent[] = [];
      try {
        const resumed = await adapter.startSession({
          taskId: fresh.taskId,
          sessionId: fresh.sessionId,
          io: second.io,
          cwd: fresh.workspaceDir,
          mcpServers: [],
          onEvents: (batch) => {
            events.push(...batch);
          },
          onPermission: () => Promise.resolve({ outcome: "cancelled" }),
          onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
          resumeAgentSessionId: agentSessionId,
        });
        if (!resumed.ok) throw new Error(`loading the imported session: ${resumed.error.message}`);
        // The replay is marked and counted, never handed over as new events.
        expect(resumed.value.replayedUpdates, "session/load replayed the history").toBeGreaterThan(0);
        expect(events, "a replayed update reached onEvents").toEqual([]);
        const recalled = await adapter.prompt(resumed.value, turn(2), { text: archive.remember.recall, images: [] });
        expect(recalled.ok).toBe(true);
        expect(textOf(events)).toContain(archive.remember.fact);
        await adapter.close(resumed.value);
      } finally {
        await second.stop();
      }
    }, 60_000);

    it("ADR 0030: launches with an allowlisted environment that holds no credential", async () => {
      const prepared = await launch();
      const everything = JSON.stringify({ args: prepared.args, env: prepared.env, files: prepared.files });
      for (const secret of subject().fixture.secrets) {
        expect(everything.includes(secret), "a credential reached the agent's launch").toBe(false);
      }
      expect(prepared.cwd).toBe(subject().fixture.launchInput.workspaceDir);
    });

    it("F-023: a turn runs to end_turn, bracketed by turn.started and turn.ended, with the agent's message", async () => {
      const { events, stopReason } = await runTurn(subject().fixture.simplePrompt);
      expect(stopReason).toBe("end_turn");
      expect(events[0]).toEqual({ kind: "turn.started", turnId: turn(1) });
      expect(events.at(-1)).toEqual({ kind: "turn.ended", turnId: turn(1), stopReason: "end_turn" });
      expect(events.some((event) => event.kind === "agent.message")).toBe(true);
      expect(events.filter((event) => event.kind === "turn.ended")).toHaveLength(1);
    });

    it("F-023: a cancel ends the turn with cancelled, in under 5 s", async () => {
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        const turnResult = subject().adapter.prompt(running, turn(2), { text: subject().fixture.longPrompt, images: [] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const at = Date.now();
        await subject().adapter.cancel(running);
        expect(await turnResult).toEqual({ ok: true, value: { stopReason: "cancelled" } });
        expect(Date.now() - at).toBeLessThan(CANCEL_BUDGET_MS);
        expect(events.at(-1)).toEqual({ kind: "turn.ended", turnId: turn(2), stopReason: "cancelled" });
      } finally {
        await subject().adapter.close(running);
        await started.stop();
      }
    });

    it("F-023: a cancel leaves no process of the agent's behind", async (context) => {
      const prompt = probe(context, "leftoverProcess");
      if (prompt === undefined) {
        return;
      }
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        const turnResult = subject().adapter.prompt(running, turn(3), { text: prompt, images: [] });
        const spawned = await waitFor(() => /spawned (\d+)/.exec(textOf(events))?.[1], 15_000);
        expect(spawned, "the agent says which process it left").toBeDefined();
        const pid = Number(spawned);
        expect(await isRunning(pid)).toBe(true);
        await subject().adapter.cancel(running);
        expect(await turnResult).toMatchObject({ ok: true, value: { stopReason: "cancelled" } });
        // A killed child can linger as a zombie until its parent collects it: that counts as gone.
        // The reap may also finish after the turn ends (the driver keeps the cancel in its budget),
        // so this waits for the process to go, not for a time.
        const deadline = Date.now() + 20_000;
        while ((await isRunning(pid)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await isRunning(pid), "the process the agent left behind").toBe(false);
      } finally {
        await subject().adapter.close(running);
        await started.stop();
      }
    }, 30_000);

    it("F-023: tool calls render by ACP kind, and a failing one is reported", async (context) => {
      const tools = probe(context, "tools");
      if (tools === undefined) {
        return;
      }
      const spec =
        typeof tools === "string"
          ? {
              prompt: tools,
              kinds: ["read", "edit", "execute", "delete", "move", "search", "think", "fetch", "switch_mode", "other"] as const,
              expectFailure: true,
              expectProgress: true,
            }
          : tools;
      const { events, stopReason } = await runTurn(spec.prompt);
      expect(stopReason).toBe("end_turn");
      const kinds = new Set(events.flatMap((event) => (event.kind === "tool.called" ? [event.toolKind] : [])));
      for (const kind of spec.kinds) {
        expect(kinds.has(kind), `a ${kind} tool call`).toBe(true);
      }
      expect(events.filter((event) => event.kind === "tool.completed").length).toBeGreaterThanOrEqual(spec.kinds.length);
      expect(events.some((event) => event.kind === "tool.failed")).toBe(spec.expectFailure ?? false);
      if (spec.expectProgress === true) {
        expect(events.some((event) => event.kind === "tool.progress")).toBe(true);
      }
    });

    it("F-019: the agent's environment holds only the allowlist", async (context) => {
      const probeEnv = probe(context, "environment");
      if (probeEnv === undefined) {
        return;
      }
      const { events } = await runTurn(probeEnv.prompt);
      const said = /env: (\[.*\])/.exec(textOf(events))?.[1] ?? "[]";
      const names: unknown = JSON.parse(said);
      expect(Array.isArray(names)).toBe(true);
      const extra = (Array.isArray(names) ? names : [])
        .filter((name): name is string => typeof name === "string" && !name.startsWith("="))
        .filter((name) => !probeEnv.allowedNames.some((allowed) => allowed.toLowerCase() === name.toLowerCase()));
      expect(extra, "variables beyond the allowlist").toEqual([]);
    });

    it("ADR 0030: the model base URL and the fake key are what reach the agent", async (context) => {
      const prompt = probe(context, "endpoint");
      if (prompt === undefined) {
        return;
      }
      const { launchInput } = subject().fixture;
      const { events } = await runTurn(prompt);
      expect(textOf(events)).toContain(`endpoint: ${launchInput.model.baseUrl} ${launchInput.model.placeholderKey}`);
    });

    it("ADR 0032: a deny is followed by the runner's re-prompt, or by the agent carrying on when it declares rejectAndContinue", async (context) => {
      const prompt = probe(context, "permission");
      if (prompt === undefined) {
        return;
      }
      const { adapter, fixture } = subject();
      const events: TaskEvent[] = [];
      const asked: string[] = [];
      const { session: running, started } = await session(events, {
        onPermission: (request) => {
          asked.push(...request.options.map((option) => option.kind));
          const reject = request.options.find((option) => option.kind === "reject_once");
          return reject === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: reject.optionId };
        },
      });
      try {
        const first = await adapter.prompt(running, turn(4), { text: prompt, images: [] });
        expect(asked).toContain("allow_once");
        if (adapter.capabilities.rejectAndContinue) {
          // The agent tried another way within the same turn.
          expect(first).toEqual({ ok: true, value: { stopReason: "end_turn" } });
        } else {
          // The deny ended the turn: the runner re-prompts, and the agent works on.
          expect(first).toEqual({ ok: true, value: { stopReason: "cancelled" } });
          const again = await adapter.prompt(running, turn(5), { text: fixture.simplePrompt, images: [] });
          expect(again).toEqual({ ok: true, value: { stopReason: "end_turn" } });
        }
        expect(events.some((event) => event.kind === "tool.failed")).toBe(true);
      } finally {
        await adapter.close(running);
        await started.stop();
      }
    });

    it("F-019: an allowed permission request lets the agent go on", async (context) => {
      const prompt = probe(context, "permission");
      if (prompt === undefined) {
        return;
      }
      const { events, stopReason } = await runTurn(prompt, {
        onPermission: (request) => {
          const allow = request.options.find((option) => option.kind === "allow_once");
          return allow === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: allow.optionId };
        },
      });
      expect(stopReason).toBe("end_turn");
      expect(events.some((event) => event.kind === "tool.completed")).toBe(true);
    });

    it("F-019: a question reaches ostra through elicitation.form, and the answer reaches the agent", async (context) => {
      const prompt = probe(context, "question");
      if (prompt === undefined) {
        return;
      }
      const { adapter } = subject();
      if (!adapter.capabilities.elicitationForm) {
        context.skip();
        return;
      }
      const { events } = await runTurn(prompt, { onQuestion: () => ({ outcome: "answered", answers: { name: "orders", engine: "postgres", replicas: "3" } }) });
      expect(textOf(events)).toContain('"name":"orders"');
      expect(textOf(events)).toContain('"engine":"postgres"');
    });

    it("F-019: a plan reaches ostra as plan.updated when the agent declares nativePlan", async (context) => {
      const plan = probe(context, "plan");
      if (plan === undefined) {
        return;
      }
      const { adapter } = subject();
      const spec = typeof plan === "string" ? { prompt: plan, expectPlan: adapter.capabilities.nativePlan } : plan;
      const { events } = await runTurn(spec.prompt);
      expect(events.some((event) => event.kind === "plan.updated")).toBe(spec.expectPlan);
    });

    it("ADR 0018: an unknown update becomes agent.unknown, and nothing around it is dropped", async (context) => {
      const prompt = probe(context, "unknownUpdate");
      if (prompt === undefined) {
        return;
      }
      const { events } = await runTurn(prompt);
      const unknown = events.find((event) => event.kind === "agent.unknown");
      expect(unknown).toMatchObject({ kind: "agent.unknown", acpKind: "future_feature" });
      expect(textOf(events)).toContain("Before the unknown update.");
      expect(textOf(events)).toContain("After the unknown update.");
    });

    it("ADR 0032: steering is used only when the adapter declares steerMidTurn and the agent advertised it", async () => {
      const { adapter } = subject();
      const { session: running, started } = await session([]);
      try {
        const steered = await adapter.steer(running, { text: "also add a test", images: [] });
        if (adapter.capabilities.steerMidTurn && running.connection.steeringAdvertised) {
          // No turn is running, so an agent that takes steers answers, and one that doesn't refuses.
          expect(steered.ok || steered.error.code === "conflict").toBe(true);
        } else {
          expect(steered).toMatchObject({ ok: false, error: { code: "unsupported" } });
        }
      } finally {
        await adapter.close(running);
        await started.stop();
      }
    });

    it("ADR 0032: a steer during a turn reaches the agent, when steering is declared", async (context) => {
      const steerable = probe(context, "steerable");
      if (steerable === undefined) {
        return;
      }
      const spec =
        typeof steerable === "string"
          ? { prompt: steerable, waitFor: "open to a steer", steerText: "use tabs", expectMessage: "Steered: use tabs" }
          : steerable;
      const { adapter } = subject();
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        if (!adapter.capabilities.steerMidTurn || !running.connection.steeringAdvertised) {
          context.skip();
          return;
        }
        const turnResult = adapter.prompt(running, turn(6), { text: spec.prompt, images: [] });
        await waitFor(() => (events.some((event) => event.kind === "tool.called") || textOf(events).includes(spec.waitFor) ? true : undefined), 60_000);
        // The turn is in its long step.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await adapter.steer(running, { text: spec.steerText, images: [] })).toEqual({ ok: true, value: undefined });
        expect(await turnResult).toEqual({ ok: true, value: { stopReason: "end_turn" } });
        expect(textOf(events)).toContain(spec.expectMessage);
      } finally {
        await adapter.close(running);
        await started.stop();
      }
    }, 120_000);

    it("F-023: a subagent that outlives its agent's prompt holds the turn until it reports and the agent answers, with subagents background", async (context) => {
      const probed = probe(context, "backgroundSubagent");
      if (probed === undefined) {
        return;
      }
      if (subject().adapter.capabilities.subagents !== "background") {
        context.skip();
        return;
      }
      const { events, stopReason } = await runTurn(probed.prompt, {}, 7);
      expect(stopReason).toBe("end_turn");
      // Everything the subagent and the woken agent said is the turn's, before its one end.
      expect(events.at(-1)).toEqual({ kind: "turn.ended", turnId: turn(7), stopReason: "end_turn" });
      expect(events.filter((event) => event.kind === "turn.ended")).toHaveLength(1);
      const said = textOf(events);
      expect(said).toContain(probed.launched);
      expect(said).toContain(probed.childAnswer);
      expect(said).toContain(probed.finalAnswer);
      expect(said.indexOf(probed.finalAnswer)).toBeGreaterThan(said.indexOf(probed.launched));
    }, 180_000);

    it("F-023: an agent without background subagents ends its turn with its prompt's answer", async (context) => {
      const probed = probe(context, "backgroundSubagent");
      if (probed === undefined) {
        return;
      }
      if (subject().adapter.capabilities.subagents !== "none") {
        context.skip();
        return;
      }
      const { events, stopReason } = await runTurn(probed.prompt, {}, 7);
      expect(stopReason).toBe("end_turn");
      expect(events.at(-1)).toEqual({ kind: "turn.ended", turnId: turn(7), stopReason: "end_turn" });
      // The turn ended with its prompt's answer: the woken agent's words never made it in.
      expect(textOf(events)).toContain(probed.launched);
      expect(textOf(events)).not.toContain(probed.finalAnswer);
    }, 180_000);

    it("F-138: a subagent's start, its state, its calls and its answer are named as its own, with subagents background", async (context) => {
      const probed = probe(context, "backgroundSubagent");
      if (probed === undefined) {
        return;
      }
      if (subject().adapter.capabilities.subagents !== "background") {
        context.skip();
        return;
      }
      const { events } = await runTurn(probed.prompt, {}, 7);
      // Its start names the main agent's call that started it, what it is and what it was asked.
      const started = events.flatMap((event) => (event.kind === "subagent.started" ? [event] : []));
      expect(started).toHaveLength(1);
      const start = started[0];
      if (start === undefined) {
        return;
      }
      expect(start).toMatchObject({ depth: 1 });
      expect(start.parentSubagentId).toBeUndefined();
      expect(start.type).not.toBe("");
      expect(start.prompt).not.toBe("");
      const starter = events.flatMap((event) => (event.kind === "tool.called" && event.toolCallId === start.toolCallId ? [event] : []));
      expect(starter, "the call that started it is the main agent's").toHaveLength(1);
      expect(starter[0]?.subagentId).toBeUndefined();
      // Its state, to the end; its calls and its answer, as its own; the main agent's words, as its.
      const states = events.flatMap((event) => (event.kind === "subagent.status" && event.subagentId === start.subagentId ? [event.status] : []));
      expect(states.at(-1)).toBe("completed");
      const answers = events.flatMap((event) => (event.kind === "agent.message" ? [event] : []));
      expect(answers.find((event) => event.text.includes(probed.childAnswer))?.subagentId).toBe(start.subagentId);
      expect(answers.filter((event) => event.text.includes(probed.launched) || event.text.includes(probed.finalAnswer)).every((event) => event.subagentId === undefined)).toBe(true);
      const theirs = events.filter((event) => event.kind === "tool.called" && event.subagentId === start.subagentId);
      expect(theirs.length, "the subagent's own calls").toBeGreaterThanOrEqual(1);
    }, 180_000);

    it("F-138: an agent without background subagents names no subagent: every call and message is its own", async (context) => {
      const probed = probe(context, "backgroundSubagent");
      if (probed === undefined) {
        return;
      }
      if (subject().adapter.capabilities.subagents !== "none") {
        context.skip();
        return;
      }
      const { events } = await runTurn(probed.prompt, {}, 7);
      expect(events.some((event) => event.kind === "subagent.started" || event.kind === "subagent.status")).toBe(false);
      expect(events.some((event) => "subagentId" in event)).toBe(false);
    }, 180_000);

    it("F-025: a cancel while a subagent runs stops it with the turn, in under 5 s, and nothing of theirs comes after", async (context) => {
      const probed = probe(context, "backgroundSubagent");
      if (probed === undefined) {
        return;
      }
      const { adapter } = subject();
      if (adapter.capabilities.subagents !== "background") {
        context.skip();
        return;
      }
      const events: TaskEvent[] = [];
      const { session: running, started } = await session(events);
      try {
        const turnResult = adapter.prompt(running, turn(8), { text: probed.hangingPrompt, images: [] });
        // The prompt is answered, and the turn waits on its subagent.
        await waitFor(() => (textOf(events).includes(probed.launched) ? true : undefined), 120_000);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(events.some((event) => event.kind === "turn.ended"), "the turn waits for its subagent").toBe(false);
        const at = Date.now();
        await adapter.cancel(running);
        expect(await turnResult).toEqual({ ok: true, value: { stopReason: "cancelled" } });
        expect(Date.now() - at).toBeLessThan(CANCEL_BUDGET_MS);
        expect(events.at(-1)).toEqual({ kind: "turn.ended", turnId: turn(8), stopReason: "cancelled" });
        // The subagent and the turn its report would wake are stopped: nothing comes after the end,
        // and the subagent calls the model no more.
        const count = events.length;
        await new Promise((resolve) => setTimeout(resolve, 500));
        const calls = probed.childCalls?.();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(events.slice(count).filter((event) => event.kind !== "session.config_changed")).toEqual([]);
        expect(probed.childCalls?.(), "the subagent called the model after the cancel").toBe(calls);
        // The session goes on: "interrupt and send" sends the member's message as its next turn.
        const next = await adapter.prompt(running, turn(9), { text: subject().fixture.simplePrompt, images: [] });
        expect(next).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      } finally {
        await adapter.close(running);
        await started.stop();
      }
    }, 180_000);

    it("refuses to resume a session when it doesn't declare sessionLoad", async (context) => {
      const { adapter, fixture } = subject();
      if (adapter.capabilities.sessionLoad) {
        context.skip();
        return;
      }
      const started = await fixture.start(await launch());
      try {
        const result = await adapter.startSession({
          taskId: fixture.launchInput.taskId,
          sessionId: fixture.launchInput.sessionId,
          io: started.io,
          cwd: fixture.launchInput.workspaceDir,
          mcpServers: [],
          onEvents: () => undefined,
          onPermission: () => Promise.resolve({ outcome: "cancelled" }),
          onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
          resumeAgentSessionId: "an-earlier-session",
        });
        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
      } finally {
        await started.stop();
      }
    });

    // Milestone 3: approval rules, task rules, plan first, skills, MCP servers (ADR 0049).
    defineAgentProfileCases(subject);

    // Milestone 4: memory, the repos side by side, and the canary (ADR 0044, ADR 0035).
    defineAgentMemoryCases(subject);

    // Milestone 4: reasoning effort, the research's probe (ADR 0066).
    defineAgentEffortCases(subject);

    // Milestone 7: the launch, the key proxy, a repo's config, "for this task", slash commands and the checksum.
    defineAgentParityCases(subject);

    // Milestone 6: the whole team's task kinds, last, since they add repo folders to the workspace.
    defineAgentTeamCases(subject);
    defineAgentAppCases(subject);
    // Milestone 9 (ADR 0070, F-148): images in a prompt and a steer, and a message's files on disk.
    defineAgentFilesCases(subject);
    // Milestone 10 (F-151): an enum question answered in a member's own words, where the agent takes them.
    defineAgentQuestionCases(subject);
  });
};

/** Polls until `read` gives a value, or fails after `timeoutMs`. */
const waitFor = async <T,>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() >= until) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
