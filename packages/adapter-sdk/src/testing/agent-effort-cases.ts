import { turnIdSchema } from "@ostra/protocol";
import type { ApiFormat, EffortLevel, ReasoningControls, TaskEvent, TaskSpecModelLimits } from "@ostra/protocol";
import { z } from "zod";
import { expect, it } from "vitest";

import { effortModelOf, THOUGHT_LEVEL_CATEGORY } from "../agent/base.ts";
import type { AgentAdapter, AgentSession, EffortModel, PrepareLaunchInput, SessionConfigOption } from "../agent/base.ts";
import type { AgentFixture, StartedAgent } from "./agent-suite.ts";

// Milestone 4 (ticket 57, F-137, ADR 0066): the agent contract suite's reasoning effort cases, the
// research's probe (`context/research/opencode-reasoning-effort.md`, section 1.7). For every agent:
// the levels `effortLevels` computes are the ones the agent advertises for each control shape;
// `setEffort` clamps a level the agent doesn't advertise and never sends it; and the level survives
// a kill and `session/load`. For an agent whose model endpoint the fixture records, each level
// reaches the next request's body, `default` sends nothing, and the request asks for the model's
// output limit. A `none` agent advertises nothing and `setEffort` leaves it at `default`.

/** What the effort cases need of a fixture. Absent: they're skipped. */
export type AgentEffortProbes = {
  /** Model IDs to run the levels case on, each served by the fixture's endpoint: a Claude family's own levels differ. */
  readonly modelIds: readonly string[];
  /**
   * The bodies of the main model requests the endpoint got so far, oldest first (a title call
   * aside). Absent for an agent with no model behind it: the wire cases are skipped.
   */
  readonly requests?: () => readonly unknown[];
  /** A prompt that makes the agent say its reasoning level as `effort: <value>` (the fake's `effort` script). */
  readonly sayEffort?: string;
};

/** The control shapes the levels case runs, as models.dev states them (research section 2.2). */
export const effortControlShapes: Readonly<Record<string, ReasoningControls>> = {
  "an effort list": { supported: true, effort: ["none", "low", "high", "max"] },
  "a toggle and an effort list": { supported: true, toggle: true, effort: ["low", "medium", "high", "xhigh", "max"] },
  "a toggle": { supported: true, toggle: true },
  "a budget": { supported: true, budget: { min: 1024 } },
  "no control": { supported: true },
  "no reasoning": { supported: false },
};

/** What a request body asked of the model's reasoning, in either format. */
export type WireReasoning = {
  /** OpenAI's `reasoning_effort`, or Anthropic's `output_config.effort`. */
  readonly effort: string | null;
  /** Anthropic's `thinking.type`. */
  readonly thinking: string | null;
  /** Anthropic's `thinking.budget_tokens`. */
  readonly budget: number | null;
  /** `max_tokens` or `max_completion_tokens`. */
  readonly maxTokens: number | null;
};

const wireSchema = z.looseObject({
  reasoning_effort: z.string().optional(),
  output_config: z.looseObject({ effort: z.string().optional() }).optional(),
  thinking: z.looseObject({ type: z.string().optional(), budget_tokens: z.number().optional() }).optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
});

/** Reads a request body's reasoning fields (vendor data: unknown fields tolerated). */
export const wireReasoningOf = (body: unknown): WireReasoning => {
  const parsed = wireSchema.safeParse(body);
  if (!parsed.success) {
    return { effort: null, thinking: null, budget: null, maxTokens: null };
  }
  const { data } = parsed;
  return {
    effort: data.reasoning_effort ?? data.output_config?.effort ?? null,
    thinking: data.thinking?.type ?? null,
    budget: data.thinking?.budget_tokens ?? null,
    maxTokens: data.max_completion_tokens ?? data.max_tokens ?? null,
  };
};

/** Whether a request body carries a level, as either format sends it (research sections 1.3, 1.4). */
const expectLevelOnWire = (format: ApiFormat, level: EffortLevel, wire: WireReasoning, label: string): void => {
  if (level === "default") {
    expect(wire, label).toMatchObject({ effort: null, thinking: null, budget: null });
    return;
  }
  if (format === "openai-compatible") {
    expect(wire.effort, label).toBe(level);
    return;
  }
  switch (level) {
    case "none":
      expect(wire.thinking, label).toBe("disabled");
      expect(wire.effort, label).toBeNull();
      return;
    case "on":
      expect(["adaptive", "enabled"], label).toContain(wire.thinking);
      expect(wire.effort, label).toBeNull();
      return;
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      // Adaptive thinking at that effort, or (an older Claude, or a budget) a thinking budget.
      if (wire.thinking === "enabled") {
        expect(wire.budget, label).toBeGreaterThan(0);
        expect(["high", "max"], label).toContain(level);
      } else {
        expect(wire.thinking, label).toBe("adaptive");
        expect(wire.effort, label).toBe(level);
      }
      return;
    default:
      level satisfies never;
  }
};

type Subject = () => { readonly adapter: AgentAdapter; readonly fixture: AgentFixture };

type Opened = {
  readonly session: AgentSession;
  readonly input: PrepareLaunchInput;
  readonly model: EffortModel;
  readonly events: TaskEvent[];
  readonly started: StartedAgent;
  readonly prompt: (text: string) => Promise<string>;
  readonly close: () => Promise<void>;
};

const textOf = (events: readonly TaskEvent[]): string =>
  events.flatMap((event) => (event.kind === "agent.message" ? [event.text] : [])).join("");

let turns = 0;

export const defineAgentEffortCases = (subject: Subject): void => {
  const effortProbe = (context: { readonly skip: () => void }): AgentEffortProbes | undefined => {
    const value = subject().fixture.effort;
    if (value === undefined) context.skip();
    return value;
  };

  /** A session launched with the model's controls and limits; `resume` loads an earlier one. */
  const open = async (model: Partial<PrepareLaunchInput["model"]>, resume?: string): Promise<Opened> => {
    const { adapter, fixture } = subject();
    const input: PrepareLaunchInput = { ...fixture.launchInput, model: { ...fixture.launchInput.model, ...model } };
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
      ...(resume === undefined ? {} : { resumeAgentSessionId: resume }),
    });
    if (!result.ok) {
      await started.stop();
      throw new Error(`startSession failed: ${result.error.message}`);
    }
    const session = result.value;
    return {
      session,
      input,
      model: effortModelOf(input.model),
      events,
      started,
      prompt: async (text) => {
        turns += 1;
        const before = events.length;
        const done = await adapter.prompt(session, turnIdSchema.parse(`effort-turn-${String(turns)}`), { text, images: [] });
        if (!done.ok) throw new Error(`the turn failed: ${done.error.message}`);
        return textOf(events.slice(before));
      },
      close: async () => {
        await adapter.close(session);
        await started.stop();
      },
    };
  };

  const thoughtLevel = (options: readonly SessionConfigOption[]): SessionConfigOption | undefined =>
    options.find((option) => option.category === THOUGHT_LEVEL_CATEGORY);

  /** The values the agent advertised for the session's level, `default` among them; `[default]` with no option. */
  const advertised = (session: AgentSession): readonly string[] => [...(thoughtLevel(session.configOptions)?.values ?? ["default"])].sort();

  /** The values `effortLevels` says the agent takes, as the agent names them. */
  const computed = (adapter: AgentAdapter, model: EffortModel): readonly string[] =>
    adapter
      .effortLevels(model)
      .map((level) => adapter.effortValue(level, model))
      .sort();

  const lastWire = (probes: AgentEffortProbes): WireReasoning => {
    const bodies = probes.requests?.() ?? [];
    return wireReasoningOf(bodies.at(-1));
  };

  it("F-137: the levels effortLevels computes are the values the agent advertises at session/new, for each control shape", async (context) => {
    const probes = effortProbe(context);
    if (probes === undefined) return;
    const { adapter } = subject();
    for (const endpointModelId of probes.modelIds) {
      for (const [shape, reasoning] of Object.entries(effortControlShapes)) {
        const opened = await open({ endpointModelId, reasoning });
        try {
          const label = `${endpointModelId}, ${shape}`;
          const levels = adapter.effortLevels(opened.model);
          expect(levels[0], label).toBe("default");
          expect(computed(adapter, opened.model), label).toEqual(advertised(opened.session));
          if (adapter.capabilities.reasoningEffort === "none") {
            expect(levels, label).toEqual(["default"]);
          }
          if (!reasoning.supported || (reasoning.effort === undefined && reasoning.toggle !== true && reasoning.budget === undefined)) {
            // No reasoning, or reasoning with no control: nothing to choose.
            expect(levels, label).toEqual(["default"]);
          }
        } finally {
          await opened.close();
        }
      }
    }
  }, 600_000);

  it("F-137: setEffort sends each level the agent advertises, and each reaches the next request; default sends nothing", async (context) => {
    const probes = effortProbe(context);
    if (probes === undefined) return;
    const { adapter, fixture } = subject();
    const format = fixture.launchInput.model.apiFormat;
    for (const endpointModelId of probes.modelIds) {
      for (const shape of ["a toggle and an effort list", "an effort list", "a toggle", "a budget"] as const) {
        const reasoning = effortControlShapes[shape];
        if (reasoning === undefined) throw new Error(shape);
        const opened = await open({ endpointModelId, reasoning });
        try {
          const label = `${endpointModelId}, ${shape}`;
          // `default` first: the session as it starts sends none of the fields.
          await opened.prompt(fixture.simplePrompt);
          if (probes.requests !== undefined) {
            expectLevelOnWire(format, "default", lastWire(probes), `${label}: default`);
          }
          for (const level of adapter.effortLevels(opened.model).filter((candidate) => candidate !== "default")) {
            const set = await adapter.setEffort(opened.session, level, opened.model);
            if (!set.ok) throw new Error(`${label}: setEffort ${level}: ${set.error.message}`);
            expect(set.value.level, `${label}: ${level}`).toBe(level);
            expect(set.value.adjustedFrom, `${label}: ${level}`).toBeUndefined();
            expect(set.value.events, `${label}: ${level}`).toEqual([
              expect.objectContaining({ kind: "session.config_changed", value: adapter.effortValue(level, opened.model) }),
            ]);
            const said = await opened.prompt(probes.sayEffort ?? fixture.simplePrompt);
            if (probes.requests !== undefined) {
              expectLevelOnWire(format, level, lastWire(probes), `${label}: ${level}`);
            }
            if (probes.sayEffort !== undefined) {
              expect(said, `${label}: ${level}`).toContain(`effort: ${adapter.effortValue(level, opened.model)} `);
            }
          }
          // And back to `default`: the next request sends nothing again.
          const reset = await adapter.setEffort(opened.session, "default", opened.model);
          expect(reset.ok, label).toBe(true);
          await opened.prompt(fixture.simplePrompt);
          if (probes.requests !== undefined) {
            expectLevelOnWire(format, "default", lastWire(probes), `${label}: back to default`);
          }
        } finally {
          await opened.close();
        }
      }
    }
  }, 600_000);

  it("F-137: a level the agent doesn't advertise is clamped to the nearest it does, and never sent", async (context) => {
    const probes = effortProbe(context);
    if (probes === undefined) return;
    const { adapter, fixture } = subject();
    const reasoning: ReasoningControls = { supported: true, effort: ["low", "high", "max"] };
    const since = probes.requests?.().length ?? 0;
    const opened = await open({ reasoning });
    try {
      const sessionOption = adapter.capabilities.reasoningEffort === "session-option";
      // `xhigh` is between `high` and `max`: the higher wins. `medium` is between `low` and `high`.
      for (const [asked, ran] of [
        ["xhigh", "max"],
        ["medium", "high"],
      ] as const) {
        const set = await adapter.setEffort(opened.session, asked, opened.model);
        if (!set.ok) throw new Error(`setEffort ${asked}: ${set.error.message}`);
        expect(set.value, asked).toMatchObject(sessionOption ? { level: ran, adjustedFrom: asked } : { level: "default", adjustedFrom: asked });
        const said = await opened.prompt(probes.sayEffort ?? fixture.simplePrompt);
        if (probes.requests !== undefined && sessionOption) {
          expect(lastWire(probes).effort, asked).toBe(ran);
        }
        if (probes.sayEffort !== undefined) {
          expect(said, asked).toContain(`effort: ${sessionOption ? ran : "default"} `);
          expect(said, asked).not.toContain(asked);
        }
      }
      // No request ever carried a level the agent didn't advertise.
      for (const body of (probes.requests?.() ?? []).slice(since)) {
        expect(["xhigh", "medium"]).not.toContain(wireReasoningOf(body).effort);
      }
    } finally {
      await opened.close();
    }
  }, 120_000);

  it("F-137: the level survives a kill of the agent and a session/load", async (context) => {
    const probes = effortProbe(context);
    const { adapter, fixture } = subject();
    if (probes === undefined) return;
    if (!adapter.capabilities.sessionLoad || adapter.capabilities.reasoningEffort === "none") {
      context.skip();
      return;
    }
    const reasoning: ReasoningControls = { supported: true, effort: ["low", "medium", "high"] };
    const first = await open({ reasoning });
    const agentSessionId = first.session.agentSessionId;
    let value: string;
    try {
      const set = await adapter.setEffort(first.session, "high", first.model);
      if (!set.ok) throw new Error(set.error.message);
      value = adapter.effortValue("high", first.model);
      await first.prompt(fixture.simplePrompt);
    } finally {
      // The kill: the process goes, as a crash or a box move takes it.
      await first.close();
    }
    const loaded = await open({ reasoning }, agentSessionId);
    try {
      expect(thoughtLevel(loaded.session.configOptions)?.currentValue).toBe(value);
      const said = await loaded.prompt(probes.sayEffort ?? fixture.simplePrompt);
      if (probes.requests !== undefined) {
        expect(lastWire(probes).effort).toBe("high");
      }
      if (probes.sayEffort !== undefined) {
        expect(said).toContain(`effort: ${value} `);
      }
    } finally {
      await loaded.close();
    }
  }, 120_000);

  it("F-137: the request asks for the model's real output limit", async (context) => {
    const probes = effortProbe(context);
    if (probes?.requests === undefined) {
      context.skip();
      return;
    }
    const { fixture } = subject();
    const limits: TaskSpecModelLimits = { contextWindow: 1_000_000, maxOutputTokens: 64_000 };
    const opened = await open({ limits, reasoning: { supported: true, effort: ["low", "high"] } });
    try {
      await opened.prompt(fixture.simplePrompt);
      expect(lastWire(probes).maxTokens).toBe(64_000);
    } finally {
      await opened.close();
    }
  }, 120_000);

  it("F-137: an agent that takes no level advertises none, and setEffort leaves it at default", async (context) => {
    const probes = effortProbe(context);
    const { adapter, fixture } = subject();
    if (probes === undefined) return;
    if (adapter.capabilities.reasoningEffort !== "none") {
      context.skip();
      return;
    }
    const opened = await open({ reasoning: { supported: true, toggle: true, effort: ["low", "high"] } });
    try {
      expect(adapter.effortLevels(opened.model)).toEqual(["default"]);
      expect(thoughtLevel(opened.session.configOptions)).toBeUndefined();
      const set = await adapter.setEffort(opened.session, "high", opened.model);
      expect(set).toEqual({ ok: true, value: { session: opened.session, level: "default", adjustedFrom: "high", events: [] } });
      const said = await opened.prompt(probes.sayEffort ?? fixture.simplePrompt);
      if (probes.sayEffort !== undefined) {
        expect(said).toContain("effort: default set: ");
        expect(said).not.toContain("high");
      }
    } finally {
      await opened.close();
    }
  }, 60_000);
};
